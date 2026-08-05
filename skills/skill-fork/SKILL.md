---
name: skill-fork
description: Create or maintain an independent skill that owns its provenance, license, snapshot, and diff. Use for indirect or explicit fork requests, existing forks, or ambiguous requests that must be routed among fork, overlay, replacement, and companion.
license: MIT
compatibility: Requires Node.js 18+ and npm access to skill-customization@0.1.0.
---

# Skill Fork

A fork owns the customized workflow and its provenance snapshot. Use a semantic overlay when the live source must keep supplying upstream changes. Build a companion when the new skill only calls or consumes the source. Use `replace` only for an intentionally same-named customization with deterministic host precedence and separate confirmation.

Before the first deterministic operation, verify Node.js 18+ and npm, then try the installed `skill-customization` command. Use it when `skill-customization --version` reports `0.1.0`. Otherwise explain that `npx` will download or cache the pinned helper and ask permission. After approval, run `npx --yes skill-customization@0.1.0 <command>`. If permission is declined or Node/npm is unavailable, stop with concise setup guidance; offer `npm install --global skill-customization@latest` only as optional manual setup.

Read the [CLI reference](https://github.com/samitoyang/skill-customization/blob/main/docs/cli.md) when selecting a command or handling a stopped result.

## Existing fork

1. Validate the descriptor, owned snapshot, diff, license, and review checkpoint. **Gate:** every provenance artifact is present and owned by the fork.
2. Reconcile without a live source. **Gate:** the diff applies to the snapshot, reproduces the owned fork payload, and the report includes all fingerprints and license evidence.

## New fork

1. Discover and review the source, license, and requested outcome. **Gate:** its identity, review checkpoint, and redistribution terms are confirmed.
2. Confirm fork independence, then offer two or three collision-free `<source>-<outcome>` names. Ask separately before `replace`. **Gate:** the name and activation mode are confirmed.
3. Store a relative snapshot and unified diff that applies to it and reproduces the fork. A directory snapshot keeps `SKILL.md` at its root. Write a concise `CUSTOMIZATION.md`, entrypoint, and v1 descriptor. **Gate:** every owned artifact exists inside the fork and the diff reproduces its payload.
4. Validate provenance and activation, then verify without a runtime source. **Gate:** the result is unstopped and reports the snapshot, diff, fingerprints, and license.

Treat the source as read-only; write inside the fork directory. Keep every snapshot and diff path relative to the fork and free of symlinks. Stop when provenance is incomplete, the diff does not reproduce the owned payload, or replacement is ambiguous, and report the exact next action.
