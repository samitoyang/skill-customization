# CLI reference

Use the CLI for deterministic descriptor validation, fingerprints, discovery, bindings, and reconciliation. Run `skill-customization --help` for the authoritative command and option list.

## Select the helper

Each published skill pins the helper version it was verified with.

1. Confirm Node.js 18+ and npm are available.
2. Run `skill-customization --version`. If it reports the pinned version, use that installed command.
3. If the command is missing or reports a different version, tell the user that `npx` will download or reuse a cached npm package and ask permission to run `npx --yes skill-customization@<pinned-version> <command>`.
4. If permission is declined, stop. Offer `npm install --global skill-customization@latest` only as optional manual setup.

If Node.js or npm is missing, stop with the detected prerequisite and point to a Node.js 18+ installation. Do not substitute a different runtime or copy CLI logic into the skill.

## Runtime contract

Structured results are written to standard output and diagnostics to standard error. Success exits `0`, invalid input or an operational error exits `1`, and a safe reconciliation stop exits `2`.

Discovery searches declared roots and bounded workspace ancestors. An unresolved source result ends with an explicit custom-path choice. The first binding is interactive, and an overlay reconciliation resolves that confirmed binding rather than accepting a source override.
