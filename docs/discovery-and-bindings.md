# Discovery and bindings

Discovery accepts a name, repository/subdirectory URL, local skill directory, or `SKILL.md`. Evidence is ordered: explicit input, containing Git, manager metadata, embedded or adjacent metadata, then user confirmation. Conflicting provenance remains visible and equivalent copies retain every path, owner, and copy-specific evidence so a confirmation cannot pair one copy with another copy's provenance.

The checkpointed registry in `src/skill-root-registry.js` is the exhaustive list of Vercel project and personal roots, environment-based homes, and preserved legacy paths. Discovery also includes Claude `additionalDirectories`, `COPILOT_SKILLS_DIRS`, manager-owned roots, bounded workspace ancestors, and explicit custom roots. The picker ends with a custom-path choice; it never falls back to a home or sibling crawl.

Each physical root is scanned once. `owner` remains the canonical ownership label; `owners` lists every agent or manager associated with a shared root.

Bindings live under `$XDG_STATE_HOME/skill-customization/bindings.json` or `~/.agents/skill-customization/bindings.json`. Keys combine customization ID with host/workspace context. Personal and manager roots are global; project, ancestor, and host-added roots are workspace-scoped. A custom path needs a scope choice. Symlink bindings record alias and canonical target, and retargeting invalidates them.

State updates use atomic replacement plus a cross-process owner lock. A live lock is never stolen; an abandoned owner fails closed with the exact lock path for explicit recovery.
