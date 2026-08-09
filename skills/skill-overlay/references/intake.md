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
- **Placement:** workspace or personal scope and exact destination.
- **Name and activation:** offer two or three collision-free `<source>-<outcome>` names and default to `coexist`. Record `replace` only after a separate confirmation of same-name intent and customization-first host precedence.
- **Upstream relationship:** state that the live source remains required, what upstream continues to own, and how recursive preflight orders the base workflow followed by inner-to-outer deltas.
- **Dispatcher:** generate a thin `SKILL.md` that runs contract-1 preflight, follows only ready steps, and delegates unavailable, incompatible, or maintenance-required results to `skill-overlay`.
- **Helper fallback:** record whether npm may download/cache `skill-customization@latest` only if the installed helper fails contract 1. The download may run only after brief confirmation.

Before finalizing, invoke any available skill-creation or agent-writing skill, such as `skill-creator` or `writing-for-agents`. Review the proposed delta against source conventions, trigger behavior, realistic examples, and checkable completion criteria. Fold material findings into the brief.

Present one brief containing every field above and ask for one confirmation. Intake is complete only when source identity, delta, placement, name, activation, recursive live-upstream relationship, dispatcher behavior, conditional helper permission, and any workflow-model switch are explicit. Helper-backed creation begins after confirmation.
