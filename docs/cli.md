# CLI reference

Run `skill-customization --help` for the authoritative command and option list.

For helper selection, run `skill-customization supports 1`. Accept only exit `0` and JSON with `compatible: true`, requested contract `1`, supported contracts containing `1`, and a non-empty package version. If the installed command is unavailable or incompatible, explain that an `npx` fallback may download code or reuse npm cache and obtain permission before running it.

Runtime dispatch uses:

```sh
skill-customization payload-fingerprint <directory>
skill-customization preflight <customization.json> --context <context>
```

Preflight outputs `effectiveFingerprint`, ordered `steps` (`role`, concrete `path`, `root`, `customizationId`), `advisories`, and one `maintenanceHandler` or `null`. `ready` and `ready-with-advisory` exit `0`; `maintenance-required` exits `2` with no executable steps; malformed descriptors/metadata and operational failures exit `1`.

Maintenance remains explicit. `reconcile` targets one semantic or provenance decision. After acceptance, `accept-maintenance` refreshes the owned-payload fingerprint, the source effective fingerprint only when explicitly supplied, and fork snapshot/diff fingerprints. `--diff-file` supplies an accepted fork diff. For an overlay-chain materialization, both `--reviewed-at` and `--evidence` are required when either materialization fingerprint changes. Updates use atomic file replacement; always rerun preflight before activation.

Discovery is bounded and evidence-based. Concrete source paths are written only by `bind`; direct source overrides cannot bypass an overlay binding. Fork bindings are optional tracking state and never runtime requirements.
