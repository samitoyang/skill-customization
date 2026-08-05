# Skill Customization

I built Skill Customization to tailor upstream skills to personal habits, team conventions, and project workflows without losing their provenance—or the option to receive future improvements.

Start with the outcome you want:

| Outcome | Use |
| --- | --- |
| Keep the upstream workflow live and layer on a documented behavior change | `skill-overlay` |
| Own an independent version that runs without the original skill | `skill-fork` |
| Keep the original behavior and only call or consume it from another workflow | A companion skill, not a customization |

Both customization types normally coexist with their source under a distinct name. Same-name replacement is available only when host precedence is deterministic and you confirm it separately.

## Install

Installing both skills is the recommended default:

```sh
npx skills@latest add samitoyang/skill-customization
```

Install only one when you already know which model you need:

```sh
npx skills@latest add samitoyang/skill-customization --skill skill-overlay
npx skills@latest add samitoyang/skill-customization --skill skill-fork
```

These commands work with [Vercel Skills](https://github.com/vercel-labs/skills). Discovery also understands metadata or installations managed by [ASM](https://github.com/luongnv89/asm), [xingkongliang Skills Manager](https://github.com/xingkongliang/skills-manager), and [jtianling skillsmgr](https://github.com/jtianling/skills-manager).

Skill managers generally install into the current project by default. Add `--global` for personal skills you want available across projects. Both published skills are model-invoked and independently installable.

## Use

Ask naturally and let the agent choose the skill:

- “Customize our handoff skill for this project while continuing to receive upstream changes.” → `skill-overlay`
- “Make an independent version that works without the original skill.” → `skill-fork`
- “Run my existing customized handoff workflow.” → validate its descriptor, reconcile it, then apply its documented delta

Hosts that support explicit skill invocation can also accept:

```text
$skill-overlay customize handoff so every result is archived locally
$skill-fork make our incident-response skill independent of its original checkout
```

Explicit invocation uses the same model-invoked workflow; there is no separate invocation mode to configure.

## Compatibility

Discovery recognizes declared skill roots without crawling arbitrary home or sibling directories.

| Category | Representative roots |
| --- | --- |
| Shared project paths | `.agents/skills` |
| Native project paths | `.claude/skills`, `.github/skills`, `.cursor/skills`, `.windsurf/skills` |
| Personal paths | `~/.agents/skills`, `~/.claude/skills`, `$CODEX_HOME/skills` |
| Configured paths | Claude `additionalDirectories`, `COPILOT_SKILLS_DIRS`, manager-owned roots, and an explicit custom path |

Support means recognizing the project and personal paths declared by the [checkpointed Vercel Skills registry](https://github.com/vercel-labs/skills/blob/305ff8be68e59368789d765e2cf0edfab851c453/src/agents.ts), plus preserved legacy and manager paths. It does not imply that every agent loads or executes skills identically. Vercel Skills v3 lock metadata is supported alongside the manager formats above.

## How the helper works

The skills prefer an installed compatible `skill-customization` command. If it is missing or incompatible, they explain that `npx` will download or cache the pinned helper and ask before using it. Node.js 18+ and npm are required; global CLI installation is optional.

Published descriptors keep stable identity and provenance portable. Concrete source paths, credentials, bindings, and compatibility decisions remain local. The supporting Node.js package has no runtime dependencies.

## References

- When invoking or automating the helper, read the [CLI reference](docs/cli.md); `skill-customization --help` is authoritative for commands and options.
- When creating or validating publishable metadata, read [Descriptor v1](docs/descriptor-v1.md).
- When resolving a source copy or binding context, read [Discovery and bindings](docs/discovery-and-bindings.md).
- When reviewing source drift or a fork payload, read [Reconciliation](docs/reconciliation.md).
- When embedding the engine in another Node.js tool, read the [Library reference](docs/library.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md). Run `npm run verify` before committing. The project is MIT licensed.
