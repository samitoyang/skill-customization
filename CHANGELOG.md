# Changelog

All notable changes to this project are documented here.

## Unreleased

- Add helper contract 1 and the public `skill-customization supports <contract>` compatibility check.
- Freeze contract-1 descriptors, state readability, fingerprints, discovery/binding semantics, CLI outputs and exits, and reconciliation statuses with named regression tests and golden fixtures.
- Replace exact helper-version coupling in both published skills with confirmed intake, contract negotiation, and an exact-version on-demand run after compatibility succeeds.
- Add complete-path, name-only, idea-only, empty, existing-artifact, and model-mismatch intake behavior for overlay and fork workflows.
- Expand user documentation with reported pain points, prerequisites, slash invocation, required-input examples, and legacy exact-pin compatibility guidance.

## 0.1.0 - 2026-08-05

- Add the Node.js library and CLI for portable customization descriptors, bounded source discovery, local bindings, fingerprints, reconciliation, and atomic state.
- Add the independently installable `skill-overlay` and `skill-fork` agent skills.
- Add descriptor schema, manager adapters, and GitHub Actions verification.
