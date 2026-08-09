# Contributing

Use Node.js 18 or newer and make one vertical slice at a time. Runtime code has no third-party dependencies.

1. Add or update `node:test` coverage for public behavior.
2. Keep descriptors portable and binding state local. Reuse the existing seams for normalization, discovery, manager metadata, fingerprints, bindings, reconciliation, and atomic writes.
3. Keep every published skill independently installable: local links stay inside its skill directory, while shared runtime logic stays in the versioned `skill-customization` package.
4. Keep `SKILL.md`, eval prompts, and handoff text concise; disclose branch-specific detail through focused references inside the same skill.
5. Preserve the managed-runtime helper contract 1. Update its named regression tests and goldens for compatible clarifications; after publication, use a new contract for incompatible behavior.
6. Check published skill compatibility with `skill-customization supports 1`, not an exact package version.
7. Run `npm run verify` before opening a pull request.

Release selection and publication are separate maintainer decisions. A compatibility change does not authorize choosing a package version.

Bug reports should include the command, expected result, actual result, Node.js version, and a minimal descriptor with credentials and machine-local paths removed.
