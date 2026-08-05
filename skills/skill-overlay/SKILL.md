---
name: skill-overlay
description: Create or maintain a live-source customization that keeps receiving upstream improvements. Use for indirect or explicit overlay requests, existing overlays, or ambiguous requests that must be routed among overlay, fork, replacement, and companion.
license: MIT
compatibility: Requires Node.js 18+ and npm access to skill-customization@0.1.0.
---

# Skill Overlay

A semantic overlay preserves a live source workflow and adds a documented delta. Use a fork when the customization must run without that source. Build a companion when the new skill only calls or consumes the source. Use `replace` only for an intentionally same-named customization with deterministic host precedence and separate confirmation.

Before the first deterministic operation, verify Node.js 18+ and npm, then try the installed `skill-customization` command. Use it when `skill-customization --version` reports `0.1.0`. Otherwise explain that `npx` will download or cache the pinned helper and ask permission. After approval, run `npx --yes skill-customization@0.1.0 <command>`. If permission is declined or Node/npm is unavailable, stop with concise setup guidance; offer `npm install --global skill-customization@latest` only as optional manual setup.

Read the [CLI reference](https://github.com/samitoyang/skill-customization/blob/main/docs/cli.md) when selecting a command or handling a stopped result.

## Existing customization

1. Validate the descriptor, resolve its confirmed binding, and reconcile the live source. **Gate:** reconciliation reports a compatible, unstopped result.
2. Follow the live source workflow and apply `CUSTOMIZATION.md`. **Gate:** every documented delta and source completion criterion is satisfied.

## New customization

1. Discover the concrete local source and resolve every provenance conflict. **Gate:** one source copy and its evidence are confirmed.
2. Confirm the source workflow and requested outcome, then offer two or three collision-free `<source>-<outcome>` names. Ask separately before `replace`. **Gate:** the name and activation mode are confirmed.
3. Write a concise `CUSTOMIZATION.md`, entrypoint, and v1 descriptor. **Gate:** the descriptor contains portable provenance and every referenced artifact exists inside the customization directory.
4. Confirm the context-scoped binding, validate, and reconcile. **Gate:** the result is unstopped and reports the source, scope, fingerprints, and evidence.

Treat the source as read-only; write inside the customization directory. Stop for a missing source, ambiguous drift, or an absorbed delta, and report the exact next action.
