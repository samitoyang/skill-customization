# ADR 0001: Managed recursive customization runtime

## Status

Accepted for descriptor v1 and helper contract 1 before the first public release. Amended for helper contract 2 and canonical dispatcher rendering in `v0.1.1`.

## Decision

Generated customization entrypoints are thin dispatchers. One pure canonical renderer owns their contract-2 instructions, frontmatter validation and serialization, customization-type-to-maintenance-handler mapping, and effective-workflow loading semantics. Its interface accepts only the customization type and approved skill metadata; the CLI is an adapter over the same interface. Creation workflows supply those inputs and write the returned Markdown unchanged. Repository rationale, helper fallback policy, package versions, source details, concrete paths, and context policy stay outside generated dispatchers.

New dispatchers negotiate helper contract 2 and run helper-owned preflight before any runtime instruction. Helper `v0.1.1` retains contract 1 for existing dispatchers. A ready plan is composed before it is executed: every checked step is loaded first, the workflow is combined with semantic deltas from inner to outer, and later deltas refine earlier instructions. Only that effective workflow executes. An overlay delta is therefore part of pre-execution composition, not a post-execution hook. For stopped, unavailable, or incompatible helper states, Call the Skill tool with exactly one maintenance skill and end before customization instructions load.

Preflight owns recursive overlay traversal, cycle/depth protection, reviewed payload and runtime-selector checks, context binding resolution, symlink-free effective source fingerprints, and base-to-inner-to-outer execution ordering. Reconciliation owns only targeted semantic and provenance decisions; local identity remains entrypoint-derived, and maintenance locks are canonically contained in customization provenance.

Overlay `CUSTOMIZATION.md` is a semantic delta. Fork `CUSTOMIZATION.md` is the complete independent workflow; a fork is a runtime leaf with a directory-scoped snapshot. Concrete source paths remain local bindings. Fork tracking is optional and advisory in every activation mode: no binding is silent, while drift, invalid state, or source unavailability never blocks execution. Replacement intent and customization-first precedence are confirmed during creation without making the source a runtime dependency. Forking an overlay chain requires reviewed materialization evidence before diffing; a verified fork source is already a reviewed runtime leaf.

## Consequences

Ready invocation avoids model-driven maintenance overhead and never runs unchecked. A single renderer makes dispatcher behavior byte-stable across library, CLI, creation skills, and contract fixtures, while its narrow interface keeps policy out of callers. Recursive composition becomes deterministic and auditable. Portable descriptors carry more reviewed fingerprints and licenses, while local state carries all machine-specific resolution. Accepted fork diffs are durably published under immutable content-addressed paths before one atomic, durable descriptor replacement commits the matching paths and fingerprints. Accepted maintenance must pass a fresh preflight.
