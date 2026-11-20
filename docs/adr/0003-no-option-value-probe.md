---
status: accepted
---

# No option-value probe: rendered files are the generic layer

We don't probe effective option values. Rendered files (T1) are the generic baseline for settings, and upstream-only findings take their ids from what T0 and T1 report. This amends ADR 0001.

A prototype on the laptop host (#35) read 2,607 option values across 46 enabled programs and services in about 3 s per lock. Every one of the 25 differences it found between two locks also showed in a rendered file: `~/.ssh/config`, nvf's `init.lua`, PAM, `/etc`. All it added was the option path as a name. Getting there took six workarounds: renamed-option aliases, read-only and opaque types, submodules walked as options, disabled sections under an enabled service, catching throws from removed packages, and masking store paths. Nix can't catch an `abort` or a type error, so one bug in any upstream module, even an unused one, kills the whole probe. A new nixpkgs can bring a new one at any time.

A changed value on the same tree doesn't identify a default change either. Home Manager removed `programs.ssh.addKeysToAgent`, so the repo's `"yes"` was ignored and the value became `"no"`. That isn't a default change: the build fails and the agent migrates the option.

## Considered options

- **Keep it and keep adding workarounds.** Rejected: fragile in a way that grows with upstream, for a name T1 almost gives already.
- **Only options the repo defines.** Rejected in ADR 0001. Default changes are the options the repo never mentions.

## Consequences

- Reverting a default change can't write the old value without the agent. All upstream-only reverts are agent-prepared (#37).
- "Starts cleanly" is narrowed to programs with an obvious binary; see #38.
