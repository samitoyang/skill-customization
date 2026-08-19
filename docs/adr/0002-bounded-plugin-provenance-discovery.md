# ADR 0002: Bounded plugin provenance discovery

## Status

Accepted for plugin-aware discovery and provenance resolution.

## Decision

Layer a manifest-aware plugin resolver over the checkpointed standard skill-root registry. The resolver recognizes documented plugin locations for Claude Code, Codex, Gemini CLI, Cursor, and future host adapters; it reads declared manifests and installation metadata, searches only exact plugin paths plus bounded workspace ancestors, and never performs a broad home-directory crawl. Codex includes local marketplace roots declared by `$CODEX_HOME/config.toml`, its personal and workspace marketplace declarations, synchronized and bundled marketplace snapshots, and versioned cache under `$CODEX_HOME/plugins/cache`; Codex `.codex-plugin/plugin.json` manifests may supply custom skill directories. Gemini uses `${GEMINI_CLI_HOME:-~}/.gemini/extensions` for user extensions plus bounded workspace `.gemini/extensions` roots. Claude synced skills under `~/.claude/skills/synced/<skill>/SKILL.md` are included only when `CLAUDE_CODE_SYNC_SKILLS=1`.

Every valid copy under an exact plugin path may be discovered, including multiple cache versions. Identical fingerprints are grouped into one candidate, while conflicting fingerprints or provenance identities remain separate. A cache version is evidence, not source identity. When repository evidence is absent, a local plugin identity supports grouping and diagnostics but never becomes portable repository provenance. Repository identity comes only from explicit, Git, plugin/marketplace, manager, embedded, or confirmation evidence; a cache path alone cannot establish it. Git outranks plugin and manager evidence, and conflicts remain visible.

Plugin roots may be symlinked only when their canonical paths remain inside the declared plugin root. Concrete paths and host-local plugin identities remain in discovery or binding state; portable descriptors contain stable identity and reviewed fingerprints only. The full operational contract lives in [Discovery and bindings](../discovery-and-bindings.md); `CONTEXT.md` records the vocabulary and this ADR records the rationale.

## Consequences

Discovery can find skills that are available only through plugin installations without making host cache layout part of portable state. Stale versions remain auditable without being silently selected as the current source. The resolver needs host-specific adapters and diagnostics for malformed metadata, but its bounded scope limits performance and path-traversal risk.
