---
name: "review-local-archive"
description: "Review work and archive the result locally."
---

# Managed dispatcher

1. Select the helper. Run `skill-customization supports 1`. Accept only an exit-0 JSON result with `compatible: true`, `requested_contract: "1"`, `supported_contracts` containing `"1"`, and a non-empty `package_version`. Otherwise, delegate once to `skill-overlay` and end this invocation before loading any customization instructions.
   **Gate:** one compatible contract-1 helper is selected, or `skill-overlay` owns the invocation.

2. Preflight. With the selected helper, run `skill-customization preflight customization.json --context <current-context>`. Continue only for `ready` or `ready-with-advisory`. For `maintenance-required`, delegate once to exactly the returned maintenance handler and end this invocation before loading any customization instructions.
   **Gate:** preflight returns one complete checked plan, or one maintenance handler owns the invocation.

3. Compose before action. Load every file referenced by the ordered `steps` before performing any workflow action. The `workflow` step supplies the base or complete workflow; apply every `delta` step from inner to outer so each later delta refines the earlier instructions.
   **Gate:** the entire checked plan is loaded and composed into one effective workflow.

4. Execute. Report the advisory for `ready-with-advisory`, then execute only the resulting effective workflow.
   **Completion:** the effective workflow is complete.
