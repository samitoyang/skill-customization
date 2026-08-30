# Changelog

## 0.4.0

### Minor Changes

- [#56](https://github.com/samitoyang/skill-customization/pull/56) [`446a035`](https://github.com/samitoyang/skill-customization/commit/446a035f38965d0245b3af62fa6ab626c79597f3) Thanks [@samitoyang](https://github.com/samitoyang)! - Export `reconcileBoundCustomization` for context-bound library reconciliation.

- [#56](https://github.com/samitoyang/skill-customization/pull/56) [`5d7353c`](https://github.com/samitoyang/skill-customization/commit/5d7353c3ef998f4105854c0c655d1941ee88b9f3) Thanks [@samitoyang](https://github.com/samitoyang)! - Publish the verified emitted ESM library with TypeScript declarations while retaining the legacy CLI path.

## 0.3.0

### Minor Changes

- [#20](https://github.com/samitoyang/skill-customization/pull/20) [`fa693f9`](https://github.com/samitoyang/skill-customization/commit/fa693f9efc60559ba5be6b0b9fecbcd69e0cffd0) Thanks [@samitoyang](https://github.com/samitoyang)! - Discover plugin-backed skills with bounded, manifest-aware provenance across Claude Code, Codex, Gemini CLI, and Cursor.

## 0.2.0

### Minor Changes

- [#7](https://github.com/samitoyang/skill-customization/pull/7) [`db1a4c4`](https://github.com/samitoyang/skill-customization/commit/db1a4c46ed62cfa2f1e8f12050385872b2963e6e) Thanks [@samitoyang](https://github.com/samitoyang)! - Require Node.js 22.14 or newer and automate npm trusted publishing with Changesets 3 and its least-privilege GitHub Actions workflow.

All notable changes to this project are documented here.

## 0.1.1 - 2026-08-15

- Add helper contract 2 as the complete customization lifecycle, including one canonical validated dispatcher renderer with a matching CLI adapter and pre-execution effective-workflow composition.
- Keep helper contract 1 compatible for existing dispatchers while new dispatchers and customization creation require contract 2.

## 0.1.0 - 2026-08-12

- Add the dependency-free Node.js library and CLI for portable descriptor v1 validation, bounded source discovery, local bindings, fingerprints, preflight, reconciliation, and crash-safe atomic maintenance.
- Add helper contract 1 negotiation through `skill-customization supports <contract>`, with stable regression fixtures for descriptors, state, discovery, CLI results, and reconciliation statuses.
- Add recursive overlay preflight with cycle and depth protection, fork runtime leaves, advisory tracking, overlay-chain materialization, checked execution plans, and targeted maintenance handlers.
- Add symlink-free owned-payload and source verification, provenance-contained fork snapshots and diffs, canonical runtime selectors and locks, and clone-local version-control metadata exclusions.
- Add independently installable `skill-overlay` and `skill-fork` workflows with confirmed intake, coexist and replacement activation, helper compatibility checks, and safe maintenance stops.
- Support installed helpers plus permission-gated symlinked-checkout and exact-version registry fallbacks without requiring a global helper installation.
- Support declared host roots, bounded workspace ancestors, configured paths, and metadata from skills v3, ASM, Skills Manager, and skillsmgr without arbitrary filesystem crawling.
- Add the descriptor schema, public ADR and technical references, npm package-surface auditing, Node.js 18/22/24 verification, and GitHub Actions CI for the initial public release.
