import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import type { Finding } from "../t0.js";
import { normalise } from "../t2.js";
import { diffMap, type DeepProbe } from "../t3.js";
import { checkAlacritty } from "../validators.js";

export interface AlacrittyCapture {
  /** Config file in use, relative to HOME (`~/...`), or null if none. */
  config: string | null;
  /** Hash of the config and its imports (store hashes stripped). */
  configHash: string;
  /** `mods+key [mode]` → action, chars or command. */
  bindings: Record<string, string>;
  errors: string[];
  warnings: string[];
}

/** Where alacritty looks for its config, in order (XDG_CONFIG_HOME is ~/.config in the sandbox). */
const CONFIG_PATHS = [".config/alacritty/alacritty.toml", ".config/alacritty.toml", ".alacritty.toml"];

type Toml = Record<string, unknown>;
type Binding = { key?: unknown; mods?: unknown; mode?: unknown; action?: unknown; chars?: unknown; command?: unknown };

/** `{ key: "V", mods: "Shift|Control" }` → `Control|Shift+V`. */
export function bindingId(b: Binding): string {
  const mods = typeof b.mods === "string" ? b.mods.split("|").map((m) => m.trim()).sort().join("|") : "";
  const mode = typeof b.mode === "string" ? ` [${b.mode}]` : "";
  return `${mods ? `${mods}+` : ""}${String(b.key)}${mode}`;
}

function bindingValue(b: Binding): string {
  if (b.action !== undefined) return String(b.action);
  if (b.chars !== undefined) return `chars ${JSON.stringify(b.chars)}`;
  if (b.command !== undefined) return `command ${JSON.stringify(b.command)}`;
  return "";
}

/** Bindings of one parsed config: `keyboard.bindings`, or the pre-0.13 `key_bindings`. */
export function bindingsOf(config: Toml): Record<string, string> {
  const keyboard = (config.keyboard ?? {}) as Toml;
  const list = [
    ...(Array.isArray(config.key_bindings) ? config.key_bindings : []),
    ...(Array.isArray(keyboard.bindings) ? keyboard.bindings : []),
  ] as Binding[];
  return Object.fromEntries(list.map((b) => [bindingId(b), bindingValue(b)]));
}

/** Imports of a config: `general.import`, or the older top-level `import`. */
function importsOf(config: Toml): string[] {
  const general = (config.general ?? {}) as Toml;
  const list = general.import ?? config.import;
  return Array.isArray(list) ? list.map(String) : [];
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

export const alacrittyProbe: DeepProbe<AlacrittyCapture> = {
  name: "alacritty",
  programs: ["alacritty"],

  async snapshot(sb) {
    const check = await checkAlacritty(sb);
    const clean = (s: string) => normalise(s, sb.home);
    const capture: AlacrittyCapture = {
      config: null,
      configHash: "",
      bindings: {},
      errors: check.errors.map(clean),
      warnings: check.warnings.map(clean),
    };

    let main: string | undefined;
    for (const rel of CONFIG_PATHS) {
      if (await exists(join(sb.home, rel))) {
        main = join(sb.home, rel);
        capture.config = `~/${rel}`;
        break;
      }
    }
    if (!main) return capture;

    // imports first, the main file last: later files override earlier bindings
    const hash = createHash("sha256");
    const load = async (file: string, depth: number): Promise<void> => {
      const text = await readFile(file, "utf8");
      hash.update(clean(text));
      let config: Toml;
      try {
        config = parse(text) as Toml;
      } catch (err) {
        capture.errors.push(clean(`${file}: ${(err as Error).message.split("\n")[0]}`));
        return;
      }
      if (depth < 5) {
        for (const imp of importsOf(config)) {
          const path = imp.startsWith("~/") ? join(sb.home, imp.slice(2)) : isAbsolute(imp) ? imp : join(dirname(file), imp);
          if (await exists(path)) await load(path, depth + 1);
        }
      }
      Object.assign(capture.bindings, bindingsOf(config));
    };
    await load(main, 0);
    capture.configHash = hash.digest("hex");
    return capture;
  },

  diff(old, next) {
    const findings: Finding[] = [];
    // any config error fails; new warnings already fail in T2 and are reported here as info
    for (const e of next.errors) findings.push({ severity: "fail", kind: "alacritty-config-error", subject: "alacritty", detail: e });
    const known = new Set(old.warnings);
    for (const w of next.warnings) {
      if (!known.has(w)) findings.push({ severity: "info", kind: "alacritty-warning", subject: "alacritty", detail: w });
    }
    if (old.config !== next.config) {
      findings.push({ severity: "info", kind: "alacritty-config-moved", subject: "alacritty", detail: `${old.config} → ${next.config}` });
    } else if (old.configHash !== next.configHash) {
      findings.push({ severity: "info", kind: "alacritty-config-changed", subject: next.config ?? "alacritty", detail: "see T1" });
    }
    findings.push(...diffMap(old.bindings, next.bindings, "alacritty-binding"));
    return findings;
  },
};
