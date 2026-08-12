---
name: skill-fork
description: Create or maintain an independent skill that owns its complete workflow, provenance, license, snapshot directory, and diff. Use for natural-language fork requests, existing fork maintenance stops, and ambiguous customization requests that need routing among fork, overlay, replacement, and companion.
license: MIT
compatibility: Requires Node.js 18+ and skill-customization helper contract 1; npm only for the on-demand fallback.
---

# Skill Fork

A fork is a runtime leaf whose `CUSTOMIZATION.md` is the complete independent workflow. Generated fork `SKILL.md` files are thin dispatchers: they run checked preflight and execute the returned workflow without invoking this maintenance skill when status is `ready` or `ready-with-advisory`.

## Workflow

1. Inventory installed skills and adjacent customization metadata. For an existing fork execution request, try the dispatcher fast path before intake. **Gate:** one descriptor and current host/workspace context are identified, or the request is classified as new maintenance work.
2. Select one contract-1 helper, then run `skill-customization preflight <customization.json> --context <context>`. **Gate:** the result is checked and no runtime file has executed early.
3. On `ready`, follow the workflow step. On `ready-with-advisory`, report the optional tracking advisory and run the fork unchanged; adoption or rebase remains explicit. If preflight names another maintenance handler, delegate to it. **Gate:** execution completes from the checked plan or stops at one handler.
4. For `maintenance-required`, explicit maintenance, or creation, use the matching branch below. Treat the source as read-only and write only inside the fork or local state paths. **Gate:** accepted changes are recorded atomically and preflight reruns `ready` or `ready-with-advisory`, or the result stops with one action.

## Select the helper

Run `skill-customization supports 1`. Accept only exit `0` with JSON reporting `compatible: true`, `requested_contract: "1"`, `supported_contracts` containing `"1"`, and a non-empty `package_version`. Use that installed executable for this run.

An installed compatible helper requires Node.js only. If unavailable or incompatible, resolve this skill's real path and inspect only its bounded Git ancestors. Treat a clean checkout whose `origin` URL normalizes to `https://github.com/samitoyang/skill-customization` and whose root package is named `skill-customization` as a local candidate, not authenticated code. Report its canonical root, origin, and commit; explain that `npx --package` will execute its local code without downloading it; and obtain permission to use it for this run. After approval, run `npx --yes --package <checkout-root> skill-customization supports 1`. When compatible, confirm its origin, commit, and clean state before each remaining command.

Otherwise explain that `npx` may download `skill-customization@latest` and reuse npm's cache, then obtain permission. After approval, run `npx --yes skill-customization@latest supports 1`; when compatible, use `npx --yes skill-customization@<package_version> <command>` for the remaining commands. Stop with setup guidance if Node.js is missing, if either fallback requires npm and npm is missing, if permission is declined, if output is malformed, if the local candidate changes, or if contract 1 is unsupported. A dispatcher delegates here when installed preflight is unavailable or incompatible; it never runs unchecked.

## Maintain a fork

Use the preflight handler reason to focus provenance or owned-payload repair. Verify the complete workflow against its snapshot directory and diff. After acceptance, run `skill-customization accept-maintenance`; pass `--diff-file` when the reviewed diff changed, and pass both `--reviewed-at` and `--evidence` when either materialization fingerprint changes. Never pass the review flags for any fork without `materialization`. Rerun preflight before activation.

An optional confirmed tracking binding is advisory only: absence is silent; drift and unavailability never block; unreadable or invalid optional tracking state remains advisory. Adoption and rebase are explicit maintenance requests.

## Create a fork

Read [Fork intake](references/intake.md), confirm one brief, then create:

- a thin `SKILL.md` dispatcher that negotiates contract 1, runs preflight, follows only ready steps, and delegates every stopped/unavailable-helper case to `skill-fork`;
- `CUSTOMIZATION.md` containing the complete independent workflow;
- a relative, symlink-free snapshot directory and unified diff beneath reserved `provenance/` that reconstruct every runtime-owned file;
- a portable v1 descriptor with own/source licenses, reviewed owned-payload, snapshot, diff, and source effective fingerprints.

When the source is an overlay chain, materialize its checked base-plus-deltas result as a snapshot directory and record the chain effective fingerprint, concrete snapshot fingerprint, review time, and review evidence before diffing. A verified fork may be the source of another customization. Route to `skill-overlay` for automatic upstream changes and to a companion when the source behavior remains unchanged.
