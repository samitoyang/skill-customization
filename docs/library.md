# Library reference

Import public functions from `skill-customization`; the package root is the supported Node.js 18+, zero-runtime-dependency API. The schema is exported as `skill-customization/schema`.

Primary seams are descriptor validation that keeps runtime selectors inside the reviewed payload, normalization and naming, canonical-target and owned-payload fingerprints that reject internal symlinks, bounded discovery and manager records, context bindings, targeted reconciliation with entrypoint-derived local identity and recursively checked customization-source identity, recursive `preflightCustomization`, explicit `acceptMaintenanceUpdate`, and canonically contained locked atomic file/JSON updates.

`preflightCustomization` returns `ready`, `ready-with-advisory`, or `maintenance-required`; ready results contain `effectiveFingerprint`, ordered steps with `role`, `path`, `root`, and `customizationId`, advisories, and at most one maintenance handler. `acceptMaintenanceUpdate` atomically refreshes the owned-payload fingerprint, the source effective fingerprint only when explicitly supplied, and fork snapshot/diff fingerprints while preserving the existing modes of portable descriptor and diff artifacts. Both `reviewedAt` and `evidence` are required when either materialization fingerprint changes. Callers rerun preflight before execution.

For a customization source, pass the successful nested preflight's `effectiveFingerprint` and `steps` to `reconcileCustomization` as `sourceEffectiveFingerprint` and `sourceExecutionPlan`; the CLI performs this nested preflight automatically. When semantic review is required, the callback receives that ordered `sourceExecutionPlan` and its base workflow as `sourceEntrypoint`. Reconciliation never substitutes the customization directory's raw fingerprint or a thin dispatcher for the checked plan.

Keep resolved sources read-only and machine-local state outside portable customization artifacts. Read [Descriptor v1](descriptor-v1.md), [Discovery and bindings](discovery-and-bindings.md), and [Reconciliation](reconciliation.md) before constructing a runtime integration.
