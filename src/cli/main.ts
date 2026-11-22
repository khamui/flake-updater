#!/usr/bin/env node
import { hostname, userInfo } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { configAttr, discoverPackages, type Target } from "../discovery/discover.js";
import { formatProbeRun, nvdDiff, probeAll, probeFailures, snapshotSystem } from "../probes/all.js";
import { capture, run } from "../nix/exec.js";
import { runGuard, type GuardOptions } from "../guard/guard.js";
import { nextCycle, nextRunLine, runCycle, skip, status } from "../preflight/cycle.js";
import { preflight, readToken, realPreflight } from "../preflight/preflight.js";
import { StateStore, defaultStateDir } from "../preflight/state.js";
import { loadConfig } from "../run/config.js";
import { requestPath, superseded, updateRun, type SwitchRequest, type UpdateDeps } from "../run/update.js";
import { DOC_HOSTS, githubRepos } from "../agent/hooks.js";
import { fixLoop, runAgentSession } from "../agent/loop.js";
import { captureKeepOld } from "../agent/keepold.js";
import { SYSTEM_PROFILE, collectGarbage, listGenerations } from "../switch/generations.js";
import { USER_REQUEST_DIR, decideMode, realDeps, switchService } from "../switch/switch.js";
import { prepareRevert } from "../revert/revert.js";
import { parseNotes, readRevertRequest, removedFeature, upstreamRevertRun, writeRevertRequest } from "../revert/upstream.js";
import { upstreamNotesPath } from "../report/upstream.js";
import { fileAt } from "../report/show.js";
import type { BuildDeps } from "../revert/sides.js";
import { PREFERENCES } from "../guard/structure.js";
import type { T3Snapshot } from "../probes/t3.js";
import { readLastSwitch, realRollbackDeps, rollbackService } from "../switch/rollback.js";
import { latestEvent } from "../report/report.js";
import { AGENT_STATE, SWITCH_STATE, isInstalled, panelMain } from "./panel.js";
import { showChange } from "../report/show.js";
import { realHelperDeps, tick, type HelperState } from "../helper/helper.js";

/** Build a tree's system and snapshot it (ADR 0002: `show` and `revert` build both sides now). */
function buildDeps(t: Target): BuildDeps {
  return {
    async build(dir) {
      const r = await capture("nix", ["build", "--no-link", "--print-out-paths", configAttr({ ...t, flake: dir }, "config.system.build.toplevel")], {
        env: process.env as Record<string, string>,
        timeoutMs: 3 * 3600_000,
      });
      return r.code === 0 ? { ok: true, toplevel: r.stdout.trim().split("\n").at(-1) } : { ok: false, error: r.stderr.trim().split("\n").slice(-10).join("\n") };
    },
    async snapshot(dir, toplevel) {
      const files = await snapshotSystem(dir, { ...t, flake: dir }, toplevel);
      return JSON.parse(await readFile(files.find((f) => f.endsWith("t3.json"))!, "utf8")) as T3Snapshot;
    },
  };
}

/** The module's agent config, for the user's own commands (revert). */
const ETC_CONFIG = "/etc/flake-agent/config.json";
/** The user's own state: what the helper notified, dismissed and handed off. */
const HELPER_STATE = () => join(defaultStateDir(), "helper.json");
const readHelperState = async () => JSON.parse(await readFile(HELPER_STATE(), "utf8").catch(() => "{}")) as HelperState;

const HELP = `Usage: flake-agent <command> [options]

Commands:
  probe       Snapshot the live system and a fresh build, diff them
  discover    List packages the host config declares (JSON)
  guard <rev> Compare guarded options of <rev> with where it left main; exit 1 = block
  run         Preflight (credential, subscription, AC, disk, lock), then one update cycle;
              the next scheduled one is intervalDays after it (--if-due: the hourly timer,
              runs only when due). Installed: starts the agent service
  retry       After a failed preflight: preflight again, then run
  skip        Dismiss a failed run; wait for the next cycle
  status      Last run and its changes, generation, next run, last switch, preflight, pending choice
              (--panel: one line for the XFCE Generic Monitor plugin: <4d, rnng, rvw, rlbk, bty)
  report      Show the latest report again (--once: only if not shown yet; the shell hook)
  show <id>   A change: upstream reason, affected keymaps/aliases, alternative, diff
  revert <id> Apply the change's keep-old.patch (or git revert it), build, probe, commit
              on agent/revert-<id> and hand it to the switch service; an upstream-<…> id
              asks the agent service to write the old behaviour (or keep an input back)
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
  --note <text>     revert: append <text> to PREFERENCES.md (else asked; --no-note: don't)
  --request-dir <d> revert: where the switch service looks (default: /run/flake-agent when installed)
  --user-request-dir <d>  switch: also serve users' revert requests from <d>
  --revert-request-dir <d>  run: handle a user's upstream revert request from <d> (default: /run/flake-agent when installed)
  -y, --yes         revert: confirm keeping an input back for a removed package
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
      note: { type: "string" },
      "no-note": { type: "boolean" },
      "request-dir": { type: "string" },
      "user-request-dir": { type: "string" },
      "revert-request-dir": { type: "string" },
      yes: { type: "boolean", short: "y" },
      "if-due": { type: "boolean" },
      panel: { type: "boolean" },
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
      const agentState = resolve(values["state-dir"] ?? "/var/lib/flake-agent");
      const switchState = resolve(values["switch-state-dir"] ?? defaultStateDir().replace(/flake-agent$/, "flake-agent-switch"));
      const out = (text: string) => process.stdout.write(text);
      const record = await switchService(cfg, agentState, switchState, realDeps(cfg, out), {
        dryRun: values["dry-run"],
        userRequestDir: values["user-request-dir"] && resolve(values["user-request-dir"]),
      });
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
        helperState: HELPER_STATE(),
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
    case "report": {
      // installed: the services' state; else (development) --state-dir/--switch-state-dir
      const agentState = values["state-dir"] ?? AGENT_STATE;
      const switchState = values["switch-state-dir"] ?? SWITCH_STATE;
      const helper = await readHelperState();
      const state = await new StateStore(agentState).load();
      if (state.pending?.since === helper.dismissedPending) delete state.pending;
      const rec = await readLastSwitch(switchState);
      const event = latestEvent(state, rec, rec && helper.handoff?.commit === rec.commit ? helper.handoff.note : undefined);
      const seenFile = join(defaultStateDir(), "report-seen");
      // every key shown, newest last: dismissing a newer event must not bring an older report back
      const seen = (await readFile(seenFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
      if (!event) {
        if (!values.once) process.stdout.write("Nothing to report yet.\n");
      } else if (!values.once || !seen.includes(event.key)) {
        process.stdout.write(event.text);
      }
      // the shell hook compares the marker's mtime with the state files: touch it either way
      const keys = event && !seen.includes(event.key) ? [...seen, event.key] : seen;
      await mkdir(dirname(seenFile), { recursive: true }).catch(() => undefined);
      await writeFile(seenFile, keys.slice(-50).map((k) => `${k}\n`).join("")).catch(() => undefined);
      return 0;
    }
    case "show": {
      const id = positionals[1];
      if (!id) {
        process.stderr.write("show: missing <change-id>\n");
        return 2;
      }
      // installed: the agent's clone holds every run's branch
      const from = values.repo ? repo : (await isInstalled()) ? join(AGENT_STATE, "repo") : repo;
      process.stderr.write("Building the change's branch with and without it…\n");
      const text = await showChange(from, id, target.host, buildDeps(target));
      if (!text) {
        process.stderr.write(`show: no change ${id} in ${from}\n`);
        return 1;
      }
      process.stdout.write(text);
      return 0;
    }
    case "revert": {
      const id = positionals[1];
      if (!id) {
        process.stderr.write("revert: missing <change-id>\n");
        return 2;
      }
      const installed = await isInstalled();
      const file = values.config ?? (installed ? ETC_CONFIG : undefined);
      // installed: the user's repo and host from the module; else this repo
      const cfg = await loadConfig(file, file ? { repo: values.repo ? repo : undefined, host: values.host, user: values.user } : { repo, host: target.host, user: target.user });
      const out = (text: string) => process.stdout.write(text);
      const t = { flake: cfg.repo, host: cfg.host, user: cfg.user };
      if (id.startsWith("upstream-")) {
        // no commit of this config caused it: the agent service prepares the way back
        const notes = parseNotes(id, (await fileAt(cfg.repo, cfg.mainBranch, upstreamNotesPath(id))) ?? "");
        if (!notes) {
          process.stderr.write(`revert: no upstream-only change ${id} on ${cfg.mainBranch}\n`);
          return 1;
        }
        let pin = false;
        if (removedFeature(notes.kind)) {
          out(`${notes.finding}\nNothing in the configuration brings this back: only keeping an input at its previous revision does (${notes.inputs.join(", ") || "the run's inputs"}). The agent tries each and keeps the first that restores it (Change-Class: blocked).\n`);
          pin = Boolean(values.yes) || (process.stdin.isTTY && /^y(es)?$/i.test((await ask("Keep that input back? [y/N] ")).trim()));
          if (!pin) {
            out("Nothing requested.\n");
            return 0;
          }
        }
        const note = values["no-note"]
          ? undefined
          : values.note?.trim() ||
            (process.stdin.isTTY && /^y(es)?$/i.test((await ask(`Add to ${PREFERENCES}, so future runs keep this?\n  - ${id} (${notes.finding}): keep the old behaviour.\n[y/N] `)).trim())
              ? `${id} (${notes.finding}): keep the old behaviour; reverted ${new Date().toISOString().slice(0, 10)}.`
              : undefined);
        const dir = values["request-dir"] ?? (installed ? USER_REQUEST_DIR : undefined);
        if (!dir) {
          process.stderr.write("revert: an upstream-only change is reverted by the agent service; none here (--request-dir)\n");
          return 1;
        }
        await writeRevertRequest(dir, { id, at: new Date().toISOString(), ...(pin ? { pin } : {}), ...(note ? { note } : {}) });
        if (installed) {
          const started = await capture("systemctl", ["start", "--no-block", "flake-agent.service"]);
          if (started.code !== 0) out(`Could not start flake-agent.service (${started.stderr.trim()}); the next scheduled run picks it up.\n`);
        }
        out(`Asked the agent for agent/revert-${id}: it ${pin ? "keeps an input back" : "writes the old behaviour"}, builds and probes it, then hands it to the switch service. flake-agent report shows the outcome.\n`);
        return 0;
      }
      const result = await prepareRevert(
        {
          repo: cfg.repo,
          mainBranch: cfg.mainBranch,
          host: cfg.host,
          id,
          note: async (subject) => {
            if (values["no-note"]) return undefined;
            if (values.note) return `- ${values.note.trim()}`;
            const text = `- ${id} (${subject}): keep the old behaviour; reverted ${new Date().toISOString().slice(0, 10)}.`;
            if (!process.stdin.isTTY) return undefined;
            const answer = await ask(`Add to ${PREFERENCES}, so future runs keep this?\n  ${text}\n[y/N] `);
            return /^y(es)?$/i.test(answer.trim()) ? text : undefined;
          },
        },
        { out, ...buildDeps(t) },
      );
      out(`${result.method === "keep-old" ? "Applied keep-old.patch" : "Reverted the change's commits"} on ${result.branch} (${result.commit.slice(0, 12)})\n`);
      const finding = (f: { kind: string; subject: string; detail?: string }) => `${f.kind} ${f.subject}${f.detail ? `: ${f.detail}` : ""}`;
      if (result.restored.length) out(`Probes: restored\n${result.restored.map((f) => `  ✓ ${finding(f)}\n`).join("")}`);
      if (result.effect.length) out(`Probes: changed by the revert\n${result.effect.map((f) => `  ↩ ${finding(f)}\n`).join("")}`);
      if (result.caveat) out(`${result.caveat}\n`);
      if (result.noted) out(`Noted in ${PREFERENCES}\n`);

      // a dry run of the switch service's guard: say now if it will hold the revert for review
      const verdict = await runGuard({
        repo: cfg.repo,
        host: cfg.host,
        user: cfg.user,
        rev: result.commit,
        mainRef: cfg.mainBranch,
        writeScope: { ...cfg.writeScope, allow: [...(cfg.writeScope.allow ?? []), PREFERENCES] },
        diffLimit: cfg.diffLimit,
        selfInput: cfg.selfInput,
      }).catch((err: Error) => ({ verdict: "block" as const, reasons: [`guard failed: ${err.message}`] }));
      if (verdict.verdict !== "pass") out(`The guard will hold it for review:\n${verdict.reasons.map((r) => `  ⛔ ${r}\n`).join("")}`);

      const dir = values["request-dir"] ?? (installed ? USER_REQUEST_DIR : undefined);
      if (!dir) {
        out("No switch service here (--request-dir): merge the branch and switch by hand.\n");
        return 0;
      }
      const req: SwitchRequest = { commit: result.commit, branch: result.branch, at: new Date().toISOString(), base: result.base };
      await writeFile(requestPath(dir), JSON.stringify(req) + "\n");
      out("Handed to the switch service: it switches now (or sets the boot entry); flake-agent report shows the outcome.\n");
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
        // the service itself runs `run --config`: only the user's plain `run` starts it
        if (command === "retry" || (command === "run" && !values.config)) {
          const r = await capture("systemctl", ["start", "--no-block", "flake-agent.service"], { env: process.env as Record<string, string> });
          out(r.code === 0 ? "Run started: flake-agent.service\n" : `Could not start flake-agent.service: ${r.stderr.trim()}\n`);
          return r.code === 0 ? 0 : 1;
        }
        if (command === "skip") {
          const pending = (await new StateStore(AGENT_STATE).load()).pending;
          const file = HELPER_STATE();
          const s = await readHelperState();
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify({ ...s, dismissedPending: pending?.since }, null, 2) + "\n");
          out(pending ? "Skipped: the next scheduled cycle runs as usual.\n" : "Nothing pending.\n");
          return 0;
        }
        if (command === "status") {
          if (values.panel) return panelMain(argv, out);
          return status(new StateStore(AGENT_STATE), out, {
            generation: (await listGenerations(SYSTEM_PROFILE)).current,
            lastSwitch: await readLastSwitch(SWITCH_STATE),
            dismissedPending: (await readHelperState()).dismissedPending,
          });
        }
      }
      if (command === "skip") return skip(state, out);
      if (command === "status") {
        if (values.panel) return panelMain(argv, out);
        return status(state, out, values["switch-state-dir"] ? { lastSwitch: await readLastSwitch(values["switch-state-dir"]) } : {});
      }
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
        // the user's request only: never one in the agent's own state dir, which the agent could write
        const revertDir = values["revert-request-dir"] ?? ((await isInstalled()) ? USER_REQUEST_DIR : undefined);
        const request = revertDir ? await readRevertRequest(revertDir) : undefined;
        if (request && !((await state.load()).handledReverts ?? []).includes(request.at)) {
          const token = values["use-login"] || values["no-agent"] ? undefined : await readToken(credentials);
          const t = { host: cfg.host, user: cfg.user };
          const tree = (dir: string) => ({ ...t, flake: dir });
          const record = await upstreamRevertRun(cfg, state.dir, request, t, {
            out,
            async build(dir) {
              const r = await capture("nix", ["build", "--no-link", "--print-out-paths", configAttr(tree(dir), "config.system.build.toplevel")], {
                env: process.env as Record<string, string>,
                timeoutMs: 50 * 60_000,
              });
              return r.code === 0 ? { ok: true, toplevel: r.stdout.trim().split("\n").at(-1) } : { ok: false, error: r.stderr };
            },
            probe: (dir, against, toplevel, snapshots) => probeAll(dir, tree(dir), against, toplevel, snapshots),
            snapshot: async (dir, toplevel) => void (await snapshotSystem(dir, tree(dir), toplevel)),
            pin: async (dir, input, ref) => void (await run("nix", ["flake", "lock", dir, "--override-input", input, ref])),
            ...(values["no-agent"] || (!token && !values["use-login"])
              ? {}
              : {
                  runAgent: async (prompt: string, model: string, system: string) => {
                    const repo = join(state.dir, "repo");
                    return runAgentSession({
                      cfg,
                      repo,
                      prompt,
                      model,
                      system,
                      token,
                      executable: process.env.FLAKE_AGENT_CLAUDE,
                      home: process.env.HOME ?? state.dir,
                      hooks: {
                        repo,
                        writeScope: cfg.writeScope,
                        selfInput: cfg.selfInput,
                        allowedHosts: [...DOC_HOSTS, ...cfg.extraSources],
                        allowedGithubRepos: githubRepos(await readFile(join(repo, "flake.lock"), "utf8")),
                      },
                      onDeny: (tool, reason) => out(`  refused ${tool}: ${reason}\n`),
                      out,
                    });
                  },
                }),
          });
          await state.update((s) => ({ ...s, lastRevert: record, handledReverts: [...(s.handledReverts ?? []), request.at].slice(-20) }));
          return record.status === "switch-requested" ? 0 : 1;
        }
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
      if (values["if-due"]) {
        // the hourly timer: a run is due intervalDays after the last cycle, however that one started
        const now = new Date();
        const s = await state.load();
        const next = nextCycle(s, cfg.intervalDays);
        if (next && next > now) {
          if (s.nextCycle !== next.toISOString()) await state.update((x) => ({ ...x, nextCycle: next.toISOString() }));
          out(`Not due: ${nextRunLine({ nextCycle: next.toISOString() }, now).replace(/^Next run: /, "next run ")}\n`);
          return 0;
        }
      }
      if (values["no-preflight"]) return update();
      return runCycle({ state, preflight: () => preflight(checks), update, out, intervalDays: cfg.intervalDays });
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
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
