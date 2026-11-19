import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { CHOICE, PREFLIGHT_FAILED, runCycle, skip, status } from "../../src/preflight/cycle.js";
import { acquireLock, lockHolder, onAC } from "../../src/preflight/environment.js";
import { preflight, readToken } from "../../src/preflight/preflight.js";
import { StateStore, defaultStateDir } from "../../src/preflight/state.js";
import { classifyPing, type PreflightFailure } from "../../src/preflight/subscription.js";

// Shapes as the SDK emits them; only the fields the classifier reads matter.
const assistant = (error: string | undefined, text: string) =>
  ({ type: "assistant", error, message: { content: [{ type: "text", text }] } }) as unknown as SDKMessage;
const result = (isError: boolean, subtype = "success") =>
  ({ type: "result", subtype, is_error: isError, errors: [] }) as unknown as SDKMessage;
const rateLimit = (status: string, resetsAt?: number) =>
  ({ type: "rate_limit_event", rate_limit_info: { status, resetsAt } }) as unknown as SDKMessage;
const init = { type: "system", subtype: "init" } as unknown as SDKMessage;

describe("classifyPing", () => {
  it("maps an invalid token to auth with the setup-token hint (recorded from a real 401)", () => {
    const messages = [
      init,
      assistant("authentication_failed", "Failed to authenticate. API Error: 401 OAuth access token is invalid."),
      result(true),
    ];
    const thrown = new Error("Claude Code returned an error result: Failed to authenticate. API Error: 401");
    expect(classifyPing(messages, thrown)).toEqual({
      reason: "auth",
      message: "Not logged in or token expired — run `claude setup-token`",
    });
  });

  it("maps billing and account holds to subscription", () => {
    for (const error of ["billing_error", "account_on_hold"]) {
      expect(classifyPing([assistant(error, "Credit balance is too low"), result(true)])?.reason).toBe("subscription");
    }
  });

  it("maps a quota error to quota, with the reset time when known", () => {
    const resets = Date.UTC(2026, 10, 20, 3, 0, 0) / 1000;
    expect(classifyPing([rateLimit("rejected", resets), assistant("rate_limit", "limit reached"), result(true)])).toEqual({
      reason: "quota",
      message: "Quota exhausted, resets ~2026-11-20T03:00:00.000Z",
      resetsAt: "2026-11-20T03:00:00.000Z",
    });
    expect(classifyPing([assistant("rate_limit", "limit"), result(true)])).toEqual({ reason: "quota", message: "Quota exhausted" });
    expect(classifyPing([rateLimit("rejected"), result(true)])?.reason).toBe("quota");
  });

  it("maps overload, server errors and network failures to unreachable", () => {
    expect(classifyPing([assistant("overloaded", "Overloaded"), result(true)])?.reason).toBe("unreachable");
    expect(classifyPing([assistant("server_error", "API Error: 500"), result(true)])?.reason).toBe("unreachable");
    expect(classifyPing([init], new Error("getaddrinfo ENOTFOUND api.anthropic.com"))?.reason).toBe("unreachable");
    expect(classifyPing([])?.reason).toBe("unreachable");
  });

  it("maps an unknown model to model, a crash to sdk", () => {
    expect(classifyPing([assistant("model_not_found", "model: claude-x"), result(true)])?.reason).toBe("model");
    expect(classifyPing([], new Error("spawn claude ENOENT"))?.reason).toBe("sdk");
  });

  it("passes a successful call, including one that only hit maxTurns", () => {
    expect(classifyPing([init, assistant(undefined, "OK"), rateLimit("allowed"), result(false)])).toBeNull();
    expect(classifyPing([init, result(true, "error_max_turns")])).toBeNull();
  });
});

describe("preflight order", () => {
  it("stops at a missing credential without calling the SDK or checking the environment", async () => {
    const ping = vi.fn();
    const environment = vi.fn();
    expect(await preflight({ readToken: async () => undefined, ping, environment })).toEqual({
      reason: "no-credential",
      message: "No subscription token — run `claude setup-token`",
    });
    expect(ping).not.toHaveBeenCalled();
    expect(environment).not.toHaveBeenCalled();
  });

  it("checks the environment only after the subscription", async () => {
    const auth: PreflightFailure = { reason: "auth", message: "x" };
    const environment = vi.fn(async () => null);
    expect(await preflight({ readToken: async () => "t", ping: async () => auth, environment })).toBe(auth);
    expect(environment).not.toHaveBeenCalled();
    expect(await preflight({ readToken: async () => "t", ping: async () => null, environment })).toBeNull();
    expect(environment).toHaveBeenCalledOnce();
  });

  it("reads the token from the systemd credential first, then the file, then the environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cred-"));
    await writeFile(join(dir, "claude-token"), "from-credential\n");
    await writeFile(join(dir, "file"), "from-file\n");
    expect(await readToken({ credentialsDir: dir, tokenFile: join(dir, "file"), envToken: "env" })).toBe("from-credential");
    expect(await readToken({ tokenFile: join(dir, "file"), envToken: "env" })).toBe("from-file");
    expect(await readToken({ tokenFile: join(dir, "missing"), envToken: "env" })).toBe("env");
    await writeFile(join(dir, "empty"), "\n");
    expect(await readToken({ tokenFile: join(dir, "empty") })).toBeUndefined();
  });
});

describe("run, retry, skip", () => {
  const setup = async () => {
    const state = new StateStore(await mkdtemp(join(tmpdir(), "state-")));
    const out: string[] = [];
    return { state, out, write: (t: string) => out.push(t) };
  };
  const quota: PreflightFailure = { reason: "quota", message: "Quota exhausted" };

  it("records a failure, runs nothing and offers retry/skip; a repeated failure shows the same choice", async () => {
    const { state, out, write } = await setup();
    const update = vi.fn(async () => 0);
    expect(await runCycle({ state, preflight: async () => quota, update, out: write })).toBe(PREFLIGHT_FAILED);
    expect(update).not.toHaveBeenCalled();
    const first = await state.load();
    expect(first.pending?.failure).toEqual(quota);

    // retry: preflight runs again and fails again
    const preflightAgain = vi.fn(async () => quota);
    expect(await runCycle({ state, preflight: preflightAgain, update, out: write })).toBe(PREFLIGHT_FAILED);
    expect(preflightAgain).toHaveBeenCalledOnce();
    expect(out).toEqual([`Update skipped — Quota exhausted\n${CHOICE}\n`, `Update skipped — Quota exhausted\n${CHOICE}\n`]);
    expect((await state.load()).pending?.since).toBe(first.pending?.since);
  });

  it("clears the pending choice and runs the update once preflight passes", async () => {
    const { state, write } = await setup();
    await runCycle({ state, preflight: async () => quota, update: async () => 0, out: write });
    const update = vi.fn(async () => 0);
    expect(await runCycle({ state, preflight: async () => null, update, out: write })).toBe(0);
    expect(update).toHaveBeenCalledOnce();
    expect((await state.load()).pending).toBeUndefined();
  });

  it("skip clears the pending prompt; status shows it until then", async () => {
    const { state, out, write } = await setup();
    await runCycle({ state, preflight: async () => quota, update: async () => 0, out: write });
    out.length = 0;
    await status(state, write);
    expect(out.join("")).toContain("Pending since");
    out.length = 0;
    await skip(state, write);
    expect((await state.load()).pending).toBeUndefined();
    await status(state, write);
    expect(out.join("")).not.toContain("Pending since");
    expect(out.join("")).toContain("Preflight: failed — Quota exhausted");
  });

  it("uses systemd's STATE_DIRECTORY, else the XDG state dir", () => {
    expect(defaultStateDir({ STATE_DIRECTORY: "/var/lib/flake-agent" })).toBe("/var/lib/flake-agent");
    expect(defaultStateDir({ HOME: "/home/kha" })).toBe("/home/kha/.local/state/flake-agent");
  });
});

describe("environment", () => {
  const supplies = async (entries: Record<string, Record<string, string>>) => {
    const root = await mkdtemp(join(tmpdir(), "power-"));
    for (const [name, files] of Object.entries(entries)) {
      await mkdir(join(root, name));
      for (const [f, v] of Object.entries(files)) await writeFile(join(root, name, f), `${v}\n`);
    }
    return root;
  };

  it("detects AC power", async () => {
    expect(await onAC(await supplies({ AC: { type: "Mains", online: "1" }, BAT0: { type: "Battery", status: "Charging" } }))).toBe(true);
    expect(await onAC(await supplies({ AC: { type: "Mains", online: "0" }, BAT0: { type: "Battery", status: "Discharging" } }))).toBe(false);
    expect(await onAC(await supplies({}))).toBe(true); // desktop
  });

  it("holds the run lock until released, and ignores a stale lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const release = await acquireLock(dir);
    expect(release).toBeDefined();
    expect(await lockHolder(dir)).toBe(process.pid);
    expect(await acquireLock(dir)).toBeUndefined();
    await release!();
    expect(await lockHolder(dir)).toBeUndefined();

    await writeFile(join(dir, "run.lock"), "999999999");
    expect(await lockHolder(dir)).toBeUndefined();
  });
});
