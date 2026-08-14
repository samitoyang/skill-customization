---
name: "review-local-archive"
description: "Review work and archive the result locally."
---

# Managed dispatcher

1. Run `skill-customization supports 1` and accept only a well-formed,
   compatible contract-1 result. Otherwise delegate once to
   `skill-overlay` and execute no customization instructions.

2. Run `skill-customization preflight
   <this-skill-directory>/customization.json --context <current-context>`.
   For `maintenance-required`, delegate once to its returned handler.
   For malformed or failed preflight, delegate once to
   `skill-overlay`. Continue only for `ready` or
   `ready-with-advisory`: load the complete plan, then compose its workflow
   with deltas inner-to-outer so later deltas refine earlier instructions.

3. Report advisories first, then execute only the effective workflow.
