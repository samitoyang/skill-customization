# CLI reference

Use the CLI for contract selection, descriptor validation, fingerprints, discovery, bindings, and reconciliation. Run `skill-customization --help` for the authoritative command and option list.

## Select the helper

Contract 1 is the compatibility boundary used by the published skills.

1. Confirm Node.js 18+ and npm are available.
2. Run `skill-customization supports 1`.
3. Accept the installed command only when it exits `0` and emits JSON with `compatible: true`, `requested_contract: "1"`, `supported_contracts` containing `"1"`, and a non-empty `package_version`. Record that exact version for the run.
4. If the installed command is missing or incompatible, explain that npm may download `skill-customization@latest` or reuse its cache and ask permission. After approval, run `npx --yes skill-customization@latest supports 1`.
5. When the on-demand check succeeds, run later commands as `npx --yes skill-customization@<package_version> <command>`.

Run the on-demand check only after a new customization brief is confirmed. If Node/npm is missing, permission is declined, output is malformed, or contract 1 is unsupported, stop with the failed prerequisite and one setup or update action. A global latest install is optional for frequent use.

## `supports` output

`skill-customization supports <contract>` always writes a JSON check result for supported, unsupported, malformed, missing, and extra-argument contract requests:

```json
{
  "compatible": true,
  "requested_contract": "1",
  "supported_contracts": ["1"],
  "package_version": "0.1.0"
}
```

The shown package version is an example, not a compatibility pin. Supported checks exit `0`. Unsupported or invalid checks exit `1` and write the reason to standard error while keeping the JSON result on standard output.

## Runtime behavior

Structured command results are written to standard output and diagnostics to standard error. Success exits `0`, invalid input or an operational error exits `1`, and a safe reconciliation stop exits `2`.

Discovery searches declared roots and bounded workspace ancestors. An unresolved source result ends with an explicit custom-path choice. The first binding is interactive, and overlay reconciliation resolves that confirmed binding rather than accepting a source override. [Helper contract 1](helper-contract-1.md) names the complete stable skill-facing surface.
