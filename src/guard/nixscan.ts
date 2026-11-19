/**
 * A small scanner for Nix source: finds attribute bindings by their full path
 * (including enclosing attrsets) and returns their exact source text. Enough
 * for flake.nix and module files; not a full parser.
 */

type Token = { kind: "id" | "str" | "punct" | "other"; text: string; start: number; end: number };

const PUNCT = new Set(["{", "}", "[", "]", "(", ")", "=", ";", ".", ",", ":", "?", "@"]);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"') {
      const start = i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i++;
        else if (src[i] === "$" && src[i + 1] === "{") i = skipInterpolation(src, i + 2) - 1;
        i++;
      }
      tokens.push({ kind: "str", text: src.slice(start + 1, i), start, end: ++i });
    } else if (c === "'" && src[i + 1] === "'") {
      const start = i;
      i += 2;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'" && src[i + 2] === "'") i += 3; // escaped ''
        else if (src[i] === "'" && src[i + 1] === "'" && (src[i + 2] === "$" || src[i + 2] === "\\")) i += 3;
        else if (src[i] === "'" && src[i + 1] === "'") break;
        else if (src[i] === "$" && src[i + 1] === "{") i = skipInterpolation(src, i + 2);
        else i++;
      }
      i += 2;
      tokens.push({ kind: "str", text: src.slice(start + 2, i - 2), start, end: i });
    } else if (c === "$" && src[i + 1] === "{") {
      const start = i;
      i = skipInterpolation(src, i + 2);
      tokens.push({ kind: "other", text: src.slice(start, i), start, end: i });
    } else if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
      tokens.push({ kind: "other", text: "...", start: i, end: i + 3 });
      i += 3;
    } else if (PUNCT.has(c)) {
      tokens.push({ kind: "punct", text: c, start: i, end: i + 1 });
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_'-]/.test(src[i]!)) i++;
      tokens.push({ kind: "id", text: src.slice(start, i), start, end: i });
    } else {
      const start = i;
      while (i < src.length && !/[\s#"{}[\]();=,:?@]/.test(src[i]!) && !(src[i] === "." && /[A-Za-z_]/.test(src[i + 1] ?? ""))) {
        if (src[i] === "'" && src[i + 1] === "'") break;
        i++;
      }
      if (i === start) i++;
      tokens.push({ kind: "other", text: src.slice(start, i), start, end: i });
    }
  }
  return tokens;
}

/** Index just past the `}` closing an interpolation that starts at `i` (after `${`). */
function skipInterpolation(src: string, i: number): number {
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    else if (src[i] === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    }
    i++;
  }
  return i;
}

export interface Binding {
  /** Full attribute path, enclosing attrsets included; `let` bindings start with `<let>`. */
  path: string[];
  text: string;
}

/** Every binding whose value is not itself an attrset literal, plus attrset-valued ones. */
export function bindings(src: string): Binding[] {
  const tokens = tokenize(src);
  const out: Binding[] = [];
  let pos = 0;

  const isOpen = (t?: Token) => t?.kind === "punct" && ["{", "[", "("].includes(t.text);
  const isClose = (t?: Token) => t?.kind === "punct" && ["}", "]", ")"].includes(t.text);

  /** Does the `{` at `i` open an attrset (not a function pattern)? */
  const opensAttrs = (i: number): boolean => {
    let depth = 0;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (isOpen(t)) depth++;
      else if (isClose(t)) {
        if (depth === 0) return tokens[j + 1]?.text !== ":" && tokens[j + 1]?.text !== "@";
        depth--;
      } else if (depth === 0) {
        if (t.text === "=" || t.text === "inherit") return true;
        if (t.text === "," || t.text === "?" || t.text === "...") return false;
      }
    }
    return false;
  };

  /** Skip a value at depth 0 up to (not including) the `;` that ends its binding. */
  const skipValue = (prefix: string[]): void => {
    let depth = 0;
    while (pos < tokens.length) {
      const t = tokens[pos]!;
      if (depth === 0 && (t.text === ";" || isClose(t))) return;
      if (t.text === "{" && opensAttrs(pos)) {
        pos++;
        attrs(prefix);
        continue;
      }
      if (t.text === "let" && t.kind === "id") {
        pos++;
        attrs([...prefix, "<let>"], "in");
        continue;
      }
      if (isOpen(t)) depth++;
      else if (isClose(t)) depth--;
      pos++;
    }
  };

  /** Bindings of an attrset (after its `{`) or `let` (until `in`); consumes the closer. */
  const attrs = (prefix: string[], until = "}"): void => {
    while (pos < tokens.length) {
      const t = tokens[pos]!;
      if (t.text === until) {
        pos++;
        return;
      }
      if (t.text === "inherit") {
        while (pos < tokens.length && tokens[pos]!.text !== ";") pos++;
        pos++;
        continue;
      }
      // attribute path up to `=`
      const startTok = t;
      const path: string[] = [];
      while (pos < tokens.length && tokens[pos]!.text !== "=") {
        const p = tokens[pos]!;
        if (p.kind === "id" || p.kind === "str") path.push(p.text);
        else if (p.text !== ".") path.push(p.text);
        if (p.text === until || p.text === ";") break;
        pos++;
      }
      if (tokens[pos]?.text !== "=") {
        pos++;
        continue;
      }
      pos++; // =
      const full = [...prefix, ...path];
      skipValue(full);
      const endTok = tokens[pos];
      out.push({ path: full, text: src.slice(startTok.start, endTok ? endTok.end : src.length) });
      if (endTok?.text === ";") pos++;
    }
  };

  // a file is an attrset, or a function returning one, possibly after `let … in`
  skipValue([]);
  return out;
}

/** Source text of all bindings at or under `prefix` (e.g. `["inputs"]`), outermost only. */
export function bindingText(src: string, match: (path: string[]) => boolean): string {
  const all = bindings(src).filter((b) => match(b.path));
  // drop bindings nested inside another matching one: the outer text covers them
  return all
    .filter((b) => !all.some((o) => o !== b && o.text.includes(b.text) && o.path.length < b.path.length))
    .map((b) => b.text)
    .join("\n");
}

export const startsWith = (prefix: string[]) => (path: string[]) =>
  prefix.every((p, i) => path[i] === p);

/** `["services", "flake-agent"]` anywhere in the path (modules may nest under `config` or a list). */
export const containsSeq = (seq: string[]) => (path: string[]) =>
  path.some((_, i) => seq.every((s, j) => path[i + j] === s));
