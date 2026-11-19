#!/usr/bin/env node
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { configAttr, discoverPackages, discoverPrograms, type Target } from "../discovery/discover.js";
import { run } from "../nix/exec.js";
import { nixStore } from "../nix/store.js";
import { diffT0, snapshotT0, type Finding } from "../probes/t0.js";
import { writeSnapshot } from "../probes/snapshots.js";
import { diffT1, snapshotT1 } from "../probes/t1.js";
import { diffT2, snapshotT2 } from "../probes/t2.js";
import { diffT3, selectDeepProbes, snapshotT3 } from "../probes/t3.js";
import { DEEP_PROBES } from "../probes/deep/index.js";
import { BUILTIN_VALIDATORS, loadCustomValidators, selectValidators } from "../probes/validators.js";
import { runGuard, type GuardOptions } from "../guard/guard.js";

const HELP = `Usage: flake-agent <command> [options]

Commands:
  probe       Snapshot the live system and a fresh build, diff them
  discover    List packages the host config declares (JSON)
  guard <rev> Compare guarded options of <rev> with where it left main; exit 1 = block

Options:
  --repo <path>     Config repo (default: current directory)
  --host <name>     nixosConfigurations attribute (default: hostname)
  --user <name>     User to probe (default: current user)
  --against <path>  Old system toplevel (default: /run/current-system)
  --build <path>    Use this toplevel instead of building the repo
  --main <ref>      Branch the agent branched from (guard; default: main)
  --allow/--deny <glob>  Write-scope overrides (guard; repeatable)
  --diff-limit <n>  Max changed lines (guard; default: 60)
  --self-input <name>  flake-updater input name (guard; default: flake-updater)
  -h, --help        Show this help

Custom T2 validators: <repo>/.flake-agent/probes/<program>.sh, run when
programs.<program>.enable is set (exit non-zero = error, stderr = messages).
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      host: { type: "string" },
      user: { type: "string" },
      against: { type: "string" },
      build: { type: "string" },
      main: { type: "string" },
      allow: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      "diff-limit": { type: "string" },
      "self-input": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }

  const repo = resolve(values.repo ?? process.cwd());
  const target: Target = {
    flake: repo,
    host: values.host ?? hostname(),
    user: values.user ?? userInfo().username,
  };

  switch (command) {
    case "discover":
      process.stdout.write(JSON.stringify(await discoverPackages(target), null, 2) + "\n");
      return 0;
    case "probe":
      return probe(repo, target, values.against ?? "/run/current-system", values.build);
    case "guard":
      if (!positionals[1]) {
        process.stderr.write("guard: missing <rev>\n");
        return 2;
      }
      return guard({
        repo,
        host: target.host,
        user: target.user,
        rev: positionals[1],
        mainRef: values.main,
        writeScope: { allow: values.allow ?? [], deny: values.deny ?? [] },
        diffLimit: values["diff-limit"] ? Number(values["diff-limit"]) : undefined,
        selfInput: values["self-input"],
      });
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function probe(repo: string, target: Target, against: string, build?: string): Promise<number> {
  const toplevel =
    build ??
    (await run("nix", ["build", "--no-link", "--print-out-paths", configAttr(target, "config.system.build.toplevel")])).trim();

  const [oldT0, newT0, oldT1, newT1] = await Promise.all([
    snapshotT0(nixStore, against, target.user),
    snapshotT0(nixStore, toplevel, target.user),
    snapshotT1(nixStore, against, target.user),
    snapshotT1(nixStore, toplevel, target.user),
  ]);

  const programs = await discoverPrograms(target);
  const validators = selectValidators(programs, [
    ...BUILTIN_VALIDATORS,
    ...(await loadCustomValidators(repo)),
  ]);
  // sequential: validators start servers (Xvfb, tmux) and must not race
  const oldT2 = await snapshotT2(against, target.user, validators);
  const newT2 = await snapshotT2(toplevel, target.user, validators);
  const deep = selectDeepProbes(programs, DEEP_PROBES);
  const oldT3 = await snapshotT3(against, target.user, deep);
  const newT3 = await snapshotT3(toplevel, target.user, deep);

  const findings = diffT0(oldT0, newT0);
  // a manual probe has no agent commits to attribute T1 changes to
  const changes = await diffT1(oldT1, newT1);
  const t2 = diffT2(oldT2, newT2);
  const t3 = diffT3(oldT3, newT3, deep);
  const files = [
    await writeSnapshot(repo, target.host, "t0", newT0),
    await writeSnapshot(repo, target.host, "t1", newT1),
    await writeSnapshot(repo, target.host, "t2", newT2),
    await writeSnapshot(repo, target.host, "t3", newT3),
  ];

  process.stdout.write(`old: ${against}\nnew: ${toplevel}\nsnapshots: ${files.join(", ")}\n\n`);
  process.stdout.write(formatFindings("T0", findings));
  // T1 content diffs are printed below the list
  process.stdout.write("\n" + formatFindings("T1", changes.map((c) => ({ ...c, detail: "" }))));
  for (const c of changes) {
    if (c.detail) process.stdout.write(`\n--- ${c.subject}\n${c.detail}\n`);
  }
  process.stdout.write(`\nT2 validators: ${validators.map((v) => v.name).join(", ") || "none"}\n`);
  process.stdout.write(formatFindings("T2", t2));
  process.stdout.write(`\nT3 probes: ${deep.map((p) => p.name).join(", ") || "none"}\n`);
  process.stdout.write(formatFindings("T3", t3));

  try {
    process.stdout.write("\n" + (await run("nvd", ["diff", against, toplevel])));
  } catch {
    // nvd is wrapped into the package; missing only when run from source
  }
  return [...findings, ...t2, ...t3].some((f) => f.severity === "fail") ? 1 : 0;
}

async function guard(opts: GuardOptions): Promise<number> {
  const result = await runGuard(opts);
  process.stdout.write(`base: ${result.base}
rev:  ${result.rev}

${result.verdict.toUpperCase()}
`);
  for (const reason of result.reasons) process.stdout.write(`  ${reason}
`);
  return result.verdict === "pass" ? 0 : 1;
}

function formatFindings(tier: string, findings: Finding[]): string {
  if (findings.length === 0) return `${tier}: no differences\n`;
  return findings
    .map((f) => {
      const detail = f.detail ? `  ${f.detail.replace(/\n/g, "\n    ")}` : "";
      return `${f.severity === "fail" ? "✗" : "·"} ${f.kind.padEnd(17)} ${f.subject}${detail}`;
    })
    .join("\n") + "\n";
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`flake-agent: ${err.message}\n`);
    process.exit(2);
  },
);
