import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

/** Run a command and return stdout; exit codes in `okCodes` (besides 0) don't reject. */
export async function run(cmd: string, args: string[], okCodes: number[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !(typeof err.code === "number" && okCodes.includes(err.code))) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

export interface Captured {
  /** Exit code; 124 on timeout, 127 if the command could not be started. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface CaptureOptions {
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

/** Run a command and capture its exit code and output; never rejects. */
export function capture(cmd: string, args: string[], opts: CaptureOptions = {}): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 60_000);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr: timedOut ? `${stderr}timed out` : stderr });
    });
    child.stdin.on("error", () => {}); // child may exit before reading its input
    child.stdin.end(opts.input ?? "");
  });
}

/** Absolute path of `cmd` on this process's PATH (a child's env may carry a different PATH). */
export async function which(cmd: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      await access(`${dir}/${cmd}`, constants.X_OK);
      return `${dir}/${cmd}`;
    } catch {
      // not in this directory
    }
  }
  return undefined;
}
