# Contributing

Use Node.js 18 or newer and make one vertical slice at a time. Runtime code has no third-party dependencies.

1. Add or update `node:test` coverage for public behavior.
2. Keep descriptors portable and binding state local. Reuse the existing seams for normalization, discovery, manager metadata, fingerprints, bindings, reconciliation, and atomic writes.
3. Keep every published skill independently installable: local links stay inside its skill directory, while shared runtime logic stays in the versioned `skill-customization` package.
4. Keep `SKILL.md`, eval prompts, and handoff text concise; disclose branch-specific detail through focused references inside the same skill.
5. Preserve helper contract 1 for existing dispatchers and contract 2 as the complete customization lifecycle. Update their named regression tests and goldens only for compatible clarifications; after publication, use a new contract for incompatible behavior.
6. Check new dispatcher and creation compatibility with `skill-customization supports 2`, not an exact package version. Keep contract-1 checks only in existing dispatchers and compatibility tests.
7. Run `npm run verify` before opening a pull request.

## Releases

Release selection and publication are separate maintainer decisions. The contract-2 release is `v0.1.1`; later compatibility changes do not authorize choosing another package version.

For a publishable change, run `npm run changeset` and commit the generated file. Choose the semantic-version bump deliberately; documentation, tests, and internal maintenance do not always need a package release. Changes merged to `main` are collected into a version pull request. Review and merge that pull request to publish the prepared version and create its Git tag and GitHub release.

Publication uses npm trusted publishing, not a long-lived npm token. Configure the `skill-customization` package on npm with GitHub Actions as its trusted publisher, repository `samitoyang/skill-customization`, workflow filename `release.yml`, and the `npm publish` action. The workflow uses a GitHub-hosted runner and requests `id-token: write`; do not add an `NPM_TOKEN`. Repository settings must also allow GitHub Actions to create pull requests.

Bug reports should include the command, expected result, actual result, Node.js version, and a minimal descriptor with credentials and machine-local paths removed.
