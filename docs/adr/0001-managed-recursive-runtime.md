# ADR 0001: Managed recursive customization runtime

## Status

Accepted for descriptor v1 and helper contract 1 before the first public release.

## Decision

Generated customization entrypoints are thin dispatchers. They negotiate helper contract 1 and run helper-owned preflight before any runtime instruction. Ready plans execute directly; stopped, unavailable, or incompatible helper states delegate to exactly one maintenance skill.

Preflight owns recursive overlay traversal, cycle/depth protection, reviewed payload checks, context binding resolution, effective fingerprints, and base-to-inner-to-outer execution ordering. Reconciliation owns only targeted semantic and provenance decisions.

Overlay `CUSTOMIZATION.md` is a semantic delta. Fork `CUSTOMIZATION.md` is the complete independent workflow; a fork is a runtime leaf with a directory-scoped snapshot. Concrete source paths remain local bindings. Fork tracking is optional and advisory. Forking an overlay chain requires reviewed materialization evidence before diffing.

## Consequences

Ready invocation avoids model-driven maintenance overhead and never runs unchecked. Recursive composition becomes deterministic and auditable. Portable descriptors carry more reviewed fingerprints and licenses, while local state carries all machine-specific resolution. Accepted maintenance updates fingerprints atomically and must pass a fresh preflight.
