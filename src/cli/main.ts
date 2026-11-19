#!/usr/bin/env node
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { configAttr, discoverPackages, type Target } from "../discovery/discover.js";
import { formatProbeRun, nvdDiff, probeAll, probeFailures } from "../probes/all.js";
import { run } from "../nix/exec.js";
import { runGuard, type GuardOptions } from "../guard/guard.js";
import { runCycle, skip, status } from "../preflight/cycle.js";
import { preflight, realPreflight } from "../preflight/preflight.js";
import { StateStore, defaultStateDir } from "../preflight/state.js";
import { loadConfig } from "../run/config.js";
import { updateRun } from "../run/update.js";
import { SYSTEM_PROFILE, collectGarbage, listGenerations } from "../switch/generations.js";
import { decideMode, realDeps, switchService } from "../switch/switch.js";

const HELP = `Usage: flake-agent <command> [options]

Commands:
  probe       Snapshot the live system and a fresh build, diff them
  discover    List packages the host config declares (JSON)
  guard <rev> Compare guarded options of <rev> with where it left main; exit 1 = block
  run         Preflight (credential, subscription, AC, disk, lock), then one update cycle
  retry       After a failed preflight: preflight again, then run
  skip        Dismiss a failed run; wait for the next cycle
  status      Preflight state and pending choice
  switch      (root) Guard, build and switch/boot the commit the agent requested
  activate <toplevel>  (root) Set the system profile to <toplevel> and switch or boot
  gc          (root) nix-collect-garbage that keeps the newest --keep-system generations

Options:
  --repo <path>     Config repo (default: current directory)
  --host <name>     nixosConfigurations attribute (default: hostname)
  --user <name>     User to probe (default: current user)
  --against <path>  Old system toplevel (default: /run/current-system)
  --build <path>    Use this toplevel instead of building the repo
  --main <ref>      Branch the agent branched from (guard; default: main)
  --allow/--deny <glob>  Write-scope overrides (guard; repeatable)
  --diff-limit <n>  Max changed lines (guard; default: 60)
  --self-input <name>  flake-updater input name (guard; default: flake-updater)
  --state-dir <dir> State (default: $STATE_DIRECTORY or ~/.local/state/flake-agent)
  --token-file <f>  Subscription token (else $CREDENTIALS_DIRECTORY/claude-token, $CLAUDE_CODE_OAUTH_TOKEN)
  --model <id>      Model for the run (default: claude-sonnet-5-5)
  --min-free-gb <n> Free space needed on /nix (default: 10)
  --config <file>   Agent config (JSON, written by the NixOS module)
  --no-preflight    Skip preflight (testing the AI-free run only)
  --dry-run         switch: guard, build and decide, but don't apply
  --delete-older-than <n>d  gc: like nix-collect-garbage
  --keep-system <n> gc: system generations always kept (default: 5)
  -h, --help        Show this help

Custom T2 validators: <repo>/.flake-agent/probes/<program>.sh, run when
programs.<program>.enable is set (exit non-zero = error, stderr = messages).
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      host: { type: "string" },
      user: { type: "string" },
      against: { type: "string" },
      build: { type: "string" },
      main: { type: "string" },
      allow: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      "diff-limit": { type: "string" },
      "self-input": { type: "string" },
      "state-dir": { type: "string" },
      "token-file": { type: "string" },
      model: { type: "string" },
      "min-free-gb": { type: "string" },
      config: { type: "string" },
      "no-preflight": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "switch-state-dir": { type: "string" },
      "delete-older-than": { type: "string" },
      "keep-system": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }

  const repo = resolve(values.repo ?? process.cwd());
  const target: Target = {
    flake: repo,
    host: values.host ?? hostname(),
    user: values.user ?? userInfo().username,
  };

  switch (command) {
    case "discover":
      process.stdout.write(JSON.stringify(await discoverPackages(target), null, 2) + "\n");
      return 0;
    case "probe":
      return probe(repo, target, values.against ?? "/run/current-system", values.build);
    case "guard":
      if (!positionals[1]) {
        process.stderr.write("guard: missing <rev>\n");
        return 2;
      }
      return guard({
        repo,
        host: target.host,
        user: target.user,
        rev: positionals[1],
        mainRef: values.main,
        writeScope: { allow: values.allow ?? [], deny: values.deny ?? [] },
        diffLimit: values["diff-limit"] ? Number(values["diff-limit"]) : undefined,
        selfInput: values["self-input"],
      });
    case "switch": {
      const cfg = await loadConfig(values.config, { host: values.host, user: values.user });
      const agentState = values["state-dir"] ?? "/var/lib/flake-agent";
      const switchState = values["switch-state-dir"] ?? defaultStateDir().replace(/flake-agent$/, "flake-agent-switch");
      const out = (text: string) => process.stdout.write(text);
      const record = await switchService(cfg, agentState, switchState, realDeps(cfg, out), { dryRun: values["dry-run"] });
      return !record || record.result === "switched" || record.result === "dry-run" ? 0 : 1;
    }
    case "activate": {
      const toplevel = positionals[1];
      if (!toplevel) {
        process.stderr.write("activate: missing <toplevel>\n");
        return 2;
      }
      const out = (text: string) => process.stdout.write(text);
      const deps = realDeps({} as never, out);
      const mode = await decideMode(deps.current, toplevel);
      const from = (await listGenerations(SYSTEM_PROFILE)).current;
      const applied = await deps.apply(toplevel, mode);
      const to = (await listGenerations(SYSTEM_PROFILE)).current;
      out(`${applied.ok ? mode : `${mode} failed, rolled back`}: generation ${from ?? "none"} → ${to}\n`);
      return applied.ok ? 0 : 1;
    }
    case "gc":
      await collectGarbage({
        age: values["delete-older-than"],
        keepSystem: values["keep-system"] ? Number(values["keep-system"]) : 5,
        out: (text) => process.stdout.write(text),
      });
      return 0;
    case "run":
    case "retry":
    case "skip":
    case "status": {
      const state = new StateStore(values["state-dir"] ?? defaultStateDir());
      const out = (text: string) => process.stdout.write(text);
      if (command === "skip") return skip(state, out);
      if (command === "status") return status(state, out);
      const cfg = await loadConfig(values.config, {
        repo: values.repo ? repo : undefined,
        host: values.host,
        user: values.user,
        model: values.model,
        minFreeGB: values["min-free-gb"] ? Number(values["min-free-gb"]) : undefined,
        against: values.against,
      });
      const checks = realPreflight({
        credentials: {
          credentialsDir: process.env.CREDENTIALS_DIRECTORY,
          tokenFile: values["token-file"],
          envToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        },
        model: cfg.model,
        executable: process.env.FLAKE_AGENT_CLAUDE,
        home: process.env.HOME,
        stateDir: state.dir,
        minFreeGB: cfg.minFreeGB,
      });
      const update = async () => {
        const record = await updateRun(cfg, state.dir, { out });
        await state.update((s) => ({ ...s, lastRun: record }));
        return record.status === "green" || record.status === "up-to-date" ? 0 : 1;
      };
      // --no-preflight: exercise the AI-free run without a subscription (testing only)
      if (values["no-preflight"]) return update();
      return runCycle({ state, preflight: () => preflight(checks), update, out });
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function probe(repo: string, target: Target, against: string, build?: string): Promise<number> {
  const toplevel =
    build ??
    (await run("nix", ["build", "--no-link", "--print-out-paths", configAttr(target, "config.system.build.toplevel")])).trim();
  const result = await probeAll(repo, target, against, toplevel);
  process.stdout.write(formatProbeRun(result));
  const nvd = await nvdDiff(against, toplevel);
  if (nvd) process.stdout.write(`\n${nvd}`);
  return probeFailures(result).length ? 1 : 0;
}

async function guard(opts: GuardOptions): Promise<number> {
  const result = await runGuard(opts);
  process.stdout.write(`base: ${result.base}
rev:  ${result.rev}

${result.verdict.toUpperCase()}
`);
  for (const reason of result.reasons) process.stdout.write(`  ${reason}
`);
  return result.verdict === "pass" ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`flake-agent: ${err.message}\n`);
    process.exit(2);
  },
);
