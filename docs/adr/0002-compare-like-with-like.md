---
status: accepted
---

# Compare like with like: one variable, both sides built now

Every comparison that decides something builds both sides from the same tree at the moment it runs, and lets only one thing differ:

| Comparison | The one difference |
| --- | --- |
| Update run | `main` + old lock vs `main` + new lock |
| `show` / `revert` | `main` with the change vs `main` without it, same lock |

Committed snapshots are history to read, never the baseline for a decision.

We chose this because the user edits the config between cycles, and only agent runs write snapshots. A stored "before" snapshot can predate those edits, an older lock, or both. With such a snapshot, `revert` refused correct reverts, or listed dozens of upstream differences as "not restored". That happened in the fixture: 35 of them, from a snapshot taken on the older lock.

## Considered options

- **Keep reading stored snapshots, and caveat when the lock differs** (the first version of `revert`). Rejected because a stale snapshot is wrong in both directions: it misses the user's own edits, and it mixes in upstream changes.
- **Write a snapshot on every commit to `main`** (e.g. from the helper). Rejected: it costs a build per user commit and still isn't atomic with the comparison.

## Consequences

- `revert` and `show`'s "affected behaviour" each cost one extra build (mostly cached) and a probe pass.
- Snapshots remain for `show`'s history and the report. Code that decides must not read them.
