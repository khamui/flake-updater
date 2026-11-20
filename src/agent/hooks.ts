import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { writeScopeViolations, type WriteScope } from "../guard/structure.js";

/** A hook's decision: null = allow, a string = deny with that reason. */
export type Decision = string | null;

export interface HookContext {
  /** The agent's clone: the only tree it may edit. */
  repo: string;
  writeScope: Partial<WriteScope>;
  selfInput: string;
  /** Hosts and GitHub repos (`owner/repo`) WebFetch may reach. */
  allowedHosts: string[];
  allowedGithubRepos: string[];
}

// ── write scope ─────────────────────────────────────────────────────────────

async function current(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The file a write/edit tool call targets and its content after the call. */
export async function proposedChange(tool: string, input: Record<string, unknown>): Promise<{ path: string; before: string | null; after: string | null } | undefined> {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  if (!path) return undefined;
  const before = await current(path);
  switch (tool) {
    case "Write":
      return { path, before, after: String(input.content ?? "") };
    case "Edit": {
      const old = String(input.old_string ?? "");
      const next = String(input.new_string ?? "");
      const after = before === null ? next : input.replace_all ? before.split(old).join(next) : before.replace(old, next);
      return { path, before, after };
    }
    case "NotebookEdit":
      return { path, before, after: null };
    default:
      return undefined;
  }
}

export async function checkWrite(tool: string, input: Record<string, unknown>, ctx: HookContext): Promise<Decision> {
  const change = await proposedChange(tool, input);
  if (!change) return `${tool}: no file path`;
  if (tool === "NotebookEdit") return "notebooks are not part of a NixOS config";
  const abs = resolve(ctx.repo, change.path);
  const rel = relative(ctx.repo, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return `${change.path} is outside the repository`;
  if (rel === ".git" || rel.startsWith(".git/")) return "the git directory is not editable";
  const reasons = writeScopeViolations([{ path: rel, before: change.before, after: change.after }], ctx.writeScope, "hook");
  return reasons.length ? reasons.join("; ") : null;
}

// ── Bash ────────────────────────────────────────────────────────────────────

/** Read-only helpers the agent may use freely. */
const READ_ONLY = new Set(["cat", "ls", "head", "tail", "wc", "grep", "rg", "find", "diff", "sort", "uniq", "echo", "pwd", "tree", "jq", "true"]);
const GIT_ALLOWED = new Set(["status", "diff", "log", "show", "add", "commit", "rm", "mv", "restore", "blame", "ls-files", "rev-parse", "grep"]);
const NIX_ALLOWED = new Set(["build", "eval", "flake", "log", "path-info", "why-depends", "search", "derivation"]);
const FLAKE_ALLOWED = new Set(["update", "metadata", "show", "check", "info"]);

/** Split a command line on `;`, `&&`, `||`, `|` and newlines (quotes respected). */
export function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') cur += command[++i] ?? "";
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === ";" || c === "\n" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      if (c === "&" || (c === "|" && command[i + 1] === "|")) i++;
      out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function words(segment: string): string[] {
  return (segment.match(/'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((w) => w.replace(/^['"]|['"]$/g, ""));
}

/** One simple command against the allowlist. */
export function checkSegment(segment: string, ctx: Pick<HookContext, "selfInput">): Decision {
  const w = words(segment).filter((x) => !/^[A-Z_][A-Z0-9_]*=/.test(x)); // leading VAR=value
  const [cmd, sub, sub2] = w;
  if (!cmd) return null;
  if (/[<>]/.test(segment.replace(/2>&1|>\s*\/dev\/null|2>\s*\/dev\/null/g, ""))) return "redirections are not allowed (use the Write/Edit tools)";
  if (cmd === "cd") return w.length <= 2 ? null : "cd: one argument";
  if (READ_ONLY.has(cmd)) {
    if (cmd === "find" && w.some((x) => ["-exec", "-execdir", "-delete", "-ok"].includes(x))) return "find with -exec/-delete is not allowed";
    return null;
  }
  if (cmd === "nvd" || cmd === "flake-agent") {
    return cmd === "flake-agent" && !["probe", "guard", "keep-old"].includes(sub ?? "") ? "flake-agent: only probe, guard and keep-old" : null;
  }
  if (cmd === "git") {
    if (!sub || !GIT_ALLOWED.has(sub)) return `git ${sub ?? ""}: not allowed (no push, reset, checkout, branch, rebase…)`;
    if (w.includes("--amend") || w.includes("--no-verify")) return "git commit --amend/--no-verify is not allowed";
    return null;
  }
  if (cmd === "nix") {
    if (!sub || !NIX_ALLOWED.has(sub)) return `nix ${sub ?? ""}: not allowed`;
    if (sub === "flake") {
      if (!sub2 || !FLAKE_ALLOWED.has(sub2)) return `nix flake ${sub2 ?? ""}: not allowed`;
      if (sub2 === "update") {
        const inputs = w.slice(3).filter((x) => !x.startsWith("-"));
        if (!inputs.length) return `nix flake update: name the inputs (never ${ctx.selfInput})`;
        if (inputs.includes(ctx.selfInput)) return `${ctx.selfInput} is only updated by hand`;
      }
    }
    if (w.some((x) => ["--impure", "--option", "--extra-substituters", "--substituters"].includes(x))) return "nix: --impure/--option/substituter flags are not allowed";
    return null;
  }
  return `${cmd}: not in the allowlist`;
}

/** Here-documents (`git commit -F - <<'EOF'`): the body is data, not commands. */
export function stripHeredocs(command: string): { command: string; bodies: string[] } {
  const bodies: string[] = [];
  const stripped = command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g, (_m, _q, _tag, rest: string, body: string) => {
    bodies.push(body);
    return rest;
  });
  return { command: stripped, bodies };
}

export function checkBash(command: string, ctx: Pick<HookContext, "selfInput">): Decision {
  const { command: cmd, bodies } = stripHeredocs(command);
  // an unquoted here-document still expands $(...) and backticks
  if (/\$\(|`|<\(/.test(cmd) || /<<-?\s*\w/.test(command) && bodies.some((b) => /\$\(|`/.test(b))) return "command substitution is not allowed";
  for (const seg of segments(cmd)) {
    const d = checkSegment(seg, ctx);
    if (d) return d;
  }
  return null;
}

// ── WebFetch ────────────────────────────────────────────────────────────────

export const DOC_HOSTS = ["nixos.org", "search.nixos.org", "wiki.nixos.org", "nix.dev", "nix-community.github.io", "home-manager-options.extranix.com"];

/** GitHub `owner/repo` of every github input in a flake.lock. */
export function githubRepos(lockText: string): string[] {
  const lock = JSON.parse(lockText) as { nodes: Record<string, { original?: { type?: string; owner?: string; repo?: string } }> };
  const out = new Set<string>();
  for (const node of Object.values(lock.nodes)) {
    const o = node.original;
    if (o?.type === "github" && o.owner && o.repo) out.add(`${o.owner}/${o.repo}`.toLowerCase());
  }
  return [...out].sort();
}

export function checkFetch(url: string, ctx: Pick<HookContext, "allowedHosts" | "allowedGithubRepos">): Decision {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "https only";
  const host = u.hostname.toLowerCase();
  if (ctx.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  const repoPath = (parts: string[]) => parts.slice(0, 2).join("/").toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const repo =
    host === "github.com" || host === "raw.githubusercontent.com"
      ? repoPath(parts)
      : host === "api.github.com" && parts[0] === "repos"
        ? repoPath(parts.slice(1))
        : undefined;
  if (repo && ctx.allowedGithubRepos.includes(repo)) return null;
  return `${host}${repo ? `/${repo}` : ""} is not an allowed source`;
}

// ── wiring ──────────────────────────────────────────────────────────────────

function deny(reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

const allow: HookJSONOutput = {};

/** PreToolUse hooks for the SDK; `onDeny` sees every refusal (for the report and tests). */
export function preToolUseHooks(ctx: HookContext, onDeny: (tool: string, reason: string) => void = () => {}): HookCallbackMatcher[] {
  const wrap =
    (check: (tool: string, input: Record<string, unknown>) => Promise<Decision> | Decision) =>
    async (input: unknown): Promise<HookJSONOutput> => {
      const i = input as { tool_name: string; tool_input: Record<string, unknown> };
      const d = await check(i.tool_name, i.tool_input ?? {});
      if (!d) return allow;
      onDeny(i.tool_name, d);
      return deny(d);
    };
  return [
    { matcher: "Write|Edit|NotebookEdit", hooks: [wrap((tool, input) => checkWrite(tool, input, ctx))] },
    { matcher: "Bash", hooks: [wrap((_t, input) => checkBash(String(input.command ?? ""), ctx))] },
    { matcher: "WebFetch", hooks: [wrap((_t, input) => checkFetch(String(input.url ?? ""), ctx))] },
    { matcher: "WebSearch", hooks: [wrap(() => "WebSearch is not allowed; fetch the sources directly")] },
  ];
}
