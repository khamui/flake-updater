# NixOS Flake Updater Agent — Spec

Nov 18, 2026 · @kha

## Overview and goals

A local agent, built on the Claude Agent SDK, keeps my NixOS flake up to date without me. It runs on a schedule on my laptop, updates the lock, fixes config breakage, checks that my heavily configured tools still behave the same, and switches automatically when safe checks pass.

Goals:

- **Unattended by default.** A normal update needs no input from me.
- **Behaviour, not just builds.** Neovim (nvf, custom keymaps), zsh and Alacritty must keep working, not only `nixos-rebuild build`.
- **Adopt the new way.** When upstream breaks something, the agent moves to the new idiomatic approach instead of stopping to ask.
- **Never silent.** Every behaviour change is reported once, in a place I will see it.
- **Always reversible.** Each change can be undone with one command; NixOS generations remain the outer safety net.
- **Safe against prompt injection.** Untrusted text the agent reads must not be able to gain root or plant code.

## Scope and non-goals

In scope:

- One NixOS config in its own git repo, built from a flake (system + home-manager, including nvf)
- Running locally on the laptop, triggered by a systemd user timer
- Lock updates, config fixes for breaking changes, behaviour probes, automatic switch, report, undo

Not in scope (for v1):

- CI/CD runs; this is a local tool by design
- Multiple hosts (keep the design open for it, don't build it)
- Project dev shells (separate tool)
- Pushing to a remote; the agent commits locally, pushing stays manual

## Architecture

An unprivileged agent proposes changes; a deterministic guard and a root switch service with no AI decide what reaches the live system.

&#91;embedded content: update run · agent, guard, switch service\]

Red probes loop back to the agent at most 3 times. A guard rejection keeps the work on a branch; a failed post-switch probe rolls back to the previous generation.

| Component | Runs as | AI | Job |
| --- | --- | --- | --- |
| Timer | systemd | No | Starts a run daily, catches up after sleep, only on AC |
| Agent | `flake-agent` user, sandboxed | Yes | `nix flake update`, fix breakage, probe the build, one commit per change, prepare old-way patches |
| Probes | `flake-agent` (build), me (live) | No | Snapshot tool behaviour and diff it |
| Guard | `flake-agent` | No | Block security-relevant, input or code-injection changes; enforce diff size |
| Switch service | root | No | Merge approved commit to `main`, switch when idle, roll back on failure |
| Reporter + CLI | me | No | Show the report once, `show` / `revert` per change |

## Probes

Probes are plain, deterministic scripts in the repo that capture how each tool behaves as JSON or text snapshots. The agent never improvises tests; it runs the probes and interprets their diff. Probes run against the binaries in the new build result (e.g. `./result/.../bin/nvim`), so nothing is switched before they pass.

| Tool | What the probe captures | Fails on |
| --- | --- | --- |
| System | `nvd diff` of old vs new closure; `systemctl --failed` in `build-vm` (optional) | Build error, failed units |
| Neovim (nvf) | Headless start: `:messages` errors/warnings; all keymaps per mode via `nvim_get_keymap` as JSON; plugin list; LSP servers that resolve; treesitter parsers; selected `:checkhealth` output | Any startup error, keymap removed or changed, plugin or LSP missing |
| zsh | stderr of `zsh -i -c exit`; aliases; function names; `bindkey` output; completion setup | Any stderr output, alias/function/binding removed or changed |
| Alacritty | Log of a launch with `-e true` (config errors, deprecation warnings); generated config file | Any config error or warning |

Rules:

- Snapshots live in the repo (`probes/snapshots/`), so a commit shows exactly what changed in keymaps or aliases.
- Old snapshot = current generation; new snapshot = build result. The diff is the agent's main input.
- A regression that slipped through gets a new probe. The suite grows with the setup.
- Probes must be runnable by hand too (`flake-agent probe`), independent of the agent.

## Change handling

The agent adopts the new idiomatic way by default and records every behaviour change as its own commit, with a prepared way back.

| Class | Example | Agent action |
| --- | --- | --- |
| Mechanical | Option renamed, same behaviour | Fix automatically, mention in report |
| Behaviour change | Old behaviour can't be kept 1:1, or only with a hack | Adopt the new way, prepare the old-way alternative, report prominently |
| Blocked | Upstream bug, removed plugin with no replacement, probes still red after fixes | Leave on a branch, notify, no switch |

Rules:

- **One commit per change**, with a stable change ID in a trailer, e.g. `Change-Id: nvf-keymaps-2026-11`. The message says what changed upstream, what changed in my setup, and which keymaps or behaviours differ.
- **Prepared alternative.** For every behaviour change, the agent also writes, builds and probes the closest old-behaviour version and stores it as a patch in `changes/<id>/keep-old.patch`. It is not applied.
- **Fix loop limit.** At most 3 fix/rebuild/probe iterations per regression, then the change is classed as blocked.
- **Partial updates.** If one input is blocked, the agent may pin only that input to its previous revision and update the rest.
- **Sources.** The agent reads only official sources for fixes: nixpkgs release notes and manual, home-manager news and options, nvf docs and changelog.
- **Preferences.** The agent always reads `PREFERENCES.md` (my standing rules, e.g. "keep muscle-memory keymaps when a short, commented workaround exists") before deciding.

## Switching policy

The switch service switches directly when the guard approves and the laptop is idle; NixOS generations are the rollback.

- **Who switches:** the switch service (root, no AI), never the agent.
- **When:** only if probes are green and the guard approved the exact commit. Wait until the session is idle or the screen is locked, so services don't restart mid-work.
- **`switch` vs `boot`:** use `nixos-rebuild switch` by default. Use `nixos-rebuild boot` when the kernel, initrd or systemd itself changed, since those only take full effect after a reboot.
- **Rollback:** a previous generation is always available in the boot menu and via `nixos-rebuild switch --rollback`. The report names the previous generation number.
- **Post-switch check:** after switching, rerun the user-level probes against the live system. If they fail, roll back automatically and notify.

## Reporting and undo

After each switch I see a short report once, with an undo command next to every behaviour change.

Where the report appears:

- The first interactive zsh after the switch prints it, then marks it read
- A desktop notification via `notify-send`: "System updated, 2 changes" or "Update needs you"
- Full history in `CHANGES.md` in the repo, newest first

Example report:

```text
System updated (2026-11-18), generation 412 → 413
214 packages changed, 2 config changes

  ⚠ nvf-keymaps-2026-11    <C-n> in insert mode now handled by blink.cmp
  ✓ alacritty-font-2026-11 renamed option, no behaviour change

  Details:  flake-agent show nvf-keymaps-2026-11
  Undo:     flake-agent revert nvf-keymaps-2026-11
```

CLI (`flake-agent`):

| Command | What it does |
| --- | --- |
| `flake-agent run` | Run one update cycle now (same as the timer) |
| `flake-agent status` | Last run, current generation, pending or blocked changes |
| `flake-agent show <id>` | Upstream reason, diff, affected keymaps/behaviour, available alternative |
| `flake-agent revert <id>` | Apply `keep-old.patch` (or `git revert`), probe, commit, hand to the switch service; optionally add a note to `PREFERENCES.md` |
| `flake-agent probe` | Run all probes against the current system, by hand |
| `flake-agent report` | Show the latest report again |

## Security and hardening

The guard decides from what changed, not from who runs the switch: an agent edit to a security-relevant option, flake input or executable code blocks the automatic switch.

**Threat model.** The agent reads untrusted text (changelogs, docs, release notes). A prompt injection could make it write an SSH key, a substituter, a systemd service, or a `curl | sh` into zsh or Neovim config. Since the switch service applies the agent's commits as root, removing sudo from the agent alone does not stop this.

**Out of scope:** trust in upstream nixpkgs, home-manager and nvf themselves. `nix flake update` already trusts them, with or without the agent.

### 1. Privilege separation

- The agent runs as a dedicated user `flake-agent`: no sudo, not in `wheel`, no access to my home.
- It works in its own git worktree on branch `agent/update-<date>`; it never commits to `main`.
- The switch service (root, no AI) merges a commit to `main` and switches only after the guard passes.

### 2. Guard on the evaluated config

The guard compares `nix eval` output for (old config + new lock) vs (agent-edited config + new lock). Any difference in these options means no automatic switch:

- `users.users.*`, `users.groups.*`, including `openssh.authorizedKeys`
- `nix.settings` (`substituters`, `trusted-public-keys`, `trusted-users`, `allowed-users`)
- `security.*` (sudo, polkit, PAM, wrappers)
- `services.openssh`, `networking.firewall`, `networking.nameservers`
- Names of `systemd.services`, `systemd.timers`, `systemd.user.services`
- `boot.*`, `environment.etc` keys, `system.activationScripts`

### 3. Frozen inputs

The `inputs` block of `flake.nix` must be byte-identical before and after the agent's commits. `flake.lock` may only change through `nix flake update`, not by hand.

### 4. Limited write scope

- File allowlist for agent edits, e.g. `home/nvim/`, `home/zsh/`, `home/alacritty/`, `changes/`, `CHANGES.md`, `probes/snapshots/`. `PREFERENCES.md` is read-only for the agent; only `flake-agent revert`, run by me, appends to it.
- Enforced with SDK `PreToolUse` hooks and `allowedTools`, not prompt instructions.
- Bash allowlist: `nix build`, `nix eval`, `nix flake update`, `nvd`, probe scripts, `git` on its own branch. No `sudo`, no `nixos-rebuild switch`, no `push`, no `reset --hard` on `main`.

### 5. Executable-code flags

User-level config is code (zsh runs on every shell, nvf generates Lua). The guard scans the agent's diff and blocks auto-switch on new occurrences of: `curl`, `wget`, `nc`, `ssh`, `base64`, `eval`, `source` of new paths, `vim.fn.system`, `vim.system`, `os.execute`, `io.popen`, `jobstart`, `extraConfig` / `extraLuaConfig` blocks grown by more than a few lines.

### 6. Diff size limit

Automatic switch only if the agent's diff is small (initial limit: 60 changed lines, outside `flake.lock` and snapshots). Larger diffs stay on the branch for review.

### 7. Process sandbox

The agent runs as a systemd service with: `User=flake-agent`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=<worktree> <state dir>`, `PrivateTmp=true`, `PrivateDevices=true`, `CapabilityBoundingSet=` (empty), `RestrictSUIDSGID=true`. Network allowed for the Anthropic API, `cache.nixos.org`, GitHub and the doc sites in the source list.

### When the guard blocks

The change stays on its branch, the report marks it "needs review" with the guard's reason, and I get a notification. Nothing is switched.

## Repo layout, scheduling and secrets

The updater lives inside the NixOS config repo and is itself declared as a NixOS module.

```text
nixos-config/
├── flake.nix / flake.lock
├── hosts/<thinkpad>/
├── home/{nvim,zsh,alacritty}/
├── PREFERENCES.md          # my standing rules, read by the agent
├── CHANGES.md              # report history, newest first
├── changes/<id>/           # per-change notes + keep-old.patch
├── probes/
│   ├── nvim.sh  zsh.sh  alacritty.sh  system.sh
│   └── snapshots/
└── tools/flake-agent/
    ├── agent/              # Agent SDK app (TypeScript or Python)
    ├── guard/              # deterministic guard, no AI
    ├── cli/                # flake-agent command
    └── module.nix          # users, services, timer, sandbox
```

Scheduling:

- systemd timer, daily, with `Persistent=true` so runs missed during sleep catch up
- `ConditionACPower=true`: no builds on battery
- One run at a time (lock file); a run is cancelled after 60 minutes

Secrets:

- Anthropic API key via sops-nix or agenix, readable only by `flake-agent`; never in the Nix store or the repo

Agent configuration (`tools/flake-agent/config.toml`): model, max fix iterations (3), diff size limit (60 lines), allowed source domains, file allowlist, idle threshold before switching.

## Implementation plan

Build the deterministic parts first; the agent comes last and wraps them.

1. **Probes.** `nvim.sh` (keymaps JSON, startup messages), `zsh.sh`, `alacritty.sh`, `system.sh`; snapshot + diff tooling; `flake-agent probe` by hand.
   - Done when: running against current system and a fresh build of the same commit gives an empty diff.
2. **Guard.** `nix eval` comparison of security options, frozen-inputs check, executable-code scan, diff size limit.
   - Done when: test commits adding an SSH key, a substituter, a new input and a `curl` alias are each blocked.
3. **Switch service and sandbox module.** `flake-agent` user, systemd units, timer, idle detection, post-switch probe with auto-rollback.
   - Done when: a manual green commit switches automatically when idle; a forced post-switch probe failure rolls back.
4. **Agent.** Agent SDK app with tool and Bash allowlists, `PreToolUse` hooks for the file allowlist, the update → fix → probe loop, change classification, per-change commits, `keep-old.patch`.
   - Done when: on a pinned old lock with a known nvf breaking change, the agent produces a green branch with one change commit and a working alternative patch.
5. **Reporting and CLI.** Report in zsh, `notify-send`, `CHANGES.md`, `show` / `revert` / `status`.
   - Done when: `flake-agent revert <id>` restores the old keymap and the probes confirm it.
6. **Hardening review.** Run injection tests: plant instructions in a fake changelog the agent reads and confirm the guard blocks every outcome.

Open questions:

- Agent SDK language: TypeScript or Python?
- Is home-manager a NixOS module in this config, or standalone? This changes how probes find the built binaries.
- Idle signal: logind idle hint, screen lock (e.g. swaylock/hyprlock), or both?
