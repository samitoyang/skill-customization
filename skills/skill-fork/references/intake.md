# Fork intake

Use this intake only for a new fork or an explicit material change. Existing execution starts with helper preflight; derive facts from the request, workspace, inventory, source graph, descriptor, complete `CUSTOMIZATION.md` workflow, snapshot directory, and diff before asking.

## Starting point

| Available input | Next action | Completion criterion |
| --- | --- | --- |
| Complete source path and customization idea | Inspect the source and derive identity, conventions, license, likely scope, destination, and names. Ask only about facts that remain uncertain. | The source copy and every non-derivable brief field are confirmed. |
| Skill name only | Discover matching copies and provenance evidence. Resolve ambiguity, then ask what behavior should change. | One concrete copy and one customization idea are confirmed. |
| Idea without a source | Inspect workspace context and installed inventory. Offer relevant candidates with evidence. | The user confirms one source candidate. |
| Invocation only | Inventory first, then ask for the source and desired change together. | Both source and idea are known without serial one-fact questioning. |
| Existing descriptor and artifacts | Use them as stored intake and ask only about a requested change or detected conflict. | The user does not repeat recorded decisions. |

If the user requires automatic upstream changes from a live source, explain why that contradicts fork independence and confirm routing to `/skill-overlay` before switching. If the new workflow only calls or consumes the source, route to a companion skill.

## Complete the brief

Resolve these fields:

- **Source identity:** confirmed full source or verified customization, declared name, stable identity, type, license, expected effective fingerprint, and discovery evidence. Concrete paths belong only in an optional context tracking binding.
- **Independent workflow:** context, complete desired workflow, preserved behavior, non-goals, and observable success. `CUSTOMIZATION.md` contains the whole runnable workflow, not a delta.
- **Placement:** Default a new workspace customization to `.agents/skills/<name>/`; use a compatible host-specific project or personal skill root when selected, and record the exact destination.
- **Name and activation:** offer two or three collision-free `<source>-<outcome>` names and default to `coexist`. Record `replace` only after a separate confirmation of same-name intent and customization-first host precedence.
- **Independence and distribution:** state that the fork is a runtime leaf, and record whether it is private, team-shared, or public so license and redistribution review match the intended audience.
- **Materialization:** when the source is an overlay chain, review its checked base-plus-deltas result and record the chain effective fingerprint, concrete snapshot directory fingerprint, review time, and evidence before diffing to the independent workflow.
- **Tracking:** ask whether to retain a confirmed advisory binding. No binding is silent; drift and unavailability never block; unreadable or invalid optional tracking state remains advisory; adoption and rebase are explicit.
- **Approved frontmatter:** confirm `name`, `description`, and any other approved metadata for the generated skill.
- **Dispatcher:** after brief confirmation, pass only `fork` and the approved frontmatter to `skill-customization render-dispatcher`; write its output unchanged and never generate or edit its body freehand.
- **Helper fallback:** separately record whether npm may download/cache `skill-customization@latest` only if the installed helper fails contract 2. The download may run only after brief confirmation. Never pass fallback permission, helper commands, package versions, source instructions, paths, or context policy to the renderer.

[ADR 0001](https://github.com/samitoyang/skill-customization/blob/main/docs/adr/0001-managed-recursive-runtime.md) is the rationale: one canonical renderer owns the thin-dispatcher seam, and the complete checked plan is loaded and its semantic deltas are composed before any workflow action.

Before finalizing, invoke any available skill-creation or agent-writing skill, such as `skill-creator` or `writing-for-agents`. Review the proposed independent workflow against source conventions, trigger behavior, realistic examples, and checkable completion criteria. Fold material findings into the brief.

Present one brief containing every field above and ask for one confirmation. Intake is complete only when source identity, independent workflow, placement, name, activation, materialization/tracking choices, distribution intent, approved frontmatter, canonical rendering, conditional helper permission, and any workflow-model switch are explicit. Helper-backed creation begins after confirmation.
