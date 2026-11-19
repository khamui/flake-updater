import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../t0.js";
import { diffMap, diffSet, type DeepProbe } from "../t3.js";

export interface NeovimCapture {
  startup: { errors: string[]; warnings: string[] };
  /** mode → lhs → rhs (or `<callback: desc>`). */
  keymaps: Record<string, Record<string, string>>;
  plugins: string[];
  /** enabled LSP config → its command and whether that resolves to an executable. */
  lsp: Record<string, { cmd: string; resolves: boolean }>;
  parsers: string[];
  /** WARNING/ERROR lines of `:checkhealth vim.lsp vim.treesitter`. */
  health: string[];
}

/** Runs after the user config is loaded; writes a NeovimCapture (minus startup) as JSON. */
export const PROBE_LUA = String.raw`
local HASH = string.rep('[0-9a-z]', 32) .. '%-'
local function strip(s)
  s = s:gsub('/nix/store/' .. HASH, '/nix/store/'):gsub('^' .. HASH, ''):gsub('<SNR>%d+_', '<SNR>_')
  return s
end
local function sorted_keys(t)
  local keys = {}
  for k in pairs(t) do table.insert(keys, k) end
  table.sort(keys)
  return keys
end

local out = { keymaps = {}, lsp = {}, health = {} }

for _, mode in ipairs({ 'n', 'i', 'x', 's', 'o', 'c', 't' }) do
  local maps = {}
  for _, m in ipairs(vim.api.nvim_get_keymap(mode)) do
    local rhs = m.rhs
    if rhs == nil or rhs == '' then
      rhs = m.desc and ('<callback: ' .. m.desc .. '>') or '<callback>'
    end
    maps[m.lhs] = strip(rhs)
  end
  out.keymaps[mode] = maps
end

local plugins = {}
for _, p in ipairs(vim.api.nvim_list_runtime_paths()) do plugins[strip(vim.fn.fnamemodify(p, ':t'))] = true end
for _, p in ipairs(vim.fn.globpath(vim.o.packpath, 'pack/*/opt/*', false, true)) do
  plugins[strip(vim.fn.fnamemodify(p, ':t'))] = true
end
out.plugins = sorted_keys(plugins)

local configs = (vim.lsp.config and vim.lsp.config._configs) or {}
for _, name in ipairs(sorted_keys(configs)) do
  if name ~= '*' and (vim.lsp.is_enabled == nil or vim.lsp.is_enabled(name)) then
    local cmd = (vim.lsp.config[name] or {}).cmd
    if type(cmd) == 'table' and cmd[1] then
      out.lsp[name] = { cmd = strip(cmd[1]), resolves = vim.fn.executable(cmd[1]) == 1 }
    else
      out.lsp[name] = { cmd = type(cmd), resolves = type(cmd) == 'function' }
    end
  end
end

local parsers = {}
for _, f in ipairs(vim.api.nvim_get_runtime_file('parser/*.so', true)) do parsers[vim.fn.fnamemodify(f, ':t:r')] = true end
out.parsers = sorted_keys(parsers)

-- before checkhealth: its own output must not end up in the startup messages
out.messages = vim.fn.execute('messages')

pcall(vim.cmd, 'checkhealth vim.lsp vim.treesitter')
for _, line in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
  if line:find('ERROR') or line:find('WARNING') then table.insert(out.health, strip(vim.trim(line))) end
end

local f = assert(io.open(os.getenv('FLAKE_AGENT_OUT'), 'w'))
f:write(vim.json.encode(out))
f:close()
`;

/** Startup errors come from stderr and `:messages`: `E5113: …`, `Error in …`. */
export function classifyStartup(stderr: string, messages: string): NeovimCapture["startup"] {
  const errors = new Set<string>();
  const warnings = new Set<string>();
  // the same error reaches both stderr and :messages
  for (const line of [...stderr.split("\n"), ...messages.split("\n")].map((l) => l.trim()).filter(Boolean)) {
    if (TRACEBACK.test(line)) continue;
    if (/^E\d+:|error/i.test(line)) errors.add(line);
    else if (/warn|deprecat/i.test(line)) warnings.add(line);
  }
  return { errors: [...errors], warnings: [...warnings] };
}

/** `stack traceback:`, `[C]: in function 'error'`, `init.lua:2: in main chunk`. */
const TRACEBACK = /^stack traceback:|^\[C\]:|:\d+: in /;

const STORE_HASH = /\/nix\/store\/[0-9a-z]{32}-/g;

export const neovimProbe: DeepProbe<NeovimCapture> = {
  name: "neovim",
  programs: ["neovim", "nvf"],

  async snapshot(sb) {
    const script = join(sb.home, ".flake-agent-probe.lua");
    const out = join(sb.home, ".flake-agent-probe.json");
    await writeFile(script, PROBE_LUA);
    const r = await sb.exec("nvim", ["--headless", "-c", `luafile ${script}`, "+qa"], {
      env: { FLAKE_AGENT_OUT: out },
      timeoutMs: 60_000,
    });

    let raw: Omit<NeovimCapture, "startup"> & { messages: string };
    try {
      raw = JSON.parse(await readFile(out, "utf8"));
    } catch {
      const startup = classifyStartup(r.stderr || `nvim exited with ${r.code} without output`, "");
      if (startup.errors.length === 0) startup.errors.push(`nvim exited with ${r.code} without output`);
      return { startup, keymaps: {}, plugins: [], lsp: {}, parsers: [], health: [] };
    }
    const { messages, ...rest } = raw;
    const startup = classifyStartup(r.stderr, messages);
    const clean = (s: string) => s.split(sb.home).join("~").replace(STORE_HASH, "/nix/store/");
    return {
      ...rest,
      // vim.json encodes an empty table as []
      keymaps: Object.fromEntries(Object.entries(rest.keymaps).map(([m, maps]) => [m, Array.isArray(maps) ? {} : maps])),
      lsp: Array.isArray(rest.lsp) ? {} : rest.lsp,
      startup: { errors: startup.errors.map(clean), warnings: startup.warnings.map(clean) },
    };
  },

  diff(old, next) {
    const findings: Finding[] = [];
    // any startup error fails, whether or not the old config had it too
    for (const e of next.startup.errors) findings.push({ severity: "fail", kind: "nvim-startup-error", subject: "neovim", detail: e });
    const known = new Set(old.startup.warnings);
    for (const w of next.startup.warnings) {
      if (!known.has(w)) findings.push({ severity: "info", kind: "nvim-startup-warning", subject: "neovim", detail: w });
    }

    for (const mode of new Set([...Object.keys(old.keymaps), ...Object.keys(next.keymaps)])) {
      findings.push(...diffMap(old.keymaps[mode] ?? {}, next.keymaps[mode] ?? {}, "nvim-keymap", (lhs) => `${mode} ${lhs}`));
    }

    for (const [name, server] of Object.entries(old.lsp)) {
      const now = next.lsp[name];
      if (server.resolves && !now) {
        findings.push({ severity: "fail", kind: "nvim-lsp-missing", subject: name, detail: "no longer configured" });
      } else if (server.resolves && !now!.resolves) {
        findings.push({ severity: "fail", kind: "nvim-lsp-missing", subject: name, detail: `${now!.cmd} not executable` });
      }
    }
    for (const name of Object.keys(next.lsp)) {
      if (!old.lsp[name]) findings.push({ severity: "info", kind: "nvim-lsp-added", subject: name, detail: next.lsp[name]!.cmd });
    }

    findings.push(...diffSet(old.parsers, next.parsers, "nvim-parser", "fail"));
    findings.push(...diffSet(old.plugins, next.plugins, "nvim-plugin", "info"));

    const health = new Set(old.health);
    for (const line of next.health) {
      if (health.has(line)) continue;
      const error = line.includes("ERROR");
      findings.push({ severity: error ? "fail" : "info", kind: error ? "nvim-health-error" : "nvim-health-warning", subject: "neovim", detail: line });
    }
    return findings;
  },
};
