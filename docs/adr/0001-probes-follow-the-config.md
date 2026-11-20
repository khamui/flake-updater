---
status: accepted, amended by ADR 0003
---

# Probes follow the config

What gets probed comes from what the config declares, not from a list we maintain. Every enabled program or service gets a generic baseline:
- its packages and binaries (T0);
- its rendered files (T1);
- ~~the effective value of each of its options~~ (dropped, see ADR 0003);
- a check that it still starts cleanly.

Deep probes (keymaps, aliases, bindings, LSP attachment) stay as pluggable extras, used only where the rendered config isn't the behaviour, as with neovim's Lua runtime or zsh plugins. We chose this because the config gains packages and settings between update cycles all the time. With a fixed probe list, anything new is covered only at T0/T1, and changes to effective settings go unseen.

Effective option values also give **upstream-only changes** a precise definition and an identity: the user's definition is unchanged, the evaluated value differs, and the option path names the change. A default change can then be reverted by writing the old value, without the agent.

_Amended (ADR 0003): option values proved too fragile to probe generically; upstream-only ids come from T0/T1 findings, and every upstream-only revert is agent-prepared._

## Considered options

- **Keep extending the built-in probe list** (T2 validators, T3 deep probes). Rejected because every new program waits for someone to write a probe.
- **Track only options the repo defines.** Rejected because upstream default changes are exactly what slips through; the repo never mentions them.

## Consequences

- Option values must be cleaned before they can be compared: packages, functions and submodules don't serialise as JSON. HM options live under `home-manager.users.<user>`. How generic this can be is the first thing to prototype.
- More findings per run. A changed effective value that no agent edit caused is reported as upstream-only, not as a failure, so the fix loop doesn't grow.
- "Starts cleanly" runs the program's own binary inside the probe sandbox.
