---
name: skill-overlay
description: Create or maintain a live-source skill customization that keeps receiving upstream improvements. Use for natural-language or explicit overlay requests, existing overlays, and ambiguous customization requests that need routing among overlay, fork, replacement, and companion.
license: MIT
compatibility: Requires Node.js 18+, npm access, and skill-customization helper contract 1 for deterministic operations.
---

# Skill Overlay

A semantic overlay preserves a live source workflow and adds a documented delta. Route to a fork when the result must run without the source, or to a companion when it only calls or consumes the source. `replace` is a separately confirmed activation choice with deterministic host precedence; otherwise use a distinct coexist name.

## Workflow

1. Inventory installed skills and customization artifacts before asking questions. Treat an existing descriptor, `CUSTOMIZATION.md`, and binding as stored intake. When an explicit overlay request conflicts with required independence, explain the mismatch and confirm the switch before routing to `/skill-fork`. **Gate:** the workflow type and existing/new branch are unambiguous.
2. For a new or materially changing customization, read and follow [Overlay intake](references/intake.md). Routing and intake do not require the helper. **Gate:** the user has confirmed one complete customization brief.
3. Select a contract-1 helper before the first deterministic operation. **Gate:** one exact helper package version is fixed for the run.
4. Execute the matching branch below. Treat the source as read-only and write only inside the customization or local state paths. **Gate:** every branch criterion is satisfied or the result stops with one actionable next step.

## Select the helper

Verify Node.js 18+ and npm, then run `skill-customization supports 1`. Accept only exit `0` with JSON reporting `compatible: true`, `requested_contract: "1"`, `supported_contracts` containing `"1"`, and a non-empty `package_version`. Record that exact version and use the verified installed executable for the rest of the run.

If the command is unavailable or incompatible, explain that `npx` may download `skill-customization@latest` and reuse npm's cache, then obtain permission. After approval, run `npx --yes skill-customization@latest supports 1`. If compatible, use `npx --yes skill-customization@<package_version> <command>` for every remaining command in this run.

Stop with concise setup or compatibility guidance when Node/npm is missing, permission is declined, the result is malformed, or contract 1 is unsupported. Read the [CLI reference](https://github.com/samitoyang/skill-customization/blob/main/docs/cli.md) after selecting the helper when choosing commands or handling a stopped result.

## Existing customization

1. Validate the descriptor, resolve its confirmed binding, and reconcile the live source. **Gate:** reconciliation reports `compatible` and `stopped: false`.
2. Follow the live source workflow and apply `CUSTOMIZATION.md`. **Gate:** every stored delta and source completion criterion is satisfied.

## New customization

1. Write the confirmed `CUSTOMIZATION.md`, entrypoint, and v1 descriptor. **Gate:** provenance is portable and every referenced artifact is owned by the customization directory.
2. Confirm the context-scoped binding, validate, and reconcile. **Gate:** the result is unstopped and reports the confirmed source, scope, fingerprints, and evidence.

Stop for a missing source, ambiguous drift, absorbed delta, or unresolved activation collision, and report the exact next action.
