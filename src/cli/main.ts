#!/usr/bin/env node
import { hostname, userInfo } from "node:os";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { configAttr, discoverPackages, type Target } from "../discovery/discover.js";
import { formatProbeRun, nvdDiff, probeAll, probeFailures } from "../probes/all.js";
import { capture, run } from "../nix/exec.js";
import { runGuard, type GuardOptions } from "../guard/guard.js";
import { runCycle, skip, status } from "../preflight/cycle.js";
import { preflight, readToken, realPreflight } from "../preflight/preflight.js";
import { StateStore, defaultStateDir } from "../preflight/state.js";
import { loadConfig } from "../run/config.js";
import { superseded, updateRun, type UpdateDeps } from "../run/update.js";
import { DOC_HOSTS, githubRepos } from "../agent/hooks.js";
import { fixLoop, runAgentSession } from "../agent/loop.js";
import { captureKeepOld } from "../agent/keepold.js";
import { SYSTEM_PROFILE, collectGarbage, listGenerations } from "../switch/generations.js";
import { decideMode, realDeps, switchService } from "../switch/switch.js";
import { realRollbackDeps, rollbackService } from "../switch/rollback.js";
import { realHelperDeps, tick, type HelperState } from "../helper/helper.js";

const AGENT_STATE = "/var/lib/flake-agent";
const SWITCH_STATE = "/var/lib/flake-agent-switch";

/** Is the NixOS module enabled on this system? */
const isInstalled = () =>
  access("/etc/systemd/system/flake-agent.service").then(
    () => true,
    () => false,
  );

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
  helper      (user session) Idle time, notifications, post-switch check, handoff
  rollback    (root) Undo the agent's last live switch when the helper asks
  keep-old <id>  (agent) Save the working-tree diff as .flake-agent/changes/<id>/keep-old.patch

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
  --no-agent        Build and probe only, no fix loop
  --use-login       Agent uses the Claude Code login in $HOME, not a token (development)
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
      "no-agent": { type: "boolean" },
      "use-login": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "switch-state-dir": { type: "string" },
      "delete-older-than": { type: "string" },
      "keep-system": { type: "string" },
      once: { type: "boolean" },
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
      if (applied.error) out(`${applied.error}\n`);
      return applied.ok ? 0 : 1;
    }
    case "gc":
      await collectGarbage({
        age: values["delete-older-than"],
        keepSystem: values["keep-system"] ? Number(values["keep-system"]) : 5,
        out: (text) => process.stdout.write(text),
      });
      return 0;
    case "helper": {
      const cfg = await loadConfig(values.config, { host: values.host, user: values.user });
      const deps = realHelperDeps(cfg, {
        agentState: AGENT_STATE,
        switchState: SWITCH_STATE,
        helperState: join(defaultStateDir(), "helper.json"),
      });
      for (;;) {
        const background = await tick(deps);
        if (values.once) {
          await Promise.all(background);
          return 0;
        }
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
    case "keep-old": {
      // run by the agent in its clone, after editing the tree to the old behaviour
      if (!positionals[1]) {
        process.stderr.write("keep-old: missing <change-id>\n");
        return 2;
      }
      process.stdout.write(`Saved ${await captureKeepOld(process.cwd(), positionals[1])}; working tree restored\n`);
      return 0;
    }
    case "rollback":
      return (await rollbackService(SWITCH_STATE, realRollbackDeps((t) => process.stdout.write(t)))) ? 0 : 1;
    case "run":
    case "retry":
    case "skip":
    case "status": {
      const state = new StateStore(resolve(values["state-dir"] ?? defaultStateDir()));
      const out = (text: string) => process.stdout.write(text);
      // with the module installed, a user's retry/skip act on the system service
      if (!values["state-dir"] && process.getuid?.() !== 0 && (await isInstalled())) {
        if (command === "retry") {
          const r = await capture("systemctl", ["start", "--no-block", "flake-agent.service"], { env: process.env as Record<string, string> });
          out(r.code === 0 ? "Run started: flake-agent.service\n" : `Could not start flake-agent.service: ${r.stderr.trim()}\n`);
          return r.code === 0 ? 0 : 1;
        }
        if (command === "skip") {
          const pending = (await new StateStore(AGENT_STATE).load()).pending;
          const file = join(defaultStateDir(), "helper.json");
          const s = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as HelperState;
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify({ ...s, dismissedPending: pending?.since }, null, 2) + "\n");
          out(pending ? "Skipped: the next scheduled cycle runs as usual.\n" : "Nothing pending.\n");
          return 0;
        }
        if (command === "status") return status(new StateStore(AGENT_STATE), out);
      }
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
        const credentials = {
          credentialsDir: process.env.CREDENTIALS_DIRECTORY,
          tokenFile: values["token-file"],
          envToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        };
        const fix: UpdateDeps["fix"] = values["no-agent"]
          ? undefined
          : async (v, { repo, verify, head }) => {
              const token = values["use-login"] ? undefined : await readToken(credentials);
              if (!token && !values["use-login"]) return { status: "interrupted", iterations: 0, failure: { reason: "no-credential", message: "No subscription token" } };
              const hooks = {
                repo,
                writeScope: cfg.writeScope,
                selfInput: cfg.selfInput,
                allowedHosts: [...DOC_HOSTS, ...cfg.extraSources],
                allowedGithubRepos: githubRepos(await readFile(join(repo, "flake.lock"), "utf8")),
              };
              const prefs = await readFile(join(repo, ".flake-agent", "PREFERENCES.md"), "utf8").catch(() => undefined);
              return fixLoop(cfg, v, {
                runAgent: (prompt, model) =>
                  runAgentSession({
                    cfg,
                    repo,
                    prompt,
                    model,
                    token,
                    executable: process.env.FLAKE_AGENT_CLAUDE,
                    home: process.env.HOME ?? state.dir,
                    hooks,
                    onDeny: (tool, reason) => out(`  refused ${tool}: ${reason}\n`),
                    out,
                  }),
                verify,
                head,
                out,
              }, prefs);
            };
        const record = await updateRun(cfg, state.dir, { out, fix });
        await state.update((s) => {
          const old = superseded(s.lastRun, record);
          if (old) out(`main moved: ${old} superseded\n`);
          // the subscription stopped mid-run: same retry/next-cycle choice as a failed preflight
          const pending =
            record.status === "interrupted"
              ? { since: record.at, failure: { reason: "quota" as const, message: `Run interrupted: ${record.detail ?? "subscription unusable"}` } }
              : s.pending;
          return { ...s, lastRun: record, pending, superseded: old ? [...(s.superseded ?? []), { branch: old, at: record.at }] : s.superseded };
        });
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
