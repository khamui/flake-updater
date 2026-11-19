import { execFile } from "node:child_process";

/** Run a command and return stdout; exit codes in `okCodes` (besides 0) don't reject. */
export async function run(cmd: string, args: string[], okCodes: number[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !(typeof err.code === "number" && okCodes.includes(err.code))) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}
