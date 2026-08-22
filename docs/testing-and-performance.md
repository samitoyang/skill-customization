# Testing and performance

## Discovery modes

Fixture discovery is the default seam for behavior tests. Call `discoverFixtureSkills` from `test/support/discovery-modes.js` with explicit `roots` and `managerRecords`. The seam always disables plugin discovery, so an omitted fixture cannot fall through to the developer's home directory, installed managers, or plugin inventory. Keep discovered roots inside a temporary directory; committed data under `test/fixtures` may seed that directory.

Ambient discovery is an integration concern and must be visibly opted into through `discoverAmbientSkills`. Every call declares `home`, `cwd`, `env`, and `managerRecords`; it does not accept explicit roots or allow plugin discovery to be disabled. Use a temporary home and workspace that contain only the host configuration under test. If a test changes `process.env`, restore every value in its teardown. Dedicated ambient files end in `.ambient.test.js`; a mixed file uses `ambient` in each integration test name until its migration ticket moves that coverage.

These test seams do not change the production interface: `discoverSkills` retains ambient defaults for real callers.

## Verification lanes

| Lane | Command | Ownership |
| --- | --- | --- |
| Behavior | `npm test` | Public behavior through `node:test`; the runner excludes dedicated ambient files and supplies empty isolated personal and workspace inventories. New discovery tests use fixture mode unless host integration is the behavior under test. |
| Ambient integration | `npm run test:ambient` | Documented host roots, plugin manifests, manager adapters, and environment isolation. Dedicated files and integration test names say `ambient`. |
| Emitted artifact | `npm run verify:artifact` | TypeScript compilation, declarations, source maps, emitted tests, and emitted CLI/library compatibility. `verify:typescript` remains an alias during the migration. |
| Package | `npm run check:package` | Packed paths, required assets, executable metadata, and package exclusions. It calls the emitted-artifact verifier rather than duplicating that policy. |
| Performance | `npm run test:performance` | One controlled scenario in one fresh Node.js process. It reports measurements but does not replace correctness verification. |

`npm run verify` remains the required complete correctness check and runs both behavior and ambient integration lanes. Concurrent `node:test` durations and whole-suite wall-clock time are diagnostic only; they are not performance evidence or regression gates.

## Performance scenarios

Performance scenarios live under `test/performance/` and end in `.performance.js`. Run exactly one through `scripts/run-performance.js`; the runner rejects ordinary test files, multiple scenarios, and paths outside that directory. A scenario owns its fixture size, iteration count, setup, and structured report. It must use deterministic fixture discovery unless its stated subject is ambient integration. Thresholds and baselines belong beside the scenario they govern, not in the concurrent correctness suite.

## Discovery snapshot freshness

A discovery result is a request-scoped snapshot of declared roots, manager records, host configuration, plugin manifests, candidate metadata, and fingerprints at the time of the call. It is not a durable inventory cache.

- Reuse a snapshot only inside one operation whose discovery inputs remain unchanged.
- Start a new discovery call after installing, removing, or retargeting a skill; changing a manifest, manager record, root, symlink, or relevant environment value; or mutating fingerprinted source content.
- Fixture tests create fresh inputs per test and never share discovery results across tests.
- Ambient integration tests mutate only their isolated home/workspace and rediscover after each mutation they intend to observe.
- Binding and reconciliation checks still own validation of persisted selections and fingerprints; a stale discovery result must not bypass those checks.

This freshness rule makes invalidation explicit now and permits a future operation to reuse one internally consistent snapshot without turning it into process-global state.
