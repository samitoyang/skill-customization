# Reconciliation

An overlay must resolve a confirmed live-source binding for its context. Its review hash is SHA-256 over the exact reviewed source entrypoint bytes. A matching checkpoint is compatible; a changed fingerprint needs semantic assessment. The source and customization entrypoint/instructions are fingerprinted independently, and compatible assessments are cached only for that pair without rewriting the descriptor.

Ambiguous drift stops activation. If upstream has absorbed a documented delta, reconciliation flags that delta and stops for human review. Source files are read-only inputs.

A fork validates and fingerprints its owned snapshot, diff, and entrypoint. A directory snapshot has `SKILL.md` at its root. The diff is a non-empty unified diff that applies cleanly to the snapshot and reproduces the owned fork content; unrelated or mismatched diffs stop validation. A fork reports provenance without resolving a runtime source.

Read [Descriptor v1](descriptor-v1.md) when a stop is caused by invalid provenance fields. Read [Discovery and bindings](discovery-and-bindings.md) when an overlay cannot resolve its confirmed source.
