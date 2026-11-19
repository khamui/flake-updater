import type { Finding } from "../t0.js";
import { normalise } from "../t2.js";
import { diffMap, type DeepProbe } from "../t3.js";
import { withTmuxServer } from "../validators.js";

export interface TmuxCapture {
  prefix: string;
  /** `<table> <key>` → command (`-r` prefixed when repeatable). */
  bindings: Record<string, string>;
  /** `server:`/`session:`/`window:` + option name → value. */
  options: Record<string, string>;
  /** Errors from sourcing the config. */
  errors: string[];
}

/** `bind-key    -r -T prefix    C-h    select-pane -L` */
export function parseListKeys(output: string): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = /^bind-key\s+(-r\s+)?-T\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) bindings[`${m[2]} ${m[3]}`] = (m[1] ? "-r " : "") + m[4]!.trim();
  }
  return bindings;
}

/** `show-options` output: `name value`. */
export function parseOptions(output: string, scope: string): Record<string, string> {
  const options: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (m) options[`${scope}:${m[1]}`] = m[2] ?? "";
  }
  return options;
}

export const tmuxProbe: DeepProbe<TmuxCapture> = {
  name: "tmux",
  programs: ["tmux"],

  snapshot: (sb) =>
    withTmuxServer(sb, async (started, tmux) => {
      const clean = (s: string) => normalise(s, sb.home);
      const [prefix, keys, server, session, window] = await Promise.all([
        tmux("show-options", "-gv", "prefix"),
        tmux("list-keys"),
        tmux("show-options", "-s"),
        tmux("show-options", "-g"),
        tmux("show-options", "-gw"),
      ]);
      const options = {
        ...parseOptions(server.stdout, "server"),
        ...parseOptions(session.stdout, "session"),
        ...parseOptions(window.stdout, "window"),
      };
      return {
        prefix: prefix.stdout.trim(),
        bindings: Object.fromEntries(Object.entries(parseListKeys(keys.stdout)).map(([k, v]) => [k, clean(v)])),
        options: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, clean(v)])),
        errors: started.stderr.split("\n").filter((l) => l.trim()).map(clean),
      };
    }),

  diff(old, next) {
    const findings: Finding[] = [];
    if (old.prefix !== next.prefix) {
      findings.push({ severity: "fail", kind: "tmux-prefix-changed", subject: "prefix", detail: `${old.prefix} → ${next.prefix}` });
    }
    findings.push(...diffMap(old.bindings, next.bindings, "tmux-binding"));
    // option changes are behaviour changes worth reporting, not breakage on their own
    findings.push(
      ...diffMap(old.options, next.options, "tmux-option").map((f): Finding => ({ ...f, severity: "info" })),
    );
    const known = new Set(old.errors);
    for (const e of next.errors) {
      if (!known.has(e)) findings.push({ severity: "fail", kind: "tmux-config-error", subject: "tmux", detail: e });
    }
    return findings;
  },
};
