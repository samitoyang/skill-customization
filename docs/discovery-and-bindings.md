# Discovery and bindings

## Discovery contract

Discovery accepts a name, repository/subdirectory URL, local skill directory, or `SKILL.md`. Evidence order is explicit input, containing Git, plugin or marketplace metadata, manager metadata, embedded metadata, then confirmation. It scans declared roots, bounded workspace ancestors, and documented plugin roots; it never performs a broad home or sibling crawl. Provenance conflicts and every physical copy remain visible. A malformed or unfingerprintable sibling is isolated in `candidateDiagnostics` instead of blocking valid candidates; an explicitly selected invalid candidate still fails with its specific error.

When callers omit roots, plugin discovery is enabled by default. Explicit roots remain authoritative, and deterministic callers may disable plugin discovery with `includePlugins: false`.

## Plugin skill roots

Plugin discovery is manifest-aware and limited to documented host paths:

- Claude Code: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills`, marketplace installation roots, and `~/.claude/skills/synced` when `CLAUDE_CODE_SYNC_SKILLS=1`.
- Codex: `$CODEX_HOME/plugins/<plugin>/skills`, `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/skills`, local marketplace roots declared by `$CODEX_HOME/config.toml`, the personal `~/.agents/plugins/marketplace.json` with `~/plugins/<plugin>`, synchronized `$CODEX_HOME/.tmp/plugins` marketplaces, bundled `$CODEX_HOME/.tmp/bundled-marketplaces/<marketplace>` snapshots, and plugin locations declared by bounded workspace `.agents/plugins` marketplace manifests.
- Gemini CLI: `${GEMINI_CLI_HOME:-~/.gemini}/extensions/<extension>/skills`.
- Cursor: `~/.cursor/plugins/local/<plugin>/skills` and other manifest-declared local plugin roots.

Host adapters may declare custom skill directories through supported manifests, including Codex's `.codex-plugin/plugin.json`. Every valid copy under an exact plugin path is eligible, including multiple cache versions. Discovery does not choose a latest version. Identical fingerprints are grouped into one candidate; conflicting fingerprints or provenance identities remain separate. A cache version describes the evidence but does not identify the source.

Plugin-only sources receive a local plugin identity for grouping and diagnostics. That identity never becomes repository provenance or enters a portable descriptor. Repository identity requires repository-bearing evidence; an absolute cache path is never enough. Plugin roots may be symlinked only when canonical-path containment is proven. Source trees retain the existing symlink-free fingerprint rules.

Candidates with adjacent `customization.json` are classified as customizations. Malformed adjacent metadata is a visible `MALFORMED_CUSTOMIZATION_METADATA` error; it is never downgraded to an ordinary skill. A customization binding must match the portable stable ID, type, name, and license.

Bindings live under `$XDG_STATE_HOME/skill-customization/bindings.json` or `~/.agents/skill-customization/bindings.json`. Keys combine customization ID with host/workspace context. They alone contain concrete source paths. A local source identity derives from `SKILL.md` bytes while its effective checkpoint covers the full directory except clone-local version-control metadata. A top-level symlink binding records its alias and canonical target, and retargeting invalidates it; the fingerprinted target tree rejects internal symlinks.

An overlay requires a confirmed live binding for each context. A fork needs no runtime binding; an optional confirmed tracking binding only produces advisories when the source drifts, disappears, or its state is unreadable or invalid. No tracking binding is silent.

State updates use atomic replacement and a cross-process owner lock. A live lock is never stolen; abandoned ownership fails closed for explicit recovery. Customization maintenance canonically validates its owned `provenance/` directory before acquiring a lock there.
