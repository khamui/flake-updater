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
  | { status: "blocked"; iterations: number; problems: string }
  /** Builds; the remaining probe findings are upstream's own changes, left as they are. */
  | { status: "upstream-only"; iterations: number; problems: string }
  | { status: "interrupted"; iterations: number; failure: PreflightFailure };

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
- Commit each logical change on its own: git add <files> && git commit -m "<message>". The message has a subject line, then a body saying what changed upstream, what you changed here, and which behaviours differ, then these trailers:
    Change-Id: <short-slug>-${month}
    Change-Class: mechanical
    Upstream: <link to the upstream change>
- This run handles mechanical changes only: renames and moves that keep behaviour identical. If a fix would change behaviour, do not commit it; describe it in your final answer instead.
- Some probe findings are upstream's own changes that no configuration change can or should restore (a package dropping or renaming a binary, a changed default). Leave those alone: no commit, and list them in your final answer under "Upstream-only:". If everything left is upstream-only, make no commit at all.
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
  for (let i = 1; i <= cfg.maxFixIterations; i++) {
    if (v.status === "green") return { status: "green", iterations: i - 1 };
    const model = modelFor(i, cfg);
    deps.out(`Fix iteration ${i}/${cfg.maxFixIterations} (${model})\n`);
    const before = await deps.head();
    const r = await deps.runAgent(prompt(v, i, preferences), model, i);
    if (r.quota) return { status: "interrupted", iterations: i, failure: r.quota };
    const committed = (await deps.head()) !== before;
    v = await deps.verify();
    // builds, and the agent found nothing to change: what is left is upstream's doing
    if (v.status === "probes-red" && !committed) return { status: "upstream-only", iterations: i, problems: v.problems };
  }
  return v.status === "green"
    ? { status: "green", iterations: cfg.maxFixIterations }
    : { status: "blocked", iterations: cfg.maxFixIterations, problems: v.problems };
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
