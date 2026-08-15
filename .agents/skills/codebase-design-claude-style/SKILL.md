---
name: codebase-design
description: Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or AI-navigable, or when another skill needs the deep-module vocabulary.
---

# Codebase Design - Claude style overlay

Follow `$HOME/.agents/skills/codebase-design/SKILL.md`.

## Fit and compatibility

- Treat task requirements, repository instructions, established architecture, and language or framework idioms as design constraints unless the task explicitly changes them.
- Preserve observable behavior and existing interfaces unless the requested change requires otherwise.
- Use the repository's domain terms for problem concepts and the `codebase-design` glossary for structural concepts.

## Domain ownership

- Center each module on a cohesive domain capability.
- Shape interface operations around caller intent. Keep validation, orchestration, persistence policy, and intermediate lifecycle state inside the implementation unless callers genuinely need independent control.
- Use explicit, idiomatic types at interfaces. Validate untrusted input at the first seam owned by the module.

## Dependencies and abstractions

- Keep the module dependency graph acyclic and direct dependencies toward stable interfaces.
- Extract shared implementation only when its consumers represent the same domain concept and invariants. Keep duplication while the common abstraction remains uncertain.
- Introduce a separate file or module only when it creates meaningful ownership, locality, reuse, or an independently testable seam. Keep one-use helpers inside the implementation they support.
- Prefer explicit dependencies and traceable control flow. Use reflection, generation, or runtime wiring when it is an established framework idiom and does not increase what callers must know.

## Completion criteria

The design is complete when:

- domain and structural terminology are consistent;
- the dependency graph remains acyclic;
- observable behavior and intentionally retained interfaces are preserved;
- changed behavior is tested through the affected interfaces;
- applicable repository checks pass.