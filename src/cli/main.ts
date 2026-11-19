#!/usr/bin/env node
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { configAttr, discoverPackages, type Target } from "../discovery/discover.js";
import { run } from "../nix/exec.js";
import { nixStore } from "../nix/store.js";
import { diffT0, snapshotT0, type Finding } from "../probes/t0.js";
import { writeSnapshot } from "../probes/snapshots.js";
import { diffT1, snapshotT1 } from "../probes/t1.js";

const HELP = `Usage: flake-agent <command> [options]

Commands:
  probe       Snapshot the live system and a fresh build, diff them
  discover    List packages the host config declares (JSON)

Options:
  --repo <path>     Config repo (default: current directory)
  --host <name>     nixosConfigurations attribute (default: hostname)
  --user <name>     User to probe (default: current user)
  --against <path>  Old system toplevel (default: /run/current-system)
  --build <path>    Use this toplevel instead of building the repo
  -h, --help        Show this help
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

  const findings = diffT0(oldT0, newT0);
  // a manual probe has no agent commits to attribute T1 changes to
  const changes = await diffT1(oldT1, newT1);
  const files = [
    await writeSnapshot(repo, target.host, "t0", newT0),
    await writeSnapshot(repo, target.host, "t1", newT1),
  ];

  process.stdout.write(`old: ${against}\nnew: ${toplevel}\nsnapshots: ${files.join(", ")}\n\n`);
  process.stdout.write(formatFindings("T0", findings));
  process.stdout.write("\n" + formatFindings("T1", changes));
  for (const c of changes) {
    if (c.detail) process.stdout.write(`\n--- ${c.subject}\n${c.detail}\n`);
  }

  try {
    process.stdout.write("\n" + (await run("nvd", ["diff", against, toplevel])));
  } catch {
    // nvd is wrapped into the package; missing only when run from source
  }
  return findings.some((f) => f.severity === "fail") ? 1 : 0;
}

function formatFindings(tier: string, findings: Finding[]): string {
  if (findings.length === 0) return `${tier}: no differences\n`;
  return findings
    .map((f) => {
      // multi-line details (content diffs) are printed separately
      const detail = f.detail.includes("\n") ? "" : `  ${f.detail}`;
      return `${f.severity === "fail" ? "✗" : "·"} ${f.kind.padEnd(16)} ${f.subject}${detail}`;
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
