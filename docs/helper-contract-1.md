# Helper contract 1

Contract 1 is the compatibility boundary between generated dispatchers, maintenance skills, and the helper. A package reports support only while this behavior remains compatible.

| Command | Contract-1 behavior |
| --- | --- |
| `supports` | Report structured compatibility for one contract. |
| `validate` | Validate descriptor v1 and owned relative artifacts. |
| `fingerprint` | Fingerprint exact files or directory trees. |
| `payload-fingerprint` | Fingerprint runtime-owned files, excluding descriptor and `provenance/`, while rejecting symlinks. |
| `discover` | Search evidence-backed declared roots plus bounded ancestors and classify adjacent customizations. |
| `bind` / `resolve` | Confirm or resolve context-local concrete source bindings. |
| `reconcile` | Make one targeted overlay semantic or fork provenance decision. |
| `preflight` | Flatten a checked recursive execution graph for one descriptor and context. |
| `accept-maintenance` | Atomically refresh explicitly accepted review fingerprints and optional fork diff. |

Structured results go to standard output and diagnostics to standard error. Preflight exits `0` for `ready` and `ready-with-advisory`, `2` for `maintenance-required`, and `1` for malformed input or operational failure. A maintenance result contains no executable steps and exactly one actionable handler.

Preflight preserves these invariants: full-source effective fingerprints; customization-source stable identity; effective fingerprints that bind the selected execution file and role; base/fork workflow then inner-to-outer deltas; cycle checks by stable ID and canonical path; depth limit 32; fork runtime-leaf behavior; and advisory-only optional fork tracking.

Binding stores and compatibility caches retain `version: 1`. Fingerprints use lowercase `sha256:` values. Portable descriptors never contain concrete source paths. The named `helper contract 1:` tests and `test/fixtures/contract-v1` goldens enforce the public surface.
