# Domain context

## Language

- **Customization**: portable v1 descriptor plus a thin dispatcher and runtime-owned workflow material.
- **Semantic overlay**: a live-source customization whose `CUSTOMIZATION.md` is one semantic delta.
- **Fork**: an independent runtime leaf whose `CUSTOMIZATION.md` is the complete workflow and whose provenance owns a snapshot directory and diff.
- **Full source**: an ordinary skill identified by discovery evidence and a reviewed, symlink-free full-directory effective fingerprint that excludes clone-local version-control metadata.
- **Customization source**: a verified overlay or fork identified portably by stable ID, type, name, license, and effective fingerprint.
- **Effective fingerprint**: the deterministic identity of a checked execution result; recursive overlays compose the base/fork workflow with inner-to-outer deltas.
- **Owned payload**: every runtime-owned file except `customization.json`, reserved `provenance/`, and clone-local version-control metadata; symlinks are invalid, and canonical runtime selectors cannot use filesystem aliases to name excluded paths.
- **Preflight**: helper-owned graph traversal that either returns an ordered checked execution plan, a plan with advisory, or one maintenance handler.
- **Binding**: context-local mapping from customization ID to a concrete source copy; concrete paths never enter portable artifacts.
- **Tracking binding**: optional fork binding used only for drift advisories; adoption and rebase remain explicit.
- **Materialization**: reviewed concrete snapshot directory of an overlay chain, recording both chain effective and snapshot fingerprints plus review time and evidence.
- **Reconciliation**: targeted semantic or provenance review for one maintenance decision; recursive traversal belongs to preflight.

## Discovery

- **Plugin skill root**: declared directory whose skills are shipped by an agent plugin and exposed through host-supported installation metadata or a plugin manifest.
- **Plugin-backed source**: full source discovered through a plugin skill root; repository identity still requires repository-bearing discovery evidence.
- **Synced source**: source materialized by an agent sync mechanism; sync status alone does not establish repository provenance.
- **Provenance evidence**: normalized observation supporting a source identity, ordered from explicit input through Git, plugin, manager, embedded metadata, and confirmation.
- **Local plugin identity**: host-local identifier used to group a plugin-backed source when repository evidence is absent; it is never portable repository provenance.
