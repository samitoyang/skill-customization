# Descriptor v1

`customization.json` contains only publishable identity and provenance. Paths are relative to the customization folder; bindings, absolute paths, authentication, and visibility are local state.

Required fields are `schema_version`, stable URI `id`, `type`, customized `name`, `entrypoint`, `customization`, `dependencies`, `source`, and `activation`.

A repository source records its URL, upstream entrypoint, license, and review checkpoint. A local source records a generated `local:sha256:` identity. Private repositories still use the repository variant.

`coexist` requires a customized name different from `source.skill_name`. `replace` requires the same name and `customization-first` precedence; binding also asks for explicit replacement confirmation. Forks add relative `fork.snapshot` and `fork.diff` paths.

Read [Discovery and bindings](discovery-and-bindings.md) when selecting the concrete local source. Read [Reconciliation](reconciliation.md) when interpreting review checkpoints or validating a fork payload.
