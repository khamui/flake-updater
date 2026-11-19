import type { Finding } from "../t0.js";
import { diffMap, diffSet, type DeepProbe } from "../t3.js";
import { normalise } from "../t2.js";

export interface ZshCapture {
  /** `name`, `-g name` (global), `-s ext` (suffix) → expansion. */
  aliases: Record<string, string>;
  /** User-level function names (completion functions `_*` excluded). */
  functions: string[];
  /** Key sequence (main keymap) → widget. */
  bindings: Record<string, string>;
  completion: { compinit: boolean; completions: number };
  /** stderr of an interactive start. */
  stderr: string[];
}

/** Printed from inside an interactive shell, one `@@section` per kind. */
export const CAPTURE_SCRIPT = [
  'print -r -- "@@aliases"; for k v in "${(@kv)aliases}"; do print -r -- "$k=$v"; done',
  'print -r -- "@@galiases"; for k v in "${(@kv)galiases}"; do print -r -- "$k=$v"; done',
  'print -r -- "@@saliases"; for k v in "${(@kv)saliases}"; do print -r -- "$k=$v"; done',
  'print -r -- "@@functions"; print -rl -- ${(k)functions}',
  'print -r -- "@@bindkey"; bindkey -L',
  'print -r -- "@@completion"; print -r -- "$+functions[compdef] ${#_comps}"',
].join("\n");

export function parseZshCapture(stdout: string): Omit<ZshCapture, "stderr"> {
  const sections: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of stdout.split("\n")) {
    const m = /^@@(\w+)$/.exec(line);
    if (m) sections[m[1]!] = current = [];
    else if (current && line !== "") current.push(line);
  }

  const aliases: Record<string, string> = {};
  for (const [section, prefix] of [["aliases", ""], ["galiases", "-g "], ["saliases", "-s "]] as const) {
    for (const line of sections[section] ?? []) {
      const eq = line.indexOf("=");
      if (eq > 0) aliases[prefix + line.slice(0, eq)] = line.slice(eq + 1);
    }
  }

  const bindings: Record<string, string> = {};
  for (const line of sections.bindkey ?? []) {
    // bindkey "^A" beginning-of-line | bindkey -R "!"-"~" self-insert
    const m = /^bindkey (.+) (\S+)$/.exec(line);
    if (m) bindings[m[1]!] = m[2]!;
  }

  const [compdef, count] = (sections.completion?.[0] ?? "0 0").split(" ");
  return {
    aliases: sortKeys(aliases),
    functions: (sections.functions ?? []).filter((f) => !f.startsWith("_")).sort(),
    bindings,
    completion: { compinit: compdef === "1", completions: Number(count) || 0 },
  };
}

export const zshProbe: DeepProbe<ZshCapture> = {
  name: "zsh",
  programs: ["zsh"],

  async snapshot(sb) {
    const start = await sb.exec("zsh", ["-i", "-c", "exit"]);
    const r = await sb.exec("zsh", ["-i", "-c", CAPTURE_SCRIPT]);
    return {
      ...parseZshCapture(r.stdout),
      stderr: start.stderr.split("\n").filter((l) => l.trim()).map((l) => normalise(l, sb.home)),
    };
  },

  diff(old, next) {
    const findings: Finding[] = [];
    // any output on stderr fails, whether or not the old config had it too
    for (const line of next.stderr) findings.push({ severity: "fail", kind: "zsh-startup-stderr", subject: "zsh", detail: line });
    findings.push(...diffMap(old.aliases, next.aliases, "zsh-alias"));
    findings.push(...diffMap(old.bindings, next.bindings, "zsh-binding"));
    findings.push(...diffSet(old.functions, next.functions, "zsh-function", "info"));
    if (old.completion.compinit && !next.completion.compinit) {
      findings.push({ severity: "fail", kind: "zsh-completion-missing", subject: "compinit", detail: "completion system no longer initialised" });
    } else if (old.completion.completions !== next.completion.completions) {
      findings.push({
        severity: "info",
        kind: "zsh-completions",
        subject: "zsh",
        detail: `${old.completion.completions} → ${next.completion.completions} commands with completion`,
      });
    }
    return findings;
  },
};

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
