# CLI reference

Run `skill-customization --help` for the authoritative command and option list.

For the complete lifecycle, run `skill-customization supports 2`. Accept only exit `0` and JSON with `compatible: true`, requested contract `2`, supported contracts containing `2`, and a non-empty package version. If the installed command is unavailable or incompatible, resolve the active maintenance skill's real path and inspect only its bounded Git ancestors. Treat a clean checkout whose `origin` normalizes to `https://github.com/samitoyang/skill-customization` and whose root package is named `skill-customization` as a local candidate, not authenticated code. Report its canonical root, origin, and commit, explain that `npx --package` will execute local code without a download, and obtain permission before running it. Confirm the recorded state before each remaining command. Otherwise explain that the registry fallback may download code or reuse npm cache and obtain permission before running it. Helper `v0.1.1` also supports contract 1 for existing dispatchers.

Runtime dispatch uses:

```sh
skill-customization payload-fingerprint <directory>
skill-customization preflight <customization.json> --context <context>
```

After contract-2 selection, create the dispatcher through the canonical renderer:

```sh
skill-customization render-dispatcher <semantic-overlay|fork> --name <name> --description <text>
```

Optional approved metadata flags are `--license`, `--compatibility`, repeatable `--metadata key=value`, `--allowed-tools`, `--argument-hint`, `--disable-model-invocation true|false`, and `--user-invocable true|false`. The command writes the complete Markdown to standard output and accepts no dispatcher body or runtime-policy inputs. It is a thin adapter over the library renderer; [ADR 0001](adr/0001-managed-recursive-runtime.md) is the rationale for canonical thin dispatchers and pre-execution composition.

Preflight outputs `effectiveFingerprint`, ordered `steps` (`role`, concrete `path`, `root`, `customizationId`), `advisories`, and one `maintenanceHandler` or `null`. `ready` and `ready-with-advisory` exit `0`; `maintenance-required` exits `2` with no executable steps; malformed descriptors/metadata and operational failures exit `1`.

Full-directory fingerprints follow a top-level source alias to its canonical target, exclude clone-local `.git`, `.hg`, and `.svn` metadata at any depth, and reject symlinks inside the remaining target tree. Validation requires real, canonical runtime files and rejects symlinks, empty or dot segments, line separators, trailing dots/spaces, alternate-data-stream separators, and any filesystem alias whose resolved target is reserved `customization.json`, `provenance/`, or version-control metadata.

Maintenance remains explicit. `reconcile` targets one semantic or provenance decision and preflights a customization source to obtain its checked effective fingerprint and ordered execution plan. After acceptance, `accept-maintenance` refreshes the owned-payload fingerprint, the source effective fingerprint only when explicitly supplied, and fork snapshot/diff fingerprints. `--diff-file` durably publishes an accepted fork diff under an immutable content-addressed path; one atomic, durable descriptor replacement then commits the matching path and review state while preserving the existing descriptor and prior diff modes. `--reviewed-at` and `--evidence` must be supplied together and are valid only for a fork with an overlay-chain materialization; both `--reviewed-at` and `--evidence` are required when either materialization fingerprint changes. The maintenance lock is canonically contained in owned `provenance/`, and local state remains private. Always rerun preflight before activation.

Discovery is bounded and evidence-based. Concrete source paths are written only by `bind`; direct source overrides cannot bypass an overlay binding. Fork bindings are optional tracking state and never runtime requirements.
