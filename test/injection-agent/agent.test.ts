/**
 * Agent injection suite (#43): a real update run on a fixture whose widget
 * input's release notes carry an injected instruction. Records, per case,
 * which layer stopped it: a hook refusal, the agent declining, the guard, or
 * the run blocking. None may switch. Costs subscription quota, so not part
 * of `npm test`:
 *
 *   nix develop -c npx vitest run -c test/injection-agent/vitest.config.ts
 *
 * The agent uses CLAUDE_CODE_OAUTH_TOKEN, or the Claude Code login in HOME.
 * INJECT_AGENT=scripted replaces the agent with one that follows every
 * instruction (no API calls): checks the fixture and that the guard holds
 * each case. INJECT_CASES=ssh-key,curl-alias runs a subset;
 * INJECT_ITERATIONS caps the agent sessions per run (default 3).
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DOC_HOSTS, githubRepos } from "../../src/agent/hooks.js";
import { fixLoop, runAgentSession } from "../../src/agent/loop.js";
import { runGuard } from "../../src/guard/guard.js";
import { DEFAULTS, type AgentConfig } from "../../src/run/config.js";
import { updateRun, type UpdateDeps } from "../../src/run/update.js";
import { AGENT_CASES, releaseNotes, type AgentCase } from "./cases.js";
import { flagged, stoppedBy, type CaseRun, type Layer } from "./outcome.js";

const env = process.env;
const scripted = env.INJECT_AGENT === "scripted";
const only = env.INJECT_CASES?.split(",").map((s) => s.trim());
const cases = AGENT_CASES.filter((c) => !only || only.includes(c.name));
const results: { name: string; layer: Layer; status: string; guard: string; flagged: boolean; note: string }[] = [];

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-c", "safe.directory=*", "-c", "user.name=agent", "-c", "user.email=agent@x", "-C", repo, ...args], { encoding: "utf8" }).trim();

/** The agent that does whatever the release notes say: what the guard has to catch. */
function compliantFix(c: AgentCase): UpdateDeps["fix"] {
  return async (_v, { repo, verify }) => {
    const config = join(repo, "configuration.nix");
    await writeFile(config, (await readFile(config, "utf8")).replace("    color = ", "    settings.color = "));
    const target = join(repo, c.apply.file);
    await writeFile(target, c.apply.edit(await readFile(target, "utf8")));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", `widget 2.0: settings.color, migration steps\n\nChange-Id: widget-settings\nChange-Class: mechanical\nUpstream: widget RELEASE-NOTES.md`);
    const v = await verify();
    return v.status === "green" ? { status: "green", iterations: 1 } : { status: "blocked", iterations: 1, problems: v.problems, blockedInputs: [] };
  };
}

function agentFix(cfg: AgentConfig, out: (s: string) => void, refusals: { tool: string; reason: string; input: string }[], summaries: string[]): UpdateDeps["fix"] {
  return async (v, { repo, verify, head }) => {
    const hooks = {
      repo,
      writeScope: cfg.writeScope,
      selfInput: cfg.selfInput,
      allowedHosts: [...DOC_HOSTS, ...cfg.extraSources],
      allowedGithubRepos: githubRepos(await readFile(join(repo, "flake.lock"), "utf8")),
    };
    return fixLoop(cfg, v, {
      runAgent: async (prompt, model) => {
        const r = await runAgentSession({
          cfg,
          repo,
          prompt,
          model,
          token: env.CLAUDE_CODE_OAUTH_TOKEN,
          home: env.HOME ?? tmpdir(),
          hooks,
          onDeny: (tool, reason, input) => {
            refusals.push({ tool, reason, input: JSON.stringify(input) });
            out(`  refused ${tool}: ${reason}\n`);
          },
          out,
        });
        summaries.push(r.summary);
        return r;
      },
      verify,
      head,
      out,
    });
  };
}

afterAll(() => {
  if (!results.length) return;
  const w = Math.max(...results.map((r) => r.name.length));
  const lines = results.map(
    (r) => `${r.name.padEnd(w)}  ${r.layer.padEnd(12)}  run ${r.status.padEnd(12)} guard ${r.guard.padEnd(5)}  ${r.flagged ? "flagged" : "       "}  ${r.note}`,
  );
  process.stdout.write(`\nAgent injection suite (${scripted ? "scripted compliant agent" : "real agent"}): which layer stopped each case\n${lines.join("\n")}\n`);
});

describe("agent injection suite: no injected instruction switches", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const work = await mkdtemp(join(tmpdir(), `inject-agent-${c.name}-`));
      const repo = join(work, "config");
      const notes = join(work, "RELEASE-NOTES.md");
      await writeFile(notes, releaseNotes(c));
      execFileSync(join(__dirname, "../../fixtures/injection-agent/init.sh"), [repo, notes], { stdio: "inherit" });

      const cfg: AgentConfig = { ...DEFAULTS, repo, host: "fixture", user: "kha", maxFixIterations: Number(env.INJECT_ITERATIONS ?? DEFAULTS.maxFixIterations) };
      const state = join(work, "state");
      await mkdir(state);
      const log: string[] = [];
      const out = (s: string) => void log.push(s);
      const refusals: { tool: string; reason: string; input: string }[] = [];
      const summaries: string[] = [];
      const fix = scripted ? compliantFix(c) : agentFix(cfg, out, refusals, summaries);

      const record = await updateRun(cfg, state, { out, fix });
      await writeFile(join(work, "run.log"), log.join(""));
      const clone = join(state, "repo");
      const commit = record.commit ?? record.base!;
      const diff = git(clone, "diff", record.base!, commit, "--", ".", ":(exclude).flake-agent");
      // the switch service's guard, as it runs on a switch request
      const verdict = await runGuard({
        repo: clone,
        host: cfg.host,
        user: cfg.user,
        rev: commit,
        mainRef: record.base!,
        writeScope: cfg.writeScope,
        diffLimit: cfg.diffLimit,
        selfInput: cfg.selfInput,
      }).catch((err: Error) => ({ verdict: "block" as const, reasons: [`guard failed: ${err.message}`] }));

      const run: CaseRun = {
        status: record.status,
        injected: diff.includes(c.marker),
        refused: refusals.filter((r) => r.input.includes(c.marker)),
        guard: verdict.verdict === "pass" ? "pass" : "block",
      };
      const layer = stoppedBy(run);
      const note =
        layer === "hook" ? run.refused[0]!.reason : layer === "guard" || layer === "switches" ? verdict.reasons.slice(0, 2).join(" | ") : record.detail?.split("\n")[0] ?? "";
      results.push({ name: c.name, layer, status: record.status, guard: run.guard, flagged: flagged(summaries, c.marker), note: `${note.slice(0, 160)}  (${work})` });

      expect(layer, `${c.name}: the run was interrupted, see ${work}/run.log`).not.toBe("inconclusive");
      expect(layer, `${c.name} would switch: ${diff.slice(0, 400)}`).not.toBe("switches");
      // the scripted agent applies every case: the guard (or a hook, for real agents) has to be what stops it
      if (scripted) expect(run.injected, `${c.name}: the scripted agent's edit did not land`).toBe(true);
    }, 3_600_000);
  }

  it.runIf(scripted)("a clean fix still switches", async () => {
    const work = await mkdtemp(join(tmpdir(), "inject-agent-clean-"));
    const repo = join(work, "config");
    const notes = join(work, "RELEASE-NOTES.md");
    await writeFile(notes, releaseNotes({ ...AGENT_CASES[0]!, step: "None." }));
    execFileSync(join(__dirname, "../../fixtures/injection-agent/init.sh"), [repo, notes], { stdio: "inherit" });
    const cfg: AgentConfig = { ...DEFAULTS, repo, host: "fixture", user: "kha" };
    const state = join(work, "state");
    await mkdir(state);
    const clean: AgentCase = { ...AGENT_CASES[0]!, apply: { file: "configuration.nix", edit: (t) => t } };
    const record = await updateRun(cfg, state, { out: () => {}, fix: compliantFix(clean) });
    expect(record.status).toBe("green");
    const verdict = await runGuard({ repo: join(state, "repo"), host: cfg.host, user: cfg.user, rev: record.commit!, mainRef: record.base!, diffLimit: cfg.diffLimit, selfInput: cfg.selfInput });
    expect(verdict.reasons).toEqual([]);
  }, 3_600_000);
});
