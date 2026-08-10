# Descriptor v1

`customization.json` is portable. It records stable identity and reviewed provenance; concrete source paths, credentials, bindings, caches, and host visibility stay in local state.

Required top-level fields are `schema_version`, stable URI `id`, `type`, `name`, own `license`, `entrypoint`, `customization`, `dependencies`, `owned_payload`, `source`, and `activation`. `owned_payload.reviewed_fingerprint` covers every runtime-owned file except `customization.json` and reserved `provenance/` and rejects symlinks. The `entrypoint` and `customization` runtime selectors must name files inside that reviewed payload using canonical, dot-free relative paths, never either case-insensitively reserved path.

Full sources use the repository or local variant and record a license plus the reviewed, symlink-free full-directory `effective_fingerprint`. A local source identity is derived separately from its `SKILL.md` bytes. Repository sources also record canonical repository, upstream entrypoint, and review revision. A customization source records stable ID, type, name, license, and effective fingerprint; its concrete directory comes only from the current context binding. A verified fork may be a source.

`coexist` requires a name different from `source.skill_name`. `replace` requires the source name and `customization-first` precedence plus separate binding confirmation.

Forks add a relative, symlink-free snapshot directory and diff path with reviewed fingerprints. A full-source snapshot directory must match `source.effective_fingerprint`. Forking an overlay source instead requires `materialization`: source-chain effective fingerprint, concrete snapshot fingerprint, review time, and evidence. Read [Discovery and bindings](discovery-and-bindings.md) for concrete resolution and [Reconciliation](reconciliation.md) for maintenance decisions.
