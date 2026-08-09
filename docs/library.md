# Library reference

Import public functions from `skill-customization`; the package root is the supported Node.js 18+, zero-runtime-dependency API. The schema is exported as `skill-customization/schema`.

Primary seams are descriptor validation, normalization and naming, full-path and owned-payload fingerprints, bounded discovery and manager records, context bindings, targeted reconciliation, recursive `preflightCustomization`, explicit `acceptMaintenanceUpdate`, and locked atomic file/JSON updates.

`preflightCustomization` returns `ready`, `ready-with-advisory`, or `maintenance-required`; ready results contain `effectiveFingerprint`, ordered steps with `role`, `path`, `root`, and `customizationId`, advisories, and at most one maintenance handler. `acceptMaintenanceUpdate` atomically refreshes accepted source/payload/snapshot/diff review data; callers rerun preflight before execution.

Keep resolved sources read-only and machine-local state outside portable customization artifacts. Read [Descriptor v1](descriptor-v1.md), [Discovery and bindings](discovery-and-bindings.md), and [Reconciliation](reconciliation.md) before constructing a runtime integration.
