# Helper contract 1

Contract 1 is the compatibility boundary retained for dispatchers generated before canonical rendering joined the lifecycle. A package reports support only while this behavior remains compatible. New dispatchers and customization creation use [helper contract 2](helper-contract-2.md).

| Command | Contract-1 behavior |
| --- | --- |
| `supports` | Report structured compatibility for one contract. |
| `validate` | Validate descriptor v1, owned relative artifacts, and runtime selectors covered by the owned-payload fingerprint. |
| `fingerprint` | Fingerprint exact files or symlink-free directory trees; a top-level alias resolves to its canonical target, and case-insensitive `.git`, `.hg`, and `.svn` metadata is excluded at any depth. |
| `payload-fingerprint` | Fingerprint runtime-owned files, excluding descriptor, `provenance/`, and version-control metadata, while rejecting symlinks. |
| `discover` | Search evidence-backed declared roots plus bounded ancestors and classify adjacent customizations. |
| `bind` / `resolve` | Confirm or resolve context-local concrete source bindings. |
| `reconcile` | Make one targeted overlay semantic or fork provenance decision. |
| `preflight` | Flatten a checked recursive execution graph for one descriptor and context. |
| `accept-maintenance` | Canonically contain its lock, durably publish an accepted fork diff at an immutable content-addressed path, then atomically and durably commit its path and fingerprint with the refreshed payload, source, snapshot, and materialization review state in the descriptor while preserving portable artifact modes; refresh the source effective fingerprint only when explicitly supplied, require paired review time/evidence only for materialization, and require both fresh review time and evidence when materialization fingerprints change. |

Structured results go to standard output and diagnostics to standard error. Preflight exits `0` for `ready` and `ready-with-advisory`, `2` for `maintenance-required`, and `1` for malformed input or operational failure. A maintenance result contains no executable steps and exactly one actionable handler.

Preflight preserves these invariants: full-source effective fingerprints; local identities derived from `SKILL.md` bytes; customization-source stable identity; runtime selectors covered by the reviewed owned payload; effective fingerprints that bind the selected execution file and role; a complete ordered plan containing the base/fork workflow then inner-to-outer deltas for pre-action composition; cycle checks by stable ID and canonical path; depth limit 32; fork runtime-leaf behavior; and advisory-only optional fork tracking in every activation mode. Replacement intent and customization-first precedence are confirmed without making a source binding or source availability a runtime gate.

Binding stores and compatibility caches retain `version: 1`. Fingerprints use lowercase `sha256:` values. Portable descriptors never contain concrete source paths. The named `helper contract 1:` tests and `test/fixtures/contract-v1` goldens enforce the public surface.
