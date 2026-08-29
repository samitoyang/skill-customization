# Testing and performance

## Discovery modes

Fixture discovery is the default seam for behavior tests. Call `discoverFixtureSkills` from `test/support/discovery-modes.js` with explicit `roots` and `managerRecords`. The seam always disables plugin discovery, so an omitted fixture cannot fall through to the developer's home directory, installed managers, or plugin inventory. Keep discovered roots inside a temporary directory; committed data under `test/fixtures` may seed that directory.

Ambient discovery is an integration concern and must be visibly opted into through `discoverAmbientSkills`. Every call declares `home`, `cwd`, `env`, and `managerRecords`; it does not accept explicit roots or allow plugin discovery to be disabled. Use a temporary home and workspace that contain only the host configuration under test. If a test changes `process.env`, restore every value in its teardown. Dedicated ambient files end in `.ambient.test.js`; a mixed file uses `ambient` in each integration test name until its migration ticket moves that coverage.

These test seams do not change the production interface: `discoverSkills` retains ambient defaults for real callers.

## Verification lanes

| Lane | Command | Ownership |
| --- | --- | --- |
| Emitted behavior | `npm test` | The verifier assembles one fresh isolated publication artifact and runs its complete compiled `node:test` suite, including fixture and ambient integration coverage, against the same emitted CLI and library that the package publishes. |
| Package | `npm run check:package` | Invokes the emitted-artifact verifier once, then packs that exact verified directory without lifecycle scripts. It audits required assets, exclusions, executable metadata, and installed JavaScript, TypeScript, and CLI consumers without rebuilding, copying over repository `dist`, or accepting stale output. |
| Performance | `npm run test:performance` | Runs the fixture, targeted-Binding, plugin-cache-continuity, preflight, ambient, and emitted-artifact scenarios one at a time, each in a fresh Node.js process. Each scenario reports samples and fails its gate when robust duration or exact work budgets regress. |

`npm run verify` remains the required complete correctness check. Its package lane owns the full verifier invocation, so compilation, declarations, source maps, emitted tests, CLI/library compatibility, and the package audit each run once against one artifact. `npm test` is the focused emitted-artifact check without a package audit. The performance suite is an additional check, not a replacement for correctness. CI runs both jobs. Concurrent `node:test` durations and whole-suite wall-clock time are diagnostic only; they are not performance evidence or regression gates.

The behavior suite includes one immutable [Descriptor parity corpus](../test/support/descriptor-parity-corpus.js). Its cases exercise both `validateDescriptor` and the exported `customization.schema.json`; the [Descriptor invariant catalog](../src/descriptor-invariants.js) owns the named runtime-only expressibility gaps, while every other result must agree. Because package checking packs the verifier's exact output, the same host-independent catalog audit and corpus verify source behavior and the package candidate exactly once per package check.

## Performance scenarios

Performance scenarios live under `test/performance/` and end in `.performance.js`. Run exactly one through `scripts/run-performance.js`; the runner rejects ordinary test files, multiple scenarios, and paths outside that directory. `npm run test:performance` invokes the six checked-in scenarios through that runner, so every scenario gets its own process and environment. The plugin-cache-continuity scenario measures recovery of a stale versioned plugin Binding to its equivalent replacement copy. A scenario owns its fixture size, iteration count, setup, structured report, and budget. It must use deterministic fixture discovery unless its stated subject is ambient integration. Thresholds and exact work budgets belong beside the scenario they govern, not in the concurrent correctness suite.

The shared gate warms up before collecting five samples by default and reports the median, p95, maximum, and median absolute deviation. Each measured operation returns its work counters to the gate, which owns warmup exclusion and measured-work aggregation. Median, p95, and scenario-specific MAD ceilings distinguish a slower operation from an unstable host; exact work budgets are host-independent and fail on unexpected ambient adapter calls, out-of-scope roots, repeated discovery work, or unexpected Git probes. Git provenance remains part of each candidate's existing discovery check, while the candidate's upstream entrypoint is derived from the repository result. The artifact scenario runs the complete emitted-artifact verifier, including compilation and the emitted contract suite, with serialized emitted-test concurrency for reproducible timing, so artifact performance cannot be measured by a partial build.

## Discovery snapshot freshness

A discovery result is a request-scoped snapshot of declared roots, manager records, host configuration, plugin manifests, candidate metadata, and fingerprints at the time of the call. It is not a durable inventory cache. Preflight and Binding create one for each operation; a caller that already collected Discovery may seed it without exposing snapshot mechanics to the Binding intent interface.

- Treat each discovery result as valid only for the operation that collected it; recursive preflight and replacement Binding checks reuse one snapshot, and source lookups outside seeded inventory are memoized only within that operation.
- Start a new discovery call after installing, removing, or retargeting a skill; changing a manifest, manager record, root, symlink, or relevant environment value; or mutating fingerprinted source content.
- Fixture tests create fresh inputs per test and never share discovery results across tests.
- Ambient integration tests mutate only their isolated home/workspace and rediscover after each mutation they intend to observe.
- Binding and reconciliation checks still own validation of persisted selections and fingerprints; a stale discovery result must not bypass those checks.

This freshness rule makes invalidation explicit while keeping discovery state operation-scoped rather than process-global.
