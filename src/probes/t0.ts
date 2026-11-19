import type { Store } from "../nix/store.js";
import { parseDrvName, storeName, storeRoot } from "../nix/storePath.js";

/** buildEnv profiles that aggregate packages; T0 descends into them. */
const ENV_NAMES = new Set(["system-path", "user-environment", "home-manager-path"]);

export interface T0Snapshot {
  tier: "T0";
  /** pname → sorted versions (several when multiple outputs are installed). */
  packages: Record<string, string[]>;
  /** profile → binary name → owning store name. */
  binaries: Record<string, Record<string, string>>;
}

export interface Finding {
  severity: "fail" | "info";
  kind: string;
  subject: string;
  detail: string;
}

function profiles(toplevel: string, user: string): Record<string, string> {
  return {
    system: `${toplevel}/sw`,
    [`user:${user}`]: `${toplevel}/etc/profiles/per-user/${user}`,
  };
}

async function collectPackages(store: Store, root: string, into: Set<string>): Promise<void> {
  const name = storeName(root);
  if (name && ENV_NAMES.has(name)) {
    for (const ref of await store.references(root)) {
      if (ref !== root) await collectPackages(store, ref, into);
    }
  } else if (name) {
    into.add(name);
  }
}

/** Snapshot installed packages and binaries of a system toplevel (live or built). */
export async function snapshotT0(store: Store, toplevel: string, user: string): Promise<T0Snapshot> {
  const names = new Set<string>();
  const binaries: T0Snapshot["binaries"] = {};

  for (const [profile, link] of Object.entries(profiles(toplevel, user))) {
    const env = storeRoot(await store.resolve(link));
    if (!env) continue;
    await collectPackages(store, env, names);

    const bins: Record<string, string> = {};
    for (const bin of (await store.list(`${env}/bin`)).sort()) {
      const owner = storeName(await store.resolve(`${env}/bin/${bin}`));
      if (owner) bins[bin] = owner;
    }
    binaries[profile] = bins;
  }

  const packages: T0Snapshot["packages"] = {};
  for (const name of names) {
    const { pname, version } = parseDrvName(name);
    (packages[pname] ??= []).push(version);
  }
  for (const versions of Object.values(packages)) versions.sort();

  return { tier: "T0", packages: sortKeys(packages), binaries };
}

/** Old vs new: removed packages or binaries fail, everything else is informational. */
export function diffT0(old: T0Snapshot, next: T0Snapshot): Finding[] {
  const findings: Finding[] = [];

  for (const [pname, versions] of Object.entries(old.packages)) {
    const now = next.packages[pname];
    if (!now) {
      findings.push({ severity: "fail", kind: "package-removed", subject: pname, detail: versions.join(", ") });
    } else if (versions.join() !== now.join()) {
      findings.push({ severity: "info", kind: "package-version", subject: pname, detail: `${versions.join(", ")} → ${now.join(", ")}` });
    }
  }
  for (const [pname, versions] of Object.entries(next.packages)) {
    if (!old.packages[pname]) {
      findings.push({ severity: "info", kind: "package-added", subject: pname, detail: versions.join(", ") });
    }
  }

  for (const [profile, bins] of Object.entries(old.binaries)) {
    const now = next.binaries[profile] ?? {};
    for (const [bin, owner] of Object.entries(bins)) {
      const nowOwner = now[bin];
      if (!nowOwner) {
        findings.push({ severity: "fail", kind: "binary-removed", subject: `${profile}/${bin}`, detail: owner });
      } else if (parseDrvName(owner).pname !== parseDrvName(nowOwner).pname) {
        findings.push({ severity: "info", kind: "binary-owner", subject: `${profile}/${bin}`, detail: `${owner} → ${nowOwner}` });
      }
    }
    for (const bin of Object.keys(now)) {
      if (!bins[bin]) {
        findings.push({ severity: "info", kind: "binary-added", subject: `${profile}/${bin}`, detail: now[bin]! });
      }
    }
  }
  return findings;
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
