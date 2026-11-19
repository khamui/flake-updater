import { bindings } from "./nixscan.js";
import type { FileChange } from "./structure.js";

export interface Flag {
  class: "code" | "fetch";
  name: string;
  re: RegExp;
}

/** Patterns whose new occurrences need a human: executing code, or fetching/pinning content. */
export const FLAGS: Flag[] = [
  { class: "code", name: "curl", re: /\bcurl\b/ },
  { class: "code", name: "wget", re: /\bwget\b/ },
  { class: "code", name: "nc", re: /\b(?:nc|ncat|netcat)\b/ },
  { class: "code", name: "ssh", re: /(?<![\w.-])ssh(?![\w-])/ },
  { class: "code", name: "base64", re: /\bbase64\b/ },
  { class: "code", name: "eval", re: /\beval\b/ },
  // shell `source <path>` / `. <path>`, not the Nix attribute `source = ...`
  { class: "code", name: "source", re: /(?:^|[\s;&|(])(?:source|\.)\s+(?!=)["']?[~/$\w]/ },
  { class: "code", name: "vim.fn.system", re: /\bvim\.fn\.system\b/ },
  { class: "code", name: "vim.system", re: /\bvim\.system\b/ },
  { class: "code", name: "os.execute", re: /\bos\.execute\b/ },
  { class: "code", name: "io.popen", re: /\bio\.popen\b/ },
  { class: "code", name: "jobstart", re: /\bjobstart\b/ },
  { class: "code", name: "run-shell", re: /\brun-shell\b/ },
  { class: "code", name: "if-shell", re: /\bif-shell\b/ },
  { class: "fetch", name: "outputHash", re: /\boutputHash\w*\b/ },
  { class: "fetch", name: "hash", re: /\bhash\s*=/ },
  { class: "fetch", name: "sha256", re: /\bsha256\b/ },
  { class: "fetch", name: "vendorHash", re: /\bvendorHash\b/ },
  { class: "fetch", name: "npmDepsHash", re: /\bnpmDepsHash\b/ },
  { class: "fetch", name: "pnpmDeps", re: /\bpnpmDeps\b/ },
  { class: "fetch", name: "fetchurl", re: /\bfetchurl\b/ },
  { class: "fetch", name: "fetchFromGitHub", re: /\bfetchFromGitHub\b/ },
  { class: "fetch", name: "fetchgit", re: /\bfetchgit\b/i },
  { class: "fetch", name: "builtins.fetch*", re: /\bbuiltins\.fetch\w*/ },
];

/** Embedded config blocks; growing one by more than this many lines needs review. */
export const EMBEDDED_BLOCKS = ["extraConfig", "extraLuaConfig", "luaConfigRC", "initContent", "interactiveShellInit"];
export const EMBEDDED_GROWTH = 3;

/** Not scanned: the lock is full of hashes, `.flake-agent/` holds snapshots and keep-old patches. */
const SKIP = (path: string) => path === "flake.lock" || path.startsWith(".flake-agent/");

const count = (text: string, re: RegExp) =>
  text.split("\n").filter((line) => re.test(line)).length;

const quote = (line: string) => (line.trim().length > 120 ? `${line.trim().slice(0, 120)}…` : line.trim());

/** Lines of `after` not present (as often) in `before`. */
function addedLines(before: string, after: string): string[] {
  const left = new Map<string, number>();
  for (const l of before.split("\n")) left.set(l, (left.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after.split("\n")) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else added.push(l);
  }
  return added;
}

/** Total lines of embedded config blocks named `block` in a Nix file. */
function blockLines(src: string, block: string): number {
  try {
    return bindings(src)
      .filter((b) => b.path.includes(block))
      .reduce((n, b) => n + b.text.split("\n").length, 0);
  } catch {
    return 0;
  }
}

/**
 * New occurrences of flagged patterns in the agent's diff. Counting per file
 * (not per diff line) means existing or moved occurrences never trigger.
 */
export function flagViolations(changes: FileChange[]): string[] {
  const reasons: string[] = [];
  for (const { path, before, after } of changes) {
    if (SKIP(path) || after === null) continue;
    const old = before ?? "";
    const added = addedLines(old, after);

    for (const flag of FLAGS) {
      if (count(after, flag.re) <= count(old, flag.re)) continue;
      const lines = added.filter((l) => flag.re.test(l)).map(quote);
      reasons.push(`flag(${flag.class}): new ${flag.name} in ${path}${lines.length ? `: ${lines.join(" | ")}` : ""}`);
    }

    // overrideAttrs touching src: a new `src =` in a file that overrides attrs
    if (/\boverrideAttrs\b/.test(after) && count(after, /\bsrc\s*=/) > count(old, /\bsrc\s*=/)) {
      reasons.push(`flag(fetch): overrideAttrs with new src in ${path}`);
    }

    if (path.endsWith(".nix")) {
      for (const block of EMBEDDED_BLOCKS) {
        const growth = blockLines(after, block) - blockLines(old, block);
        if (growth > EMBEDDED_GROWTH) reasons.push(`flag(code): ${block} grew by ${growth} lines in ${path}`);
      }
    }
  }
  return reasons;
}
