# Fork intake

Use this intake only for a new fork or a material change to an existing one. Derive facts from the request, workspace, inventory, source, descriptor, `CUSTOMIZATION.md`, snapshot, and diff before asking; ask only for unresolved decisions.

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

- **Source identity:** confirmed copy, declared name, repository and upstream entrypoint or opaque local identity, review checkpoint, license, and discovery evidence.
- **Delta:** context, desired behavior, preserved source behavior, non-goals, and observable success.
- **Placement:** workspace or personal scope and exact destination.
- **Name and activation:** offer two or three collision-free `<source>-<outcome>` names and default to `coexist`. Record `replace` only after a separate confirmation of same-name intent and customization-first host precedence.
- **Independence and distribution:** state that no runtime source remains required, and record whether the fork is private, team-shared, or public so license and redistribution review match the intended audience.
- **Helper fallback:** record whether npm may download/cache `skill-customization@latest` only if the installed helper fails contract 1. The download may run only after brief confirmation.

Before finalizing, invoke any available skill-creation or agent-writing skill, such as `skill-creator` or `writing-for-agents`. Review the proposed delta against source conventions, trigger behavior, realistic examples, and checkable completion criteria. Fold material findings into the brief.

Present one brief containing every field above and ask for one confirmation. The intake is complete only when source identity, delta, placement, name, activation, independence, distribution intent, conditional helper permission, and any workflow-model switch are explicit and confirmed. Helper-backed creation begins only after that confirmation.
