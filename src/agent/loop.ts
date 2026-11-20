import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { classifyPing, type PreflightFailure } from "../preflight/subscription.js";
import type { AgentConfig } from "../run/config.js";
import { preToolUseHooks, type HookContext } from "./hooks.js";

/** The state of the branch after a build + probe pass. */
export interface Verification {
  status: "green" | "build-failed" | "probes-red";
  /** What is wrong, for the agent: build error tail or failing probe findings. */
  problems: string;
}

export interface FixDeps {
  /** One agent session; returns a failure only when the subscription became unusable. */
  runAgent: (prompt: string, model: string, iteration: number) => Promise<{ quota?: PreflightFailure; summary: string }>;
  /** Discard uncommitted edits, build HEAD, run probes, commit new snapshots. */
  verify: () => Promise<Verification>;
  /** Current commit, to tell whether the agent committed anything. */
  head: () => Promise<string>;
  out: (text: string) => void;
}

export type FixOutcome =
  | { status: "green"; iterations: number }
  /** `blockedInputs`: what the agent named as broken upstream ("Blocked input: <name> — …"). */
  | { status: "blocked"; iterations: number; problems: string; blockedInputs: string[] }
  /** Builds; the remaining probe findings are upstream's own changes, left as they are. */
  | { status: "upstream-only"; iterations: number; problems: string }
  | { status: "interrupted"; iterations: number; failure: PreflightFailure };

/** Inputs the agent's final answer names as broken upstream. */
export function blockedInputs(summary: string): string[] {
  return [...summary.matchAll(/^\W*Blocked input:\W*([A-Za-z0-9_-]+)/gim)].map((m) => m[1]!);
}

/** Which model iteration `i` (1-based) uses: the escalation model on the last one. */
export function modelFor(i: number, cfg: Pick<AgentConfig, "model" | "escalationModel" | "maxFixIterations">): string {
  return i >= cfg.maxFixIterations ? cfg.escalationModel : cfg.model;
}

export function rules(cfg: Pick<AgentConfig, "host" | "selfInput">, repo: string, month: string): string {
  return `You maintain a NixOS flake configuration after \`nix flake update\`. The new lock is already committed on this branch. Your job: make the configuration build and behave as before, adopting the new idiomatic way upstream intends.

Rules:
- Work only inside ${repo}. Never edit flake.lock, the inputs block of flake.nix, any hardware-configuration.nix, .flake-agent/PREFERENCES.md, or a services.flake-agent block. Hooks refuse such edits.
- Read .flake-agent/PREFERENCES.md first if it exists, and follow it.
- Verify with: nix build .#nixosConfigurations.${cfg.host}.config.system.build.toplevel --no-link
- Find out why upstream changed (release notes, changelogs, commits, issues) with WebFetch: the NixOS and home-manager manuals, and the GitHub repositories of this flake's inputs. Nothing else is reachable.
- Commit each logical change on its own: git add <files> && git commit -F - <<'EOF' … EOF (a quoted here-document; redirections, command substitution and files outside the repository are refused). The message has a subject line, then a body saying what changed upstream, what you changed here, and which behaviours differ, then these trailers:
    Change-Id: <short-slug>-${month}
    Change-Class: <mechanical|behaviour|review>
    Upstream: <link to the upstream change>
- Classify each change:
  - One commit per upstream change: two removed or renamed options are two commits, even in the same file.
  - mechanical: a rename or move that keeps behaviour identical.
  - A removed option or module replaced by a different one (a preset, a new module, another package) is behaviour unless you compared the replacement's defaults with the old ones (filetypes, root detection, settings, enabled features) and they match; say in the commit body what you compared.
  - behaviour: upstream removed or changed something and the new way behaves differently. Adopt the new way (or remove the feature if there is no replacement) in one commit. Then prepare the way back: edit the tree to the closest old-behaviour version on top of that commit, verify it builds, run \`flake-agent keep-old <change-id>\` (it saves .flake-agent/changes/<change-id>/keep-old.patch and restores the tree), write .flake-agent/changes/<change-id>/notes.md (what changed upstream, what differs for the user, what the patch restores), and commit both with the same trailers.
  - review: anything touching hashes (outputHash, vendorHash, npmDepsHash, pnpmDeps …), overlays, fetchers or overrides. Commit it; a human reviews it before it is switched.
- An override or workaround that is no longer needed: propose removing it as its own commit (Change-Class: review).
- An input that is broken upstream in a way the configuration cannot work around: do not remove the feature to hide it. Make no commit for it and say in your final answer: "Blocked input: <name> — <reason>". The run then keeps that input at its previous revision.
- Some probe findings are upstream's own changes that no configuration change can or should restore (a package dropping or renaming a binary, a changed default). Leave those alone: no commit, and list them in your final answer under "Upstream-only:". Never commit a change that only restates the new default (e.g. setting an option to the value it now defaults to); that is upstream-only too. If everything left is upstream-only, make no commit at all.
- Never update ${cfg.selfInput}, never push, never touch other branches.
- Finish with a short summary of what you changed and why.`;
}

export function prompt(v: Verification, iteration: number, preferences: string | undefined): string {
  return [
    `Iteration ${iteration}. After the lock update the configuration is ${v.status === "build-failed" ? "failing to build" : "building, but probes report regressions"}:`,
    "",
    v.problems.trim(),
    "",
    preferences ? `.flake-agent/PREFERENCES.md:\n${preferences.trim()}\n` : "",
    "Fix it, verify the build, and commit each change as described.",
  ].join("\n");
}

/**
 * Update → fix → probe, at most `maxFixIterations` agent sessions; the last
 * uses the escalation model. Still red afterwards → blocked (no switch).
 */
export async function fixLoop(
  cfg: AgentConfig,
  initial: Verification,
  deps: FixDeps,
  preferences?: string,
): Promise<FixOutcome> {
  let v = initial;
  const named = new Set<string>();
  for (let i = 1; i <= cfg.maxFixIterations; i++) {
    if (v.status === "green") return { status: "green", iterations: i - 1 };
    const model = modelFor(i, cfg);
    deps.out(`Fix iteration ${i}/${cfg.maxFixIterations} (${model})\n`);
    const before = await deps.head();
    const r = await deps.runAgent(prompt(v, i, preferences), model, i);
    if (r.quota) return { status: "interrupted", iterations: i, failure: r.quota };
    if (r.summary.trim()) deps.out(`${r.summary.trim().replace(/^/gm, "  | ")}\n`);
    for (const input of blockedInputs(r.summary)) named.add(input);
    const committed = (await deps.head()) !== before;
    v = await deps.verify();
    // builds, and the agent found nothing to change: what is left is upstream's doing
    if (v.status === "probes-red" && !committed) return { status: "upstream-only", iterations: i, problems: v.problems };
    // broken upstream: more sessions can't help; the run pins the input, then the agent gets another pass
    if (v.status === "build-failed" && named.size) return { status: "blocked", iterations: i, problems: v.problems, blockedInputs: [...named] };
  }
  return v.status === "green"
    ? { status: "green", iterations: cfg.maxFixIterations }
    : { status: "blocked", iterations: cfg.maxFixIterations, problems: v.problems, blockedInputs: [...named] };
}

export const AGENT_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch"];

/** One SDK session in the clone, with the hooks enforcing scope; maps quota/auth loss. */
export async function runAgentSession(opts: {
  cfg: AgentConfig;
  repo: string;
  prompt: string;
  model: string;
  /** Subscription token; absent = the Claude Code login found in HOME (development). */
  token?: string;
  executable?: string;
  home: string;
  hooks: HookContext;
  onDeny?: (tool: string, reason: string) => void;
  out: (text: string) => void;
}): Promise<{ quota?: PreflightFailure; summary: string }> {
  const month = new Date().toISOString().slice(0, 7);
  const options: Options = {
    cwd: opts.repo,
    model: opts.model,
    maxTurns: 80,
    tools: AGENT_TOOLS,
    allowedTools: AGENT_TOOLS,
    disallowedTools: ["WebSearch"],
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    systemPrompt: { type: "preset", preset: "claude_code", append: rules(opts.cfg, opts.repo, month) },
    hooks: { PreToolUse: preToolUseHooks(opts.hooks, opts.onDeny) },
    env: {
      PATH: process.env.PATH ?? "",
      HOME: opts.home,
      NIX_REMOTE: process.env.NIX_REMOTE ?? "",
      ...(opts.token ? { CLAUDE_CODE_OAUTH_TOKEN: opts.token } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: "flake-agent/fix",
    },
    ...(opts.executable ? { pathToClaudeCodeExecutable: opts.executable } : {}),
  };

  const messages: SDKMessage[] = [];
  let thrown: unknown;
  try {
    for await (const m of query({ prompt: opts.prompt, options })) {
      messages.push(m);
      if (m.type === "assistant") {
        for (const b of m.message.content) {
          if (b.type === "tool_use") opts.out(`  ${b.name} ${JSON.stringify(b.input).slice(0, 140)}\n`);
        }
      }
    }
  } catch (err) {
    thrown = err;
  }
  const failure = classifyPing(messages, thrown);
  const result = messages.find((m): m is Extract<SDKMessage, { type: "result" }> => m.type === "result");
  const summary = result && "result" in result ? String(result.result ?? "") : "";
  // the subscription stopped working mid-run: stop, the branch is interrupted
  if (failure && ["auth", "subscription", "quota"].includes(failure.reason)) return { quota: failure, summary };
  return { summary };
}
