# Agent instructions

Keep descriptors portable and binding state local. Reuse the library seams for normalization, discovery, manager metadata, fingerprints, bindings, reconciliation, and atomic writes.

- Support Node.js 22.14+ without runtime dependencies.
- Test public behavior with `node:test`; add one vertical slice at a time.
- Resolve repository identity only from discovery evidence, and search declared roots plus bounded workspace ancestors.
- Treat resolved sources as read-only; write reconciliation state inside the customization or local state paths.
- Keep `SKILL.md`, eval prompts, and handoff text concise; link shared references for detail.
- Run `npm run verify` before committing.

When changing descriptors, discovery, bindings, or reconciliation, read [CONTEXT.md](CONTEXT.md) for the domain vocabulary.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Uses a single-context layout: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
