# Overlay intake

Use this intake only for a new overlay or an explicit material change. Existing execution starts with helper preflight; derive facts from the request, workspace, inventory, source graph, descriptor, `CUSTOMIZATION.md`, and binding before asking.

## Starting point

| Available input | Next action | Completion criterion |
| --- | --- | --- |
| Complete source path and customization idea | Inspect the source and derive identity, conventions, likely scope, destination, and names. Ask only about facts that remain uncertain. | The source copy and every non-derivable brief field are confirmed. |
| Skill name only | Discover matching copies and provenance evidence. Resolve ambiguity, then ask what behavior should change. | One concrete copy and one customization idea are confirmed. |
| Idea without a source | Inspect workspace context and installed inventory. Offer relevant candidates with evidence. | The user confirms one source candidate. |
| Invocation only | Inventory first, then ask for the source and desired change together. | Both source and idea are known without serial one-fact questioning. |
| Existing descriptor and artifacts | Use them as stored intake and ask only about a requested change or detected conflict. | The user does not repeat recorded decisions. |

If the requested behavior must survive source removal, explain why that contradicts an overlay and confirm routing to `/skill-fork` before switching. If the new workflow only calls or consumes the source, route to a companion skill.

## Complete the brief

Resolve these fields:

- **Source identity:** confirmed full source or verified customization, declared name, stable identity, type, license, expected effective fingerprint, and discovery evidence. Concrete paths belong only in the context binding.
- **Delta:** context, desired behavior, preserved source behavior, non-goals, and observable success. `CUSTOMIZATION.md` contains only this semantic delta.
- **Placement:** Default a new workspace customization to `.agents/skills/<name>/`; use a compatible host-specific project or personal skill root when selected, and record the exact destination.
- **Name and activation:** offer two or three collision-free `<source>-<outcome>` names and default to `coexist`. Record `replace` only after a separate confirmation of same-name intent and customization-first host precedence.
- **Upstream relationship:** state that the live source remains required, what upstream continues to own, and how recursive preflight orders the base workflow followed by inner-to-outer deltas.
- **Approved frontmatter:** confirm `name`, `description`, and any other approved metadata for the generated skill.
- **Dispatcher:** after brief confirmation, pass only `semantic-overlay` and the approved frontmatter to `skill-customization render-dispatcher`; write its output unchanged and never generate or edit its body freehand.
- **Helper fallback:** separately record whether npm may download/cache `skill-customization@latest` only if the installed helper fails contract 2. The download may run only after brief confirmation. Never pass fallback permission, helper commands, package versions, source instructions, paths, or context policy to the renderer.

[ADR 0001](https://github.com/samitoyang/skill-customization/blob/main/docs/adr/0001-managed-recursive-runtime.md) is the rationale: one canonical renderer owns the thin-dispatcher seam, and the complete checked plan is loaded and its semantic deltas are composed before any workflow action.

Before finalizing, if an available skill-creation or agent-writing skill is needed, **Call the Skill tool with "skill-creator" or "writing-for-agents".** Review the proposed delta against source conventions, trigger behavior, realistic examples, and checkable completion criteria. Fold material findings into the brief.

Present one brief containing every field above and ask for one confirmation. Intake is complete only when source identity, delta, placement, name, activation, recursive live-upstream relationship, approved frontmatter, canonical rendering, conditional helper permission, and any workflow-model switch are explicit. Helper-backed creation begins after confirmation.
