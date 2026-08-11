# CLI reference

Run `skill-customization --help` for the authoritative command and option list.

For helper selection, run `skill-customization supports 1`. Accept only exit `0` and JSON with `compatible: true`, requested contract `1`, supported contracts containing `1`, and a non-empty package version. If the installed command is unavailable or incompatible, explain that an `npx` fallback may download code or reuse npm cache and obtain permission before running it.

Runtime dispatch uses:

```sh
skill-customization payload-fingerprint <directory>
skill-customization preflight <customization.json> --context <context>
```

Preflight outputs `effectiveFingerprint`, ordered `steps` (`role`, concrete `path`, `root`, `customizationId`), `advisories`, and one `maintenanceHandler` or `null`. `ready` and `ready-with-advisory` exit `0`; `maintenance-required` exits `2` with no executable steps; malformed descriptors/metadata and operational failures exit `1`.

Full-directory fingerprints follow a top-level source alias to its canonical target, exclude clone-local `.git`, `.hg`, and `.svn` metadata at any depth, and reject symlinks inside the remaining target tree. Validation requires real, canonical runtime files and rejects symlinks, empty or dot segments, line separators, trailing dots/spaces, alternate-data-stream separators, and any filesystem alias whose resolved target is reserved `customization.json`, `provenance/`, or version-control metadata.

Maintenance remains explicit. `reconcile` targets one semantic or provenance decision and preflights a customization source to obtain its checked effective fingerprint and ordered execution plan. After acceptance, `accept-maintenance` refreshes the owned-payload fingerprint, the source effective fingerprint only when explicitly supplied, and fork snapshot/diff fingerprints. `--diff-file` durably publishes an accepted fork diff under an immutable content-addressed path; one atomic, durable descriptor replacement then commits the matching path and review state while preserving the existing descriptor and prior diff modes. `--reviewed-at` and `--evidence` must be supplied together and are valid only for a fork with an overlay-chain materialization; both `--reviewed-at` and `--evidence` are required when either materialization fingerprint changes. The maintenance lock is canonically contained in owned `provenance/`, and local state remains private. Always rerun preflight before activation.

Discovery is bounded and evidence-based. Concrete source paths are written only by `bind`; direct source overrides cannot bypass an overlay binding. Fork bindings are optional tracking state and never runtime requirements.
