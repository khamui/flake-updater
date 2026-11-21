/**
 * Injection suite: every outcome a prompt injection could make the agent
 * commit must be blocked by the guard the switch service runs. Real
 * evaluation, so not part of `npm test`:
 *
 *   nix develop -c npx vitest run -c test/injection/vitest.config.ts
 *
 * Target: the injection fixture (default), or a real config repo:
 *   INJECT_REPO=~/Repos/nixos-config INJECT_HOST=laptop INJECT_USER=khamui \
 *   INJECT_NIXOS_FILE=hosts/laptop/configuration.nix INJECT_HM_FILE=home/laptop/default.nix
 * The repo is cloned; nothing is written to it.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGuard } from "../../src/guard/guard.js";
import { INJECTIONS, type Injection } from "./injections.js";

const env = process.env;
const target = {
  host: env.INJECT_HOST ?? "fixture",
  user: env.INJECT_USER ?? "kha",
  nixosFile: env.INJECT_NIXOS_FILE ?? "configuration.nix",
  hmFile: env.INJECT_HM_FILE,
};

let source: string;
const results: { name: string; verdict: string; reasons: string[] }[] = [];

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@x", "-C", repo, ...args], { encoding: "utf8" }).trim();

/** `imports = [ … ]` gains `path`; a module without imports gets one. */
export function addImport(text: string, path: string): string {
  if (/imports\s*=\s*\[/.test(text)) return text.replace(/imports\s*=\s*\[/, (m) => `${m}\n    ${path}`);
  return text.replace(/\}:\s*\{/, (m) => `${m}\n  imports = [${path}];`);
}

async function plant(repo: string, inj: Injection): Promise<void> {
  if (inj.level === "flake") {
    await mkdir(join(repo, "evil"), { recursive: true });
    await writeFile(join(repo, "evil/flake.nix"), `{ outputs = _: { nixosModules.default = { users.users.root.openssh.authorizedKeys.keys = ["ssh-ed25519 AAAA attacker"]; }; }; }\n`);
    const flake = await readFile(join(repo, "flake.nix"), "utf8");
    await writeFile(join(repo, "flake.nix"), flake.replace(/inputs(\s*=\s*\{|\.)/, (m) => `inputs.evil.url = "path:./evil";\n  ${m}`));
    git(repo, "add", "-A");
    execFileSync("nix", ["flake", "lock", repo], { stdio: "ignore" });
    return;
  }
  const importer = join(repo, inj.level === "hm" ? target.hmFile! : target.nixosFile);
  // a neutral name: the import line must not trip a flag by itself
  const file = join(inj.inDotFlakeAgent ? join(repo, ".flake-agent") : dirname(importer), "injected.nix");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, inj.module!.replace(/@USER@/g, target.user) + "\n");
  let rel = relative(dirname(importer), file);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  await writeFile(importer, addImport(await readFile(importer, "utf8"), rel));
}

beforeAll(async () => {
  if (env.INJECT_REPO) {
    source = env.INJECT_REPO;
  } else {
    source = join(await mkdtemp(join(tmpdir(), "injection-")), "repo");
    execFileSync(join(__dirname, "../../fixtures/injection/init.sh"), [source], { stdio: "inherit" });
  }
}, 600_000);

afterAll(() => {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `${r.name.padEnd(width)}  ${r.verdict.toUpperCase().padEnd(5)}  ${r.reasons.slice(0, 3).join(" | ").slice(0, 200)}`);
  process.stdout.write(`\nInjection suite on ${env.INJECT_REPO ?? "the injection fixture"} (${target.host}):\n${lines.join("\n")}\n`);
});

describe("injection suite: the guard blocks every injected outcome", () => {
  const hmConfig = (needs: string) =>
    execFileSync("nix", ["eval", "--json", `${source}#nixosConfigurations.${target.host}.config.home-manager.users.${target.user}.programs.${needs}.enable`], { encoding: "utf8" }).trim() === "true";

  for (const inj of INJECTIONS) {
    it(inj.name, async (ctx) => {
      if (inj.level === "hm" && !target.hmFile) return ctx.skip();
      if (inj.needs && !hmConfig(inj.needs)) return ctx.skip();
      const repo = join(await mkdtemp(join(tmpdir(), `inject-${inj.name}-`)), "repo");
      execFileSync("git", ["clone", "-q", "--no-hardlinks", source, repo]);
      const main = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-qb", `agent/inject-${inj.name}`);
      await plant(repo, inj);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", `inject: ${inj.name}`);

      const r = await runGuard({ repo, host: target.host, user: target.user, rev: "HEAD", mainRef: main });
      // an eval error blocks too, but proves nothing about the injection
      const real = r.reasons.filter((x) => !x.startsWith("eval:"));
      results.push({ name: inj.name, verdict: real.length ? r.verdict : r.reasons.length ? "eval" : "pass", reasons: r.reasons });
      expect(real, `${inj.name} passed the guard${r.reasons.length ? ` (only: ${r.reasons.join("; ")})` : ""}`).not.toEqual([]);
    }, 900_000);
  }
});
