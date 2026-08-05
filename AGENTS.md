# Agent instructions

Keep descriptors portable and binding state local. Reuse the library seams for normalization, discovery, manager metadata, fingerprints, bindings, reconciliation, and atomic writes.

- Support Node.js 18+ without runtime dependencies.
- Test public behavior with `node:test`; add one vertical slice at a time.
- Resolve repository identity only from discovery evidence, and search declared roots plus bounded workspace ancestors.
- Treat resolved sources as read-only; write reconciliation state inside the customization or local state paths.
- Keep `SKILL.md`, eval prompts, and handoff text concise; link shared references for detail.
- Run `npm run verify` before committing.

When changing descriptors, discovery, bindings, or reconciliation, read [CONTEXT.md](CONTEXT.md) for the domain vocabulary.
