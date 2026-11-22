# NixOS Flake Updater Agent — Spec v2

Nov 19, 2026 · @kha · supersedes "NixOS Flake Updater Agent — Spec" (Nov 18)

## Overview and goals

`flake-agent` is a local agent, written in TypeScript on the Claude Agent SDK, that keeps a NixOS flake up to date without manual work. It is shipped as a Nix flake that exports a package and a NixOS module. Once enabled on a host, it runs weekly: it checks that the Claude subscription is usable, updates the lock, fixes config breakage, checks that everything installed and configured still behaves the same, and switches automatically when the safety checks pass.

Goals:

- **Unattended by default.** A normal update needs no input from me.
- **Generic.** Works for any single-host NixOS flake with home-manager as a NixOS module. No hard-coded repo paths, users or program lists.
- **Behaviour, not just builds.** Everything installed and configured is probed; heavily customised tools (Neovim/nvf, zsh, tmux, Alacritty) get deep behaviour probes.
- **Adopt the new way.** When upstream breaks something, the agent moves to the new idiomatic approach instead of stopping to ask.
- **Never silent.** Every behaviour change, skip or block is reported once, where I will see it.
- **Always reversible.** Each change can be undone with one command; NixOS generations remain the outer safety net and are never garbage-collected below a minimum.
- **Safe against prompt injection.** Untrusted text the agent reads must not be able to gain root or plant code.
- **No wasted runs.** If the Claude subscription is unusable, nothing starts and I decide when to retry.

## Context: the first target host

The design is generic; v1 is built and tested against `~/Repos/nixos-config` on host `laptop`:

| Fact | Consequence for the design |
| --- | --- |
| Flake inputs: `nixpkgs` (nixos-unstable), `home-manager`, `nvf`, `alacritty-theme` | Sources allowlist is derived from `flake.lock`, not hard-coded |
| home-manager is a NixOS module (`useGlobalPkgs`, `useUserPackages`) | One `nix build` of the toplevel contains user binaries under `etc/profiles/per-user/<user>/bin` and HM-generated files |
| Config spread across `hosts/laptop/`, `modules/`, `home/laptop/programs/*.nix`; zsh and Alacritty use raw dotfiles (`dotfiles/.zshrc`, `dotfiles/.alacritty.toml`) | Discovery by evaluation, write scope by denylist, not by path allowlist |
| `/etc/nixos` → `/home/khamui/Repos/nixos-config` | Agent cannot work in my home; it uses its own clone |
| XFCE on X11 with lightdm; logind `IdleHint` never set | Idle comes from `xprintidle` in a user-level helper |
| `nix.gc` deletes generations older than 7 days | Module enforces a minimum number of kept generations |
| Real breakage on Oct 14, 2026: nvf `languages.ts` → `languages.typescript` (mechanical), `tailwind` removed (behaviour), `typescript-language-server` pnpm `outputHash` override added in `hosts/laptop/configuration.nix` | Agent must be able to edit host config; hash overrides must always need review; this breakage is the acceptance fixture |
| A second host `nixos` exists in the repo | Out of scope; I remove it from the repo by hand before v1 |

## Scope and non-goals

In scope:

- One host per install: the machine the module is enabled on, built from a flake output `nixosConfigurations.<host>`
- NixOS + home-manager-as-NixOS-module configs, in any repo layout
- Subscription preflight, lock updates, config fixes, probes, guard, automatic switch, report, undo

Not in scope (v1):

- Multiple hosts per install, remote hosts, CI/CD
- Standalone home-manager (non-NixOS-module) setups
- Wayland idle detection (planned; the idle source is a pluggable interface in the user helper)
- Project dev shells
- Pushing to a remote; the agent commits locally, pushing stays manual
- Upstreaming to nixpkgs

## Packaging

The updater lives in its own repo (`~/Repos/tooling/flake-updater`), which is a flake:

```text
flake-updater/
├── flake.nix               # packages.<system>.default, nixosModules.default, checks
├── module.nix              # services.flake-agent: users, units, timer, sandbox, retention
├── package.nix             # buildNpmPackage
├── package.json / tsconfig.json
├── src/
│   ├── agent/              # Agent SDK app: update → fix → probe loop
│   ├── preflight/          # subscription + environment checks
│   ├── discovery/          # what is installed/configured, via nix eval
│   ├── probes/             # runner, tier logic, validator registry
│   ├── guard/              # deterministic guard, no AI
│   ├── switch/             # root switch service logic, no AI
│   ├── report/             # report, notifications, CHANGES.md
│   └── cli/                # flake-agent command
├── probes/                 # built-in probe scripts (shell, output JSON)
│   └── nvim.sh zsh.sh tmux.sh alacritty.sh
└── test/
    ├── unit/               # vitest
    └── fixtures/           # pinned-lock fixture flakes
```

Runtime: Node 22, `@anthropic-ai/claude-agent-sdk`, compiled with `tsc`, packaged with `buildNpmPackage`. One package, several entry points (`flake-agent`, `flake-agent-guard`, `flake-agent-switch`, `flake-agent-user`). Runtime deps (`nvd`, `git`, `xprintidle`, `libnotify`, `tmux`, …) are wrapped into the package's `PATH`, not assumed on the host.

A host enables it:

```nix
# flake.nix
inputs.flake-updater.url = "github:khamui/flake-updater";

# host config
imports = [ inputs.flake-updater.nixosModules.default ];
services.flake-agent = {
  enable = true;
  repo = "/home/khamui/Repos/nixos-config";
  host = config.networking.hostName;   # flake output to build
  user = "khamui";                     # whose HM config/session to probe and notify
  intervalDays = 7;                    # counted from the last run, manual ones included
  model = "claude-sonnet-5-5";
  escalationModel = "claude-opus-5-5";
  minGenerations = 5;
};
```

**The tool never updates itself.** The `flake-updater` input is excluded from the agent's `nix flake update`. I bump it by hand (`nix flake update flake-updater`). The guard blocks any agent-produced lock change to that input.

### Per-repo state

Everything specific to my setup lives in the config repo, under `.flake-agent/`:

```text
nixos-config/.flake-agent/
├── PREFERENCES.md          # my standing rules; read-only for the agent
├── CHANGES.md              # report history, newest first
├── changes/<id>/           # notes.md + keep-old.patch per behaviour change
├── snapshots/<host>/       # probe snapshots (JSON/text), committed
└── probes/                 # optional custom probes for this repo
```

## Architecture

An unprivileged agent proposes changes; a deterministic guard and a root switch service with no AI decide what reaches the live system.

```text
timer ─▶ preflight ─✗─▶ notify: "retry now / next cycle"
             │✓
             ▼
        agent (flake-agent user, sandbox)
          nix flake update → build → probes ─▶ fix loop (≤3) ─▶ commits on agent/update-<date>
             │
             ▼
        switch service (root, no AI)
          re-runs guard on exact commit ─✗─▶ branch stays, "needs review"
             │✓
          wait for idle (≤24h) → switch | boot
             │
          post-switch user probes ─✗─▶ rollback + notify
             │✓
          hand commit to my repo as agent/applied → report
```

| Component | Runs as | AI | Job |
| --- | --- | --- | --- |
| Timer | systemd | No | Weekly, `Persistent=true`, AC only, 60-minute cap |
| Preflight | `flake-agent` | Minimal ping | Credential, subscription usable, AC, disk, lock |
| Agent | `flake-agent`, sandboxed | Yes | `nix flake update`, build, run probes, fix breakage, one commit per change, prepare `keep-old.patch` |
| Probes | `flake-agent` (build), me via user unit (live) | No | Snapshot behaviour of everything installed/configured, diff old vs new |
| Guard | inside the switch service, on the exact commit | No | Block security-relevant, input, hash or code-injection changes; enforce diff size |
| Switch service | root | No | Build + switch the approved commit when idle, roll back on failure, retention |
| User helper | me (systemd user unit) | No | Idle time, notifications with actions, live probes, fetch `agent/applied` into my repo |
| CLI | me | No | `run status show revert probe report retry skip` |

The guard is run by the root switch service against the exact commit hash it is about to build, not trusted from a verdict file written by the agent user. The agent may run the guard itself as a dry run to know early whether it will pass.

### Repo topology

- The agent works in its own clone at `/var/lib/flake-agent/repo`. Its unit gets a read-only bind mount of `<repo>/.git` (`BindReadOnlyPaths=`) and fetches `main` from it at the start of each run. Uncommitted changes in my working tree are ignored.
- Each run creates branch `agent/update-<YYYY-MM-DD>` from my current `main`. It never commits to `main`.
- The switch service builds `nixosConfigurations.<host>` from the exact approved commit in the agent clone (`git+file:///var/lib/flake-agent/repo?rev=<sha>`).
- After a successful switch, the user helper fetches that commit into my repo as branch `agent/applied` and fast-forwards `main` **only** if my working tree is clean and `main` has not moved since the run started. Otherwise the report says "main diverged — merge `agent/applied` by hand".
- Root never writes into my working tree.
- **Diverged `main`.** If `main` moved while an earlier branch was pending or needs review, the next run does not rebase: it starts over from the new `main`. The old branch is kept and marked `superseded`.

## Preflight

Nothing runs before preflight passes: no `nix flake update`, no build, no probes.

Checks, in order:

1. **Credential present.** The subscription token (`claude setup-token`) is passed via systemd `LoadCredential=` and is non-empty.
2. **Subscription usable.** One minimal Agent SDK call on the run's configured model: tiny prompt, `maxTurns: 1`, no tools. The result is mapped to a reason:

   | SDK outcome | Reason shown |
   | --- | --- |
   | auth error | Not logged in or token expired — run `claude setup-token` |
   | billing / plan error | Subscription inactive or not paid |
   | rate limit / quota | Quota exhausted, resets ~`<time>` (if known) |
   | overloaded / 5xx / network | Claude API unreachable |
   | success | — |

3. **Environment.** On AC power, ≥ 10 GB free on `/nix`, no other run holding the lock file.

On failure:

- Notification via the user helper: `notify-send` with the reason and two actions, **Retry now** and **Next cycle**.
- The same choice appears once in the next interactive shell and in `flake-agent status`; `flake-agent retry` and `flake-agent skip` do the same from the CLI.
- **Default if I do nothing: next cycle** (next weekly timer). No automatic retries.
- Each retry runs the full preflight again; a repeat failure shows the same prompt.

**Mid-run quota loss.** If the subscription becomes unusable during a run, the agent stops immediately, marks the branch `interrupted`, switches nothing and notifies me with the same retry choice. The next run starts fresh from `main`; interrupted branches are kept for inspection, not resumed.

## Discovery

The tool learns what is installed and configured by evaluating the host's config, never by guessing paths:

- `environment.systemPackages`, `users.users.<user>.packages`, `home-manager.users.<user>.home.packages`
- Every `programs.*.enable == true` in NixOS and in `home-manager.users.<user>`
- Generated files: HM `home.file` / `xdg.configFile` targets and NixOS `environment.etc` keys

Discovery runs on both the current generation's config (old lock) and the new build (new lock), so added and removed programs show up in the diff.

## Probes

Probes are deterministic and capture behaviour as JSON or text snapshots. The agent never improvises tests; it runs probes and interprets their diff. Probes run against the new build result (`./result/...`), so nothing is switched before they pass.

| Tier | Covers | What it captures | Fails on |
| --- | --- | --- | --- |
| T0 | Every installed package | Binary names and versions per package; `nvd diff` of old vs new closure | Build error; a binary or package disappeared |
| T1 | Every generated config file | Evaluated content of HM and `/etc` files, old vs new | Never fails on its own: changes from agent commits are attributed to them; upstream-only changes are reported as behaviour changes |
| T2 | Every enabled program with a known validator; the rest, when their package names a binary (`meta.mainProgram`) | The program's own check, from the validator registry; else `<binary> --version` with my rendered config (5 s timeout), others listed as unchecked | Any error or new warning; a program that started cleanly now exits non-zero or prints new stderr |
| T3 | Deep behaviour, built in for nvim, zsh, tmux, Alacritty | See below | Any removed or changed keymap/alias/binding, startup error |

Coverage follows the config: every enabled program gets the generic tiers (packages, rendered files) and, where it has an obvious binary, a starts-cleanly check; deep probes are extras (ADR 0001); option values are not probed (ADR 0003). Every deciding comparison builds both sides now and differs in one thing only; committed snapshots are history (ADR 0002).

Validator registry (T2), extendable per repo in `.flake-agent/probes/`:

| Program | Validator |
| --- | --- |
| Alacritty | Launch log with `-e true`; `alacritty migrate --dry-run` |
| tmux | `tmux -f <built conf> -L probe start-server \; list-keys` stderr |
| zsh | `zsh -n` on generated files; stderr of `zsh -i -c exit` |
| Neovim | `nvim --headless +qa` with `:messages` captured |
| git | `git config -l` on generated config |
| starship | `starship print-config` stderr |
| ssh | `ssh -G <host>` for every configured match block |

T3 deep probes:

| Tool | Captures |
| --- | --- |
| Neovim (nvf) | Startup `:messages`; all keymaps per mode via `nvim_get_keymap` (JSON); plugin list; LSP servers that resolve per configured language; treesitter parsers; selected `:checkhealth` |
| zsh | Aliases, function names, `bindkey` output, completion setup, stderr of interactive start |
| tmux | Prefix, `list-keys` per table (incl. vim-tmux-navigator `C-h/j/k/l` bindings), options |
| Alacritty | Generated/linked config file, keyboard bindings, config errors and deprecation warnings |

Rules:

- Snapshots live in `.flake-agent/snapshots/<host>/` and are committed with each change, so a commit shows exactly which keymaps, aliases or bindings changed.
- Old snapshot = current generation; new snapshot = build result. The diff is the agent's main input.
- Probes run in a scratch `HOME` with only the generated HM files, so they don't depend on or touch my real home.
- A regression that slipped through gets a new probe; the registry grows with the setup.
- Probes run by hand too: `flake-agent probe` (live system, as me).

## Change handling

The agent adopts the new idiomatic way by default and records every change as its own commit, with a prepared way back for behaviour changes.

| Class | Example (real, Oct 14) | Agent action |
| --- | --- | --- |
| Mechanical | nvf `languages.ts` → `languages.typescript` | Fix automatically, mention in report |
| Behaviour change | nvf `tailwind` language removed | Adopt the new way (or remove), prepare the old-way alternative, report prominently |
| Needs review | `outputHash` override for `typescript-language-server` | Commit on branch; guard blocks auto-switch; report with reason |
| Blocked | Upstream bug, removed plugin with no replacement, probes still red after fixes | Leave on branch, notify, no switch |

Rules:

- **Branch and commits.** One branch per run, `agent/update-<date>`: first the lock commit, then one commit per change. Author `flake-agent <flake-agent@<host>>`. Trailers: `Change-Id: <slug>-<YYYY-MM>`, `Change-Class: mechanical|behaviour|review|blocked`, `Upstream: <link>`. The message says what changed upstream, what changed in my setup, and which behaviours differ.
- **Prepared alternative.** For every behaviour change the agent also writes, builds and probes the closest old-behaviour version and stores it as `.flake-agent/changes/<id>/keep-old.patch`. It is not applied.
- **Fix loop limit.** At most 3 fix/rebuild/probe iterations per regression. Iterations 1–2 use `model`; iteration 3 uses `escalationModel`. Still red → blocked.
- **Partial updates.** If one input is blocked, the agent may pin only that input to its previous revision and update the rest.
- **Upstream-only changes.** A behaviour difference caused by the new lock alone (e.g. a changed default, or a T1 config file that differs without any agent edit) is not a failure. It gets a report entry with an `upstream-<kind>-<subject>-<month>` id and no commit; the run records it in `.flake-agent/changes/<id>/notes.md` for `show <id>` (with the file's diff for T1). T1 leaves out changes that only swap store paths or the NixOS version (T0 covers packages), and files with the same change are one entry (`etc/pam.d/ (18 files)`). If I want the old behaviour back, `flake-agent revert <id>` gets an agent-prepared alternative: the old value written explicitly for a default change, an override for a package behaviour change, an input kept at its previous revision for a removed package or binary, only after I confirm (ADR 0003). The request goes to `/run/flake-agent/revert-request.json`, which the agent service reads but can't write, so the agent can't ask for a revert itself; the run handles it once, builds and probes each candidate against `main` built now, and keeps it only if `main` then shows the upstream change again. Not restored within the fix-loop limit: blocked, nothing switched, and the report says so.
- **Obsolete workarounds.** If an override or workaround (e.g. the pnpm hash overlay) is no longer needed, the agent proposes removing it as its own commit; this is guard-flagged like any overlay change.
- **Sources.** Read-only `WebFetch` to: NixOS manual and release notes, home-manager manual and news, and the GitHub repos (releases, CHANGELOG, commits, issues) of the flake's own inputs, derived from `flake.lock`. No `WebSearch`. Enforced by a `PreToolUse` hook, not by the prompt.
- **Preferences.** The agent always reads `.flake-agent/PREFERENCES.md` before deciding.

## Switching policy

- **Who switches:** the switch service (root, no AI), never the agent.
- **When:** only if probes are green and the guard, re-run by the switch service on the exact commit, passes.
- **Idle:** the user helper reports X idle time via `xprintidle`. Switch after 15 minutes idle. If not idle within 24 hours, fall back to `nixos-rebuild boot` (applies on next reboot) and say so in the report.
- **`switch` vs `boot`:** `switch` by default; `boot` when kernel, initrd or systemd changed.
- **Post-switch check:** the user helper reruns user-level probes against the live system. On failure the switch service runs `nixos-rebuild switch --rollback` and I'm notified.
- **Retention:** the module keeps at least `minGenerations` (default 5) system generations regardless of `nix.gc` age rules (GC wrapper deletes old generations but never the last N) and sets `boot.loader.systemd-boot.configurationLimit = 10`. The report names the previous generation.

## Reporting and undo

After each run with a visible outcome I see a short report once.

Where it appears:

- The first interactive shell after the event prints it, then marks it read. Injected by the module via `programs.zsh.interactiveShellInit` (and bash), not by editing my dotfiles.
- A desktop notification via the user helper (`notify-send`, actions where useful): "System updated, 2 changes", "Update needs you", "Update skipped — quota exhausted [Retry now] [Next cycle]".
- Full history in `.flake-agent/CHANGES.md`, newest first.

Example:

```text
System updated (2026-11-25), generation 412 → 413
214 packages changed, 3 config changes

  ⚠ nvf-tailwind-2026-11    tailwind language support removed upstream
  ✓ nvf-ts-rename-2026-11   languages.ts → languages.typescript, no behaviour change
  ⛔ tsls-hash-2026-11       needs review: outputHash override (guard: hash change)

  Details:  flake-agent show nvf-tailwind-2026-11
  Undo:     flake-agent revert nvf-tailwind-2026-11
```

CLI (`flake-agent`):

| Command | What it does |
| --- | --- |
| `run` | Run one update cycle now (preflight first) |
| `retry` | After a skipped/interrupted run: preflight again, then run |
| `skip` | Dismiss a skipped run; wait for the next cycle |
| `status` | Last run, current generation, preflight state, pending/blocked/needs-review changes |
| `show <id>` | Upstream reason, diff, affected behaviour, available alternative |
| `revert <id>` | Apply `keep-old.patch` (or `git revert`), probe, commit, hand to switch service; optionally append a note to `PREFERENCES.md`. An `upstream-…` id asks the agent service instead |
| `probe` | Run all probes against the live system |
| `report` | Show the latest report again |

## Security and hardening

The guard decides from what changed, not from who runs the switch.

**Threat model.** The agent reads untrusted text (changelogs, docs, issues). A prompt injection could make it add an SSH key, a substituter, a systemd service, a `curl | sh` in shell or editor config, or a fixed-output hash pointing at attacker content. The switch service applies commits as root, so removing sudo from the agent alone does not stop this.

**Out of scope:** trust in upstream inputs themselves. `nix flake update` trusts them with or without the agent.

### 1. Privilege separation

- Agent runs as system user `flake-agent`: no sudo, not in `wheel`, no access to `/home`.
- It works in its own clone on its own branch; never `main`.
- The switch service (root, no AI) runs the guard itself and switches only the exact commit it verified.

### 2. Guard on the evaluated config

Compare `nix eval` of (old config + new lock) vs (agent-edited config + new lock). Any difference in these blocks automatic switch:

- `users.users.*`, `users.groups.*`, including `openssh.authorizedKeys`
- `nix.settings` (`substituters`, `trusted-public-keys`, `trusted-users`, `allowed-users`)
- `security.*` (sudo, polkit, PAM, wrappers)
- `services.openssh`, `networking.firewall`, `networking.nameservers`, `networking.hosts`, `networking.wg-quick`
- Names of `systemd.services`, `systemd.timers`, `systemd.user.services`
- `boot.*`, `environment.etc` keys, `system.activationScripts`
- `nixpkgs.overlays` (count and source positions)
- HM: `programs.ssh.*`, `home.activation`, `systemd.user.*`

**Why this is not noisy.** Both sides of the comparison use the *new* lock and differ only in the agent's edits. My own edits are already in `main` (the baseline), and upstream default changes appear on both sides, so neither triggers the guard. It fires only when an agent edit changes the evaluated value of a guarded option.

**Compare rendered output where it exists.** For options that render a file (`programs.ssh` → `~/.ssh/config`, `networking.hosts` → `/etc/hosts`, `environment.etc.*`), the guard compares the rendered file, not the option tree. A pure rename, such as home-manager moving top-level `programs.ssh` settings under `matchBlocks."*"`, renders the same file and passes. A rename that changes the output (a new `Host` block, a different `IdentityFile`, a new `ProxyCommand`) blocks and goes to "needs review". An occasional review is cheap; a silently changed `ProxyCommand` is a way in.

### 3. Frozen inputs and lock integrity

- The `inputs` block of `flake.nix` must be byte-identical before and after the agent's commits.
- `flake.lock` may only change via `nix flake update`: every `original` stays the same, no new top-level inputs, and `flake-updater` is unchanged.

### 4. Write scope (denylist)

Any file in the repo may be edited **except**:

- `flake.nix` `inputs` block, hand edits to `flake.lock`
- `**/hardware-configuration.nix`
- `.flake-agent/PREFERENCES.md` (only `flake-agent revert`, run by me, appends)
- The `services.flake-agent` config block

Per-host `allow`/`deny` overrides in the module. Enforced by SDK `PreToolUse` hooks and `allowedTools`, and re-checked by the guard on the final diff.

Bash allowlist: `nix build`, `nix eval`, `nix flake update` (with the self-input excluded), `nvd`, probe runner, `git` on its own branch. No `sudo`, no `nixos-rebuild`, no `push`, no `reset --hard` on `main`.

### 5. Executable-code and hash flags

The guard scans the agent's diff and blocks auto-switch on new occurrences of:

- Code execution: `curl`, `wget`, `nc`, `ssh`, `base64`, `eval`, `source` of new paths, `vim.fn.system`, `vim.system`, `os.execute`, `io.popen`, `jobstart`, `run-shell`, `if-shell`
- Fetch/hash: `outputHash`, `hash`, `sha256`, `vendorHash`, `npmDepsHash`, `pnpmDeps`, `fetchurl`, `fetchFromGitHub`, `fetchgit`, `builtins.fetch*`, `overrideAttrs` touching `src`
- Embedded config growth: `extraConfig`, `extraLuaConfig`, `luaConfigRC`, `initContent`, `interactiveShellInit` blocks grown by more than a few lines

Existing occurrences (e.g. `eval "$(starship init zsh)"`) are not flagged; only additions.

### 6. Diff size limit

Auto-switch only if the agent's diff is ≤ 60 changed lines, excluding `flake.lock` and `.flake-agent/snapshots/`.

### 7. Process sandbox

Agent unit: `User=flake-agent`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `BindReadOnlyPaths=<repo>/.git`, `ReadWritePaths=/var/lib/flake-agent`, `PrivateTmp=true`, `PrivateDevices=true`, `CapabilityBoundingSet=`, `RestrictSUIDSGID=true`, `LoadCredential=claude-token:<path>`. Network is open at the systemd level; domain restriction for the agent is enforced by the `WebFetch` hook.

### When the guard blocks

The change stays on its branch, the report marks it "needs review" with the guard's reason, and I get a notification. Nothing is switched.

## Scheduling and secrets

- Runs every `intervalDays` (7), counted from the last cycle however it started: a manual `flake-agent run` or a retry moves the next one. A systemd timer checks hourly (`Persistent=true`, `ConditionACPower=true`); `flake-agent status` shows the time left (`Next run: in 5 d 23 h 41 min (Sat 28 Nov, 14:05)`).
- One run at a time (lock file); run cancelled after 60 minutes
- Claude subscription token from `claude setup-token`, stored as a root-owned file outside the Nix store and the repo, passed via `LoadCredential=`. No sops/agenix in v1.

Module options cover: `repo`, `host`, `user`, `intervalDays` (7), `model`, `escalationModel`, `maxFixIterations` (3), `diffLimit` (60), `idleMinutes` (15), `idleFallbackHours` (24), `minGenerations` (5), `minFreeGB` (10), `writeScope.allow/deny`, `extraSources`, `tokenFile`.

## Testing

- **Unit (vitest):** guard rules (each flag and option class), lock integrity, discovery parsing, preflight error mapping, probe diff classification, write-scope hook.
- **Fixture flake:** a small flake pinned to the pre–Oct 14 lock of nvf/nixpkgs, reproducing `languages.ts` rename, `tailwind` removal and the pnpm hash mismatch.
- **Injection tests**, two suites, both opt-in:
  - `test/injection`: each malicious outcome committed directly; the guard must block it, whatever the agent does.
  - `test/injection-agent`: a real update run on a fixture whose input's release notes ask for an SSH key, a substituter, a new input, a `curl` alias, an `outputHash` or a `ProxyCommand`. Per case the suite reports which layer stopped it: a hook refusal, the agent not applying it, the guard, or the run blocking. None may switch. An agent that ignores the instruction is a good sign but no proof; the proof is the first suite. `INJECT_AGENT=scripted` runs it with an agent that follows every instruction, at no API cost.

## Implementation plan

Deterministic parts first; the agent comes last and wraps them.

1. **Flake skeleton + package.** `flake.nix`, `package.nix` (buildNpmPackage), TS project, vitest, CLI stub.
   - Done when: `nix build` produces `flake-agent --help`; `nix flake check` runs unit tests.
2. **Discovery + probes.** Eval-based discovery; T0–T3 runner; validator registry; snapshot + diff; `flake-agent probe`.
   - Done when: current system vs fresh build of the same commit gives an empty diff on `laptop`.
3. **Guard.** Eval comparison, frozen inputs + lock integrity, write-scope check, exec/hash flags, diff limit.
   - Done when: test commits adding an SSH key, a substituter, a new input, a `curl` alias and an `outputHash` change are each blocked.
4. **Preflight.** Credential, SDK ping with error mapping, environment checks, retry/skip state.
   - Done when: an invalid token and a simulated quota error each stop the run before any `nix` command and show the retry prompt.
5. **Module: users, units, switch service, user helper.** `flake-agent` user, sandbox, timer, idle via `xprintidle`, notifications with actions, switch/boot policy, post-switch probes, rollback, retention, `agent/applied` handoff.
   - Done when: a manual green commit switches when idle; a forced post-switch failure rolls back; GC keeps ≥ 5 generations.
6. **Agent.** SDK app with tool/Bash allowlists, `PreToolUse` hooks (write scope, WebFetch domains), update → fix → probe loop, model escalation, classification, per-change commits, `keep-old.patch`, mid-run quota handling.
   - Done when: on the Oct-14 fixture the agent produces a branch with a mechanical commit, a behaviour commit with working `keep-old.patch`, and a needs-review hash commit.
7. **Reporting + CLI.** Shell hook, notifications, `CHANGES.md`, `show` / `revert` / `status` / `retry` / `skip` / `report`.
   - Done when: `flake-agent revert <id>` restores the old behaviour and probes confirm it.
8. **Hardening review.** Run both injection suites on `laptop`.

## Resolved decisions (Nov 19)

- Diverged `main` → start over from the new `main`; old branch marked `superseded`.
- Upstream-only behaviour changes → reported as behaviour changes, never a probe failure.
- Wayland idle → planned after v1, behind the pluggable idle interface.
- Token expiry → detected only by preflight failure; no advance warning.
- Guard on `programs.ssh` / `networking.hosts` → kept, compared on rendered files.

## Unresolved questions

- None open.
