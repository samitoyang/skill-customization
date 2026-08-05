# Library reference

Use the library when another Node.js tool needs the same descriptor, discovery, binding, fingerprint, reconciliation, or atomic-state behavior as the CLI. The package supports Node.js 18+ and has no runtime dependencies.

Import public functions from `skill-customization`; the package root is the supported API boundary. The JSON Schema is exported as `skill-customization/schema`.

The main seams are:

- descriptor reading and validation;
- normalization, naming, and fingerprints;
- checkpointed host roots, bounded discovery, and manager records;
- context-scoped bindings and active-skill inventory;
- overlay and fork reconciliation;
- locked atomic JSON state updates.

Keep publishable descriptors separate from local paths, credentials, bindings, and compatibility caches. Read [Descriptor v1](descriptor-v1.md) before constructing descriptors, [Discovery and bindings](discovery-and-bindings.md) before resolving sources, and [Reconciliation](reconciliation.md) before activating a customization.
