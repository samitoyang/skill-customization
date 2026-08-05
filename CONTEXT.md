# Domain context

- **Customization**: a stable descriptor plus an entrypoint and documented delta.
- **Semantic overlay**: a customization reconciled against a live source at runtime.
- **Fork**: a customization that owns its provenance snapshot and diff.
- **Source**: the original skill identity; repository review data is a checkpoint, not a pin.
- **Activation**: `coexist` uses a distinct name; `replace` uses the source name with deterministic host precedence.
- **Discovery evidence**: explicit input, containing Git, manager metadata, embedded metadata, then confirmation.
- **Binding**: local state mapping customization plus host/workspace context to a concrete source copy.
- **Compatibility cache**: a local semantic result keyed by source and customization-semantics fingerprints.
- **Absorbed delta**: customized behavior now supplied upstream and requiring human review.
