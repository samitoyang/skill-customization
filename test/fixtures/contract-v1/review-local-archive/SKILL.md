---
name: review-local-archive
description: Review work and archive the result locally.
---

# Managed dispatcher

Run `skill-customization supports 1`, accepting only a compatible contract-1 result. If the command is unavailable, incompatible, or malformed, delegate to `skill-overlay` and do not execute the customization. Otherwise, use that helper to run `skill-customization preflight customization.json --context <current-context>`. Follow every execution step only for `ready` or `ready-with-advisory`; delegate `maintenance-required` to its maintenance handler.
