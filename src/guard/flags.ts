import { bindings } from "./nixscan.js";
import { countsTowardsLimit, type FileChange } from "./structure.js";

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

/**
 * Rendered init files only (shell rc, git config, nvim init): a new URL or raw
 * socket there runs on the next shell or editor start. In Nix source, URLs are
 * common (homepages, fetchers) and fetchers are flagged on their own.
 */
export const RENDERED_FLAGS: Flag[] = [
  { class: "fetch", name: "URL", re: /\b(?:https?|ftp):\/\// },
  { class: "code", name: "/dev/tcp", re: /\/dev\/(?:tcp|udp)\// },
  { class: "code", name: "network library", re: /\b(?:urlopen|urllib|requests\.(?:get|post)|socket\.socket|IO::Socket|LWP::|Net::HTTP|Invoke-WebRequest)\b/ },
];

/** Embedded config blocks; growing one by more than this many lines needs review. */
export const EMBEDDED_BLOCKS = ["extraConfig", "extraLuaConfig", "luaConfigRC", "initContent", "interactiveShellInit"];
export const EMBEDDED_GROWTH = 3;

/**
 * Not scanned: the lock (full of hashes) and records nothing evaluates
 * (snapshots, CHANGES.md, keep-old patches and notes). Anything else under
 * .flake-agent/ can be imported by the config, so it is.
 */
const SKIP = (path: string) => !countsTowardsLimit(path);

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
 * New flagged lines in rendered init files (see GUARD_NIX `scan`): the
 * agent's side against the baseline, both on the new lock.
 */
export function renderedFlagViolations(baseline: Record<string, string | null>, agent: Record<string, string | null>): string[] {
  const changes = Object.keys(agent).map((name) => ({ path: `rendered:${name}`, before: baseline[name] ?? null, after: agent[name] ?? null }));
  return flagViolations(changes, [...FLAGS, ...RENDERED_FLAGS]);
}

/**
 * New occurrences of flagged patterns in the agent's diff. Counting per file
 * (not per diff line) means existing or moved occurrences never trigger.
 */
export function flagViolations(changes: FileChange[], flags: Flag[] = FLAGS): string[] {
  const reasons: string[] = [];
  for (const { path, before, after } of changes) {
    if (SKIP(path) || after === null) continue;
    const old = before ?? "";
    const added = addedLines(old, after);

    for (const flag of flags) {
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
