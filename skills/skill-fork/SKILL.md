---
name: skill-fork
description: Create or maintain an independent skill that owns its provenance, license, snapshot, and diff. Use for natural-language or explicit fork requests, existing forks, and ambiguous customization requests that need routing among fork, overlay, replacement, and companion.
license: MIT
compatibility: Requires Node.js 18+, npm access, and skill-customization helper contract 1 for deterministic operations.
---

# Skill Fork

A fork owns its customized workflow and provenance snapshot. Route to an overlay when a live source must continue supplying upstream changes, or to a companion when the new skill only calls or consumes the source. `replace` is a separately confirmed activation choice with deterministic host precedence; otherwise use a distinct coexist name.

## Workflow

1. Inventory installed skills and customization artifacts before asking questions. Treat an existing descriptor, `CUSTOMIZATION.md`, snapshot, and diff as stored intake. When an explicit fork request conflicts with a required live upstream relationship, explain the mismatch and confirm the switch before routing to `/skill-overlay`. **Gate:** the workflow type and existing/new branch are unambiguous.
2. For a new or materially changing customization, read and follow [Fork intake](references/intake.md). Routing and intake do not require the helper. **Gate:** the user has confirmed one complete customization brief.
3. Select a contract-1 helper before the first deterministic operation. **Gate:** one exact helper package version is fixed for the run.
4. Execute the matching branch below. Treat the source as read-only and write only inside the fork or local state paths. **Gate:** every branch criterion is satisfied or the result stops with one actionable next step.

## Select the helper

Verify Node.js 18+ and npm, then run `skill-customization supports 1`. Accept only exit `0` with JSON reporting `compatible: true`, `requested_contract: "1"`, `supported_contracts` containing `"1"`, and a non-empty `package_version`. Record that exact version and use the verified installed executable for the rest of the run.

If the command is unavailable or incompatible, explain that `npx` may download `skill-customization@latest` and reuse npm's cache, then obtain permission. After approval, run `npx --yes skill-customization@latest supports 1`. If compatible, use `npx --yes skill-customization@<package_version> <command>` for every remaining command in this run.

Stop with concise setup or compatibility guidance when Node/npm is missing, permission is declined, the result is malformed, or contract 1 is unsupported. Read the [CLI reference](https://github.com/samitoyang/skill-customization/blob/main/docs/cli.md) after selecting the helper when choosing commands or handling a stopped result.

## Existing fork

1. Validate the descriptor, owned snapshot, diff, license, and review checkpoint. **Gate:** every provenance artifact is present and owned by the fork.
2. Reconcile without a live source. **Gate:** the result is `fork-ready`, the diff reproduces the owned payload, and the report includes fingerprints and license evidence.

## New fork

1. Store a relative snapshot and unified diff, then write the confirmed `CUSTOMIZATION.md`, entrypoint, and v1 descriptor. A directory snapshot keeps `SKILL.md` at its root. **Gate:** the diff applies to the snapshot and reproduces every owned payload file.
2. Validate provenance and activation, then reconcile without a runtime source. **Gate:** the result is `fork-ready` and reports the snapshot, diff, fingerprints, targets, and license.

Keep snapshot and diff paths relative to the fork and free of symlinks. Stop for incomplete provenance, an unreproducible payload, or unresolved activation collision, and report the exact next action.
