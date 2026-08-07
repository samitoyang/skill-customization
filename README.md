# Skill Customization

Skill ecosystems make upstream workflows easy to install but difficult to tailor safely. A source may be read-only or managed by an updater, so direct edits can disappear. A full-copy fork avoids that overwrite but drifts from upstream, often loses provenance, and can collide with the original skill's name or trigger. Multiple agent paths and skill managers also make it uncertain which copy is active. Skill Customization keeps identity and intent explicit so upstream reconciliation, activation, and local ownership can be reviewed instead of guessed.

Start with the relationship the customized workflow should have to its source:

| Outcome | Use |
| --- | --- |
| Keep the upstream workflow live and layer on a documented behavior change | `skill-overlay` |
| Own an independent version that runs without the original skill | `skill-fork` |
| Keep the original behavior and only call or consume it from another workflow | A companion skill, not a customization |

Both customization types normally coexist with their source under a distinct name. Same-name replacement is available only when host precedence is deterministic and the user confirms it separately.

## Reported pain points and evidence

Representative community reports show the underlying problems from several angles:

- [Hierarchical skills and team customization](https://github.com/anthropics/skills/discussions/380) describes full-copy duplication, trigger collisions, and update drift.
- [Customizing a bundled read-only skill](https://github.com/anthropics/skills/discussions/911) illustrates why managed sources cannot always be edited in place and how same-name overrides depend on precedence.
- [Skills across different providers](https://github.com/anthropics/skills/discussions/166) highlights the absence of one universal discovery path.
- [Agent-specific removal and shared canonical paths](https://github.com/vercel-labs/skills/issues/810) shows how a supposedly removed skill can remain active through another path.
- [Install and sync from a skill lock file](https://github.com/vercel-labs/skills/issues/283) documents the gap between recorded manager state and the copies actually present on disk.

## Install the skills

Installing both independently packaged skills is the recommended default:

```sh
npx skills@latest add samitoyang/skill-customization
```

Install only one when the required source relationship is already clear:

```sh
npx skills@latest add samitoyang/skill-customization --skill skill-overlay
npx skills@latest add samitoyang/skill-customization --skill skill-fork
```

These commands work with [Vercel Skills](https://github.com/vercel-labs/skills). Discovery also understands metadata or installations managed by [ASM](https://github.com/luongnv89/asm), [xingkongliang Skills Manager](https://github.com/xingkongliang/skills-manager), and [jtianling skillsmgr](https://github.com/jtianling/skills-manager).

Skill managers generally install into the current project by default. Add `--global` for personal skills that should be available across projects. Each published skill can be installed without the other.

## Invoke naturally or explicitly

Natural-language requests are auto-selected by the source relationship:

- “Customize our handoff skill for this project while continuing to receive upstream changes.” selects `skill-overlay`.
- “Make an independent incident-response skill that works after the original checkout is removed.” selects `skill-fork`.
- “Run my existing customized handoff workflow.” selects its stored descriptor path, reconciles it, and applies the documented delta.

Explicit slash invocation runs the same workflow:

```text
/skill-overlay customize handoff so every result is archived locally
/skill-fork make incident-response independent of its original checkout
```

Both skills retain model discovery and explicit user invocation; there is no second mode to configure.

## Required input and intake behavior

A source plus a customization idea is the fastest starting point, but incomplete requests are supported. The agent inventories first, derives facts from evidence, and asks only for decisions it cannot resolve.

| Starting point | Overlay example | Fork example | Expected intake |
| --- | --- | --- | --- |
| Complete path and idea | `/skill-overlay customize /workspace/.agents/skills/handoff to archive locally` | `/skill-fork make /workspace/.agents/skills/review independent with our audit step` | Inspect the path, derive remaining facts, and avoid redundant questions. |
| Skill name only | `/skill-overlay handoff` | `/skill-fork review` | Discover matching copies, resolve ambiguity, then ask for the missing idea. |
| Idea without a source | “Archive every handoff, but I do not know which skill handles it.” | “Create a standalone incident workflow, but I do not know its installed name.” | Inspect workspace and inventory, offer evidenced candidates, and confirm one. |
| Missing idea | “Customize the handoff skill.” | “Fork the review skill.” | Resolve the source, then ask what should change and what must remain. |
| Empty invocation | `/skill-overlay` | `/skill-fork` | Inventory first, then ask for source and idea together. |
| Existing customization | “Run the existing handoff-local-archive descriptor.” | “Verify the existing review-standalone descriptor and snapshot.” | Treat descriptor, `CUSTOMIZATION.md`, binding, snapshot, and diff artifacts as stored intake; do not ask the user to repeat them. |
| Explicit model mismatch | `/skill-overlay make review run after its source is deleted` | `/skill-fork keep every future upstream handoff change automatically` | Explain the mismatch and confirm before switching to `/skill-fork` or `/skill-overlay`. |

For new or materially changed work, the agent presents one final customization brief for confirmation. It includes confirmed source identity; desired and preserved behavior; non-goals and observable success; workspace or personal destination; name and activation; live-upstream relationship for an overlay or independence and distribution intent for a fork; and conditional permission for a helper download.

## Helper prerequisites and on-demand use

Node.js 18 or newer, npm access, and helper contract 1 are required for deterministic validation, discovery, binding, fingerprints, and reconciliation. Routing, inventory, and intake can happen before the helper is available.

After the brief is confirmed, each skill first tries the installed command:

```sh
skill-customization supports 1
```

If it is missing or incompatible, the skill explains that the following check may download the latest package or reuse npm's cache and asks permission before running it:

```sh
npx --yes skill-customization@latest supports 1
```

When contract 1 is supported, the returned exact `package_version` is used for every remaining command in that run. This on-demand path is recommended because no helper is fetched before the customization brief exists. Frequent users may optionally install the current helper globally with `npm install --global skill-customization@latest`.

The original published skill text pinned `skill-customization@0.1.0` because no compatibility handshake existed; an exact version was the only deterministic guarantee for commands, output, state, fingerprints, and reconciliation. Helper contract 1 now freezes that skill-facing behavior, so a newer `@latest` helper can be used when `supports 1` succeeds. Legacy copies of the exact-pinned skill text still cannot accept newer helpers until those installed skill files are updated.

## Discovery compatibility

Discovery recognizes declared skill roots without crawling arbitrary home or sibling directories.

| Category | Representative roots |
| --- | --- |
| Shared project paths | `.agents/skills` |
| Native project paths | `.claude/skills`, `.github/skills`, `.cursor/skills`, `.windsurf/skills` |
| Personal paths | `~/.agents/skills`, `~/.claude/skills`, `$CODEX_HOME/skills` |
| Configured paths | Claude `additionalDirectories`, `COPILOT_SKILLS_DIRS`, manager-owned roots, and an explicit custom path |

Support means recognizing the project and personal paths declared by the [checkpointed Vercel Skills registry](https://github.com/vercel-labs/skills/blob/305ff8be68e59368789d765e2cf0edfab851c453/src/agents.ts), plus preserved legacy and manager paths. It does not imply that every agent loads or executes skills identically. Vercel Skills v3 lock metadata is supported alongside the manager formats above.

Published descriptors keep stable identity and provenance portable. Concrete source paths, credentials, bindings, and compatibility decisions remain local. The supporting Node.js package has no runtime dependencies.

## References

- When invoking or automating the helper, read the [CLI reference](docs/cli.md); `skill-customization --help` is authoritative for commands and options.
- When maintaining compatibility, read [Helper contract 1](docs/helper-contract-1.md).
- When creating or validating publishable metadata, read [Descriptor v1](docs/descriptor-v1.md).
- When resolving a source copy or binding context, read [Discovery and bindings](docs/discovery-and-bindings.md).
- When reviewing source drift or a fork payload, read [Reconciliation](docs/reconciliation.md).
- When embedding the engine in another Node.js tool, read the [Library reference](docs/library.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md). Run `npm run verify` before committing. The project is MIT licensed.
