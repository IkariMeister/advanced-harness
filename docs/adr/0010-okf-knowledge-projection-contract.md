# ADR: Open Knowledge Format Projection Contract

**Status:** Proposed\
**Date:** 2026-11-15\
**Project:** Advanced Harness\
**Decision scope:** Contract for projecting selected Advanced Harness documentation into an Open Knowledge Format (OKF) bundle

## Context

Advanced Harness documentation is the source material for a future generated knowledge bundle. Issue #205 defines the projection contract; issue #206 owns generation. The contract must identify each source and its projected resource, preserve source status rather than imply acceptance, and make provenance verifiable against the source revision. It must also define bundle indexing and exclude operational material that is not knowledge content.

The referenced specification is OKF v0.2 at [the immutable GitHub blob API](https://api.github.com/repos/GoogleCloudPlatform/open-knowledge-format/git/blobs/c06e3eede0c910d0ecf12524c34204156f8795ac), verified at blob revision `c06e3eede0c910d0ecf12524c34204156f8795ac`. The API response contains Base64-encoded `SPEC.md`. This ADR specifies the project's projection contract using that version; it does not implement a generator or create bundle files.

## Decision Drivers

1. Preserve traceable provenance from every projected resource to a real source revision.
2. Keep the initial projection small, explicit, and reviewable.
3. Preserve source lifecycle states without presenting recommendations as accepted decisions.
4. Keep generated knowledge content separate from runtime instructions, agent templates, and operational memory.
5. Allow issue #206 to implement generation against a stable contract.

## Considered Options

### A. Project every documentation file

This maximizes coverage, but mixes operational instructions and templates with reusable knowledge, expands the initial review surface, and makes provenance and lifecycle handling harder to assess. Rejected for the initial projection.

### B. Define a bounded, provenance-backed projection (chosen)

Name the initial source-to-resource mappings, require OKF metadata and source permalinks, and specify a bundle index and exclusions. This gives issue #206 a clear target while leaving generation and future source selection to follow-up work.

### C. Generate knowledge files as part of this decision

This would conflate the format contract with implementation and could create stale projections before a generator exists. Rejected; issue #206 owns generation.

## Decision

Use OKF v0.2 for the knowledge bundle projection. Each projected document is represented by an OKF resource with a nonempty `type` and a nonempty `sources[]`. Every source entry must include a `resource` permalink identifying the real source revision (for example, a repository URL pinned to a commit and path). Optional resource metadata includes `title`, `description`, a concept-level `resource`, and `tags`. When an actor is recorded, its identity must be verified; do not invent or infer actor identity.

The initial source mappings are:

| Source document | OKF type | Projected resource |
| --- | --- | --- |
| `docs/glossary.md` | `glossary` | `knowledge/glossary.md` |
| `docs/adr/0003-multi-methodology-development-architecture.md` | `architecture-decision` | `knowledge/architecture/0003-multi-methodology-development-architecture.md` |
| `docs/opencode-native-workflow.md` | `workflow` | `knowledge/workflows/opencode-native-workflow.md` |

Initial projections have `status: draft`. Preserve the source's own status separately: ADR 0003 remains `Proposed`, and the workflow projection records its approved direction while retaining that its pilot is pending. A draft projection status does not rewrite, accept, or override the source status.

The bundle root contains `knowledge/index.md`. Its front matter includes `okf_version: 0.2`; its resource links use OKF root-absolute syntax, rooted at the bundle root. The index enumerates the initial projected resources and their types. Exclude runtime instructions, agent templates, and operational memory from this knowledge bundle.

Proposing this contract does not accept the ADR, authorize implementation, or change current behavior. Acceptance of this ADR would establish project direction only. Generation still requires its own approved implementation plan; issue #206 owns that follow-up.

## Consequences

**Positive:** Projected resources have explicit types, revision-pinned provenance, bounded initial scope, and source-state preservation. The generator can be implemented and reviewed against a stable contract.

**Negative:** The initial bundle will omit potentially useful material outside the three named sources. Provenance permalinks and any recorded actor identity require verification.

**Neutral:** The OKF bundle is a derived representation. The Advanced Harness documents remain authoritative, and projection status remains distinct from source lifecycle status.

## Adoption

Accepting this ADR does not authorize implementation. A separate approved plan for issue #206 must define generator behavior, validation, output/update handling, and rollback. That work must satisfy these acceptance criteria:

1. The generated bundle uses OKF v0.2 and includes the three source-to-resource mappings in this ADR, with the required type and nonempty `sources[]` metadata.
2. Every source entry's permalink resolves to the real source revision and path; an actor is included only when identity is verified.
3. Resource projections use `status: draft` and preserve source status separately, including ADR 0003's `Proposed` status and the workflow's approved direction with its pilot pending.
4. `knowledge/index.md` declares `okf_version: 0.2` and links to bundle resources using OKF root-absolute syntax relative to the bundle root.
5. Runtime instructions, agent templates, and operational memory are excluded.
6. Documentation and validation make clear that Proposed governance and a future ADR acceptance do not themselves authorize implementation; implementation requires its own approved plan.

Rollback of a future generator implementation must remove or regenerate derived bundle outputs without altering the source documents or their recorded states. Generator implementation, generated knowledge files, and any expansion of the source set are follow-up scope for issue #206 or separately approved work, not this ADR proposal.

## Reconsideration

Revisit this contract if OKF changes incompatibly from v0.2, a named source no longer represents the intended project knowledge, source revision permalinks cannot be maintained, or the initial projection demonstrates that the status or index rules misrepresent source meaning. Review the contract when issue #206 closes and at each milestone close.

## References

- [OKF v0.2 specification blob](https://api.github.com/repos/GoogleCloudPlatform/open-knowledge-format/git/blobs/c06e3eede0c910d0ecf12524c34204156f8795ac) (response contains Base64-encoded `SPEC.md`; verified blob `c06e3eede0c910d0ecf12524c34204156f8795ac`)
- [Issue #205](https://github.com/IkariMeister/advanced-harness/issues/205) — projection contract
- [Issue #206](https://github.com/IkariMeister/advanced-harness/issues/206) — knowledge generation follow-up
- [ADR-003](0003-multi-methodology-development-architecture.md)
- [Glossary](../glossary.md)
- [OpenCode native workflow](../opencode-native-workflow.md)
