# Discovery and bindings

Discovery accepts a name, repository/subdirectory URL, local skill directory, or `SKILL.md`. Evidence order is explicit input, containing Git, manager metadata, embedded metadata, then confirmation. It scans declared roots and bounded workspace ancestors, never a broad home or sibling crawl, and keeps provenance conflicts and every physical copy visible.

Candidates with adjacent `customization.json` are classified as customizations. Malformed adjacent metadata is a visible `MALFORMED_CUSTOMIZATION_METADATA` error; it is never downgraded to an ordinary skill. A customization binding must match the portable stable ID, type, name, and license.

Bindings live under `$XDG_STATE_HOME/skill-customization/bindings.json` or `~/.agents/skill-customization/bindings.json`. Keys combine customization ID with host/workspace context. They alone contain concrete source paths. A local source identity derives from `SKILL.md` bytes while its effective checkpoint covers the full directory. A top-level symlink binding records its alias and canonical target, and retargeting invalidates it; the fingerprinted target tree rejects internal symlinks.

An overlay requires a confirmed live binding for each context. A fork needs no runtime binding; an optional confirmed tracking binding only produces advisories when the source drifts, disappears, or its state is unreadable or invalid. No tracking binding is silent.

State updates use atomic replacement and a cross-process owner lock. A live lock is never stolen; abandoned ownership fails closed for explicit recovery. Customization maintenance canonically validates its owned `provenance/` directory before acquiring a lock there.
