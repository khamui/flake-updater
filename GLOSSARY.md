# flake-agent

An unattended updater for a NixOS flake configuration: it updates the lock, fixes what breaks, and reports what behaves differently.

## Changes

**Change**:
One logical edit the agent commits on a run's branch, identified by its Change-Id and labelled with one class.
_Avoid_: fix, patch

**Behaviour change**:
A change after which something the user notices works differently; it carries a keep-old patch.

**Keep-old patch**:
The closest old-behaviour alternative to a behaviour change, stored next to it and applied only by a revert.
_Avoid_: rollback patch

**Revert**:
The user undoing one change on `main`, through the guard and switch service like any update.
_Avoid_: rollback (a rollback returns to the previous system generation)

**Upstream-only change**:
A difference caused by the new lock alone: the user's config and the agent's edits don't explain it.

**Default change**:
An upstream-only change where an option's effective value differs while its definition in the repo doesn't.

**Package behaviour change**:
An upstream-only change in what a package does, with no option involved (e.g. a plugin changing a keymap).

**Removed feature**:
An upstream-only change where something is gone (a binary, a plugin) and only keeping the input back restores it.

## Probes

**Probe**:
A check of one aspect of a built system, compared between two systems that differ in one thing only.
_Avoid_: test

**Snapshot**:
A committed probe result: history to read, never the baseline for a decision.
