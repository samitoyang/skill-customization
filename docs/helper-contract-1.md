# Helper contract 1

Contract 1 is the compatibility boundary between the published skills and the helper. A package may report support only while every behavior below remains compatible.

## Public surface

| Command | Positionals and options |
| --- | --- |
| `supports` | `<contract>` |
| `validate` | `<customization.json>`; optional `--inventory` |
| `fingerprint` | `<path>` |
| `discover` | optional name, repository, or path; repeatable `--root`; optional `--custom-path` |
| `bind` | `<customization.json>`; required `--source` and `--context`; optional `--scope`, `--state`, and repeatable `--root` |
| `resolve` | `<customization.json>`; required `--context`; optional `--state` and repeatable `--root` |
| `reconcile` | `<customization.json>`; overlay `--context`; optional `--state`, repeatable `--root`, `--cache`, `--decision`, `--evidence`, and repeatable `--absorbed-delta`; `--source` remains a rejected bypass |
| `help` | no arguments; top-level `-h`/`--help` and `-v`/`--version` remain available |

- Keep these commands, positionals, option multiplicities, and validation meanings compatible. Reconciliation decisions remain `compatible`, `absorbed`, `incompatible`, and `ambiguous`.
- Write structured results to standard output and diagnostics to standard error. Preserve exit `0` for success, `1` for invalid input or operational failure, and `2` for a safe reconciliation stop.
- Accept and validate descriptor schema v1. Keep binding stores with `version: 1` and compatibility caches with `version: 1` readable.
- Preserve file, ordered-files, directory-tree, and local-identity fingerprint algorithms and their `sha256:` representation.

## Resolution and reconciliation

- Resolve repository identity only from discovery evidence. Search declared roots plus bounded workspace ancestors, retain provenance conflicts, and require confirmation before the first binding.
- Keep concrete source paths and binding/cache state local. Resolve an overlay from its confirmed context binding; a direct source override cannot bypass it.
- Preserve activation semantics: `coexist` uses a distinct name, while `replace` requires the source name, deterministic customization-first precedence, active-copy checks, and separate confirmation.
- Preserve reconciliation statuses `compatible`, `ambiguous-drift`, `absorbed-delta`, `incompatible`, and `fork-ready`, including their stopped/unstopped meanings. A fork remains verifiable from its owned snapshot and diff without a runtime source.

The permanent `helper contract 1:` regression tests and `test/fixtures/contract-v1` goldens enforce this surface. A deliberate incompatible change requires a new contract; package version changes alone do not.
