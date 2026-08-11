# ADR 0001: Managed recursive customization runtime

## Status

Accepted for descriptor v1 and helper contract 1 before the first public release.

## Decision

Generated customization entrypoints are thin dispatchers. They negotiate helper contract 1 and run helper-owned preflight before any runtime instruction. Ready plans execute directly; stopped, unavailable, or incompatible helper states delegate to exactly one maintenance skill.

Preflight owns recursive overlay traversal, cycle/depth protection, reviewed payload and runtime-selector checks, context binding resolution, symlink-free effective source fingerprints, and base-to-inner-to-outer execution ordering. Reconciliation owns only targeted semantic and provenance decisions; local identity remains entrypoint-derived, and maintenance locks are canonically contained in customization provenance.

Overlay `CUSTOMIZATION.md` is a semantic delta. Fork `CUSTOMIZATION.md` is the complete independent workflow; a fork is a runtime leaf with a directory-scoped snapshot. Concrete source paths remain local bindings. Fork tracking is optional and advisory in every activation mode: no binding is silent, while drift, invalid state, or source unavailability never blocks execution. Replacement intent and customization-first precedence are confirmed during creation without making the source a runtime dependency. Forking an overlay chain requires reviewed materialization evidence before diffing; a verified fork source is already a reviewed runtime leaf.

## Consequences

Ready invocation avoids model-driven maintenance overhead and never runs unchecked. Recursive composition becomes deterministic and auditable. Portable descriptors carry more reviewed fingerprints and licenses, while local state carries all machine-specific resolution. Accepted fork diffs are durably published under immutable content-addressed paths before one atomic, durable descriptor replacement commits the matching paths and fingerprints. Accepted maintenance must pass a fresh preflight.
