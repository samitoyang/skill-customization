---
name: skill-overlay
description: Create or maintain a live-source skill customization that keeps receiving upstream improvements. Use for natural-language overlay requests, existing overlay maintenance stops, and ambiguous customization requests that need routing among overlay, fork, replacement, and companion.
license: MIT
compatibility: Requires Node.js 22.14+ and skill-customization helper contract 2; npm only for the on-demand fallback.
---

# Skill Overlay

An overlay keeps a live source workflow and adds one semantic delta. Generated overlay `SKILL.md` files are thin dispatchers: they run checked preflight and execute its ordered steps without invoking this maintenance skill when status is `ready` or `ready-with-advisory`.

## Workflow

1. Inventory installed skills and adjacent customization metadata. For an existing overlay execution request, try the dispatcher fast path before intake. **Gate:** one descriptor and current host/workspace context are identified, or the request is classified as new maintenance work.
2. Select one contract-2 helper, then run `skill-customization preflight <customization.json> --context <context>`. **Gate:** the result is checked and no runtime file has executed early.
3. On `ready`, follow every execution step in order. On `ready-with-advisory`, report the advisory and follow the same steps. If preflight names another maintenance handler, delegate to it. **Gate:** execution completes from the checked plan or stops at one handler.
4. For `maintenance-required`, explicit maintenance, or creation, use the matching branch below. Treat the source as read-only and write only inside the customization or local state paths. **Gate:** accepted changes are recorded atomically and preflight reruns `ready` or `ready-with-advisory`, or the result stops with one action.

## Select the helper

Run `skill-customization supports 2`. Accept only exit `0` with JSON reporting `compatible: true`, `requested_contract: "2"`, `supported_contracts` containing `"2"`, and a non-empty `package_version`. Use that installed executable for this run.

An installed compatible helper requires Node.js only. If unavailable or incompatible, resolve this skill's real path and inspect only its bounded Git ancestors. Treat a clean checkout whose `origin` URL normalizes to `https://github.com/samitoyang/skill-customization` and whose root package is named `skill-customization` as a local candidate, not authenticated code. Report its canonical root, origin, and commit; explain that `npx --package` will execute its local code without downloading it; and obtain permission to use it for this run. After approval, run `npx --yes --package <checkout-root> skill-customization supports 2`. When compatible, confirm its origin, commit, and clean state before each remaining command.

Otherwise explain that `npx` may download `skill-customization@latest` and reuse npm's cache, then obtain permission. After approval, run `npx --yes skill-customization@latest supports 2`; when compatible, use `npx --yes skill-customization@<package_version> <command>` for the remaining commands. Stop with setup guidance if Node.js is missing, if either fallback requires npm and npm is missing, if permission is declined, if output is malformed, if the local candidate changes, or if contract 2 is unsupported. A dispatcher delegates here when installed preflight is unavailable or incompatible; it never runs unchecked.

## Maintain an overlay

Use the preflight handler reason to focus reconciliation on the stopped overlay. Review source drift against the semantic delta, repair bindings or owned-payload drift, and decide absorbed or incompatible changes explicitly. After acceptance, run `skill-customization accept-maintenance` with the reviewed source effective fingerprint when it changed, then rerun preflight. Activation resumes only from `ready` or `ready-with-advisory`.

## Create an overlay

Read [Overlay intake](references/intake.md), confirm one brief, then create:

- run `skill-customization render-dispatcher semantic-overlay` with only the approved frontmatter and write its output to `SKILL.md` unchanged. Never compose, paraphrase, extend, or repair the dispatcher body;
- `CUSTOMIZATION.md` containing only the semantic delta;
- a portable v1 descriptor with reviewed owned-payload and full-source or customization-source effective fingerprints;
- one confirmed context-scoped source binding.

Route to `skill-fork` when runtime independence is required, and to a companion when the new skill only calls or consumes the source. `replace` requires separate confirmation and deterministic customization-first precedence.
