# Future knowledge-bundle contract (OKF v0.2)

**Status:** Future documentation contract; no populated knowledge directory or runtime implementation.

This document describes a proposed small repository knowledge bundle using the
upstream Open Knowledge Format (OKF) v0.2. It is not an implementation plan,
approval of ADR-003, or a claim that a bundle currently exists. Its purpose is to
make any later bundle's boundaries, metadata, provenance, and review expectations
explicit. The authoritative format source is the upstream
[OKF v0.2 specification](https://raw.githubusercontent.com/GoogleCloudPlatform/open-knowledge-format/main/SPEC.md);
this contract is a project-specific profile and summary, not a replacement for it.
This URL points to the upstream `main` branch and is therefore an unpinned v0.2
reference subject to drift, not an immutable snapshot. Recheck the authoritative
specification and revise this contract before representing a bundle as conforming.

## Scope and exclusions

The future bundle is for durable, curated knowledge that can be cited and reviewed.
It is distinct from the repository's ordinary documentation and from harness
operational memory. The following are out of scope: runtime instructions,
`AGENTS.md`, agent/command/procedure templates, operational memory, personal rules,
credentials, configuration snapshots, and operational evidence. Do not copy these
into a knowledge bundle merely because they are Markdown or useful context.

This contract reserves a possible `knowledge/` layout for a later, separately
approved implementation. The paths below describe that future layout only; they
are not current links or claims that these files exist:

| Future bundle path | Source | Type | Contract status |
| --- | --- | --- | --- |
| `knowledge/references/glossary.md` | `docs/glossary.md` | `reference` | `stable` representation |
| `knowledge/decisions/adr-0003.md` | `docs/adr/0003-multi-methodology-development-architecture.md` | `decision` | Explicitly `draft`; source ADR remains Proposed pending its pilot |
| `knowledge/guides/native-workflow.md` | `docs/opencode-native-workflow.md` | `guide` | `stable` representation |

These are candidate representations, not a direction to duplicate files now.
Source documents remain authoritative. A summary may condense a source but must not
strengthen, broaden, or change its claims. In particular, the ADR representation
must preserve its Proposed status and pending-pilot qualification; OKF `verified`
metadata, if ever used, must never be presented as human approval.

## OKF v0.2 baseline and project profile

The upstream rules are distinguished here from stricter project choices:

* For every non-reserved Markdown concept document, `type` is the sole universally
  required, nonempty frontmatter field. Producers define type values; the project
  uses the types in the table above.
* A concept ID is its path relative to the bundle, without `.md`. `index.md` and
  `log.md` are reserved filenames. Only a root `index.md` may carry
  `okf_version: '0.2'` frontmatter.
* This project profile additionally requires each concept to have nonempty
  `type`, `title`, `description`, `resource`, explicit `status`, and nonempty
  `sources`. This is stricter than the universal OKF minimum. `tags` are
  recommended, not mandatory.
* When `sources` is present, each source requires `resource`. For this project,
  source IDs are required so claims can cite them; footnote labels must match
  those IDs.
* Use absolute source-repository URLs together with canonical repository-relative
  paths as applicable. Do not invent or imply commit pins that have not been
  verified. A link beginning with `/` is relative to the knowledge-bundle root,
  not the repository root.
* Status values are `draft`, `stable`, or `deprecated`. OKF defaults absent status
  to `stable`; this profile requires an explicit value. `verified` is separate
  metadata and is not human approval.
* `generated` is optional in OKF and, if included by this profile, must be truthful:
  record only actual actors and timestamps. OKF `verified` is optional and, when
  present, represents verification events containing `by` (the actual actor) and
  `at` (an ISO 8601 datetime with an explicit UTC offset). It may be represented as
  a list or an accepted single mapping. Record only genuine verification events:
  do not invent actors or timestamps, and do not treat verification as ADR
  acceptance or human approval.

The above summarizes only the cited upstream v0.2 source and project profile.
Resolve any discrepancy against the authoritative specification; do not treat
project-specific requirements as universal OKF requirements.

## Acceptance criteria for a future bundle

A future proposal to populate this bundle is acceptable only when:

1. A separately approved scope identifies the selected source documents and
   confirms exclusions; no runtime changes or ADR status changes are implied.
2. The root index declares OKF version `0.2`; only the root index uses
   `okf_version`.
3. Every included non-reserved Markdown concept has the required nonempty project
   metadata, valid explicit status, and source entries with project-required IDs.
4. Citations resolve to authoritative sources, footnote labels match source IDs,
   and claims in summaries do not exceed the sources.
5. The three proposed representations use their mapped types and statuses,
   including the explicitly draft treatment of ADR-003.
6. Links distinguish bundle-root paths from repository paths and do not imply
   nonexistent files, validation, or approval.
7. Review confirms exclusions, provenance truthfulness, and conformance to the
   chosen upstream specification version.

## Maintenance

The source documents, not copied bundle representations, remain authoritative.
When a source changes, a future bundle owner should review the corresponding
representation and citations in the same change or record why it remains accurate.
Recheck the upstream specification before changing format claims. Changes to this
contract do not populate the proposed paths or authorize runtime behavior. Do not
change an ADR's lifecycle status through representation or metadata.

## Manual smoke prerequisites and procedure

This is a future manual smoke plan, not a completed validation result. Prerequisites:
an approved implementation scope, an actual bundle root with the listed candidate
files and root `index.md`, access to the authoritative upstream v0.2 specification,
and a human reviewer able to inspect sources and links. Until those prerequisites
exist, the check is unavailable and no pass is claimed.

1. Confirm the bundle root and required files exist; stop if they do not.
2. Inspect root `index.md` and confirm it alone declares `okf_version: '0.2'`.
3. Inspect each non-reserved Markdown file for nonempty project-required metadata,
   explicit valid status, and source IDs/resources; verify footnote labels.
4. Resolve each citation and link, distinguishing bundle-root `/` paths from
   repository paths. Confirm canonical sources and avoid unsupported pin claims.
5. Compare each representation with its source. Confirm glossary/native-workflow
   mappings are stable and ADR-003 remains draft with Proposed/pending-pilot
   meaning intact.
6. Confirm no excluded operational material or false generated/verification
   attribution was added. Record the actual outcome and any unresolved issue; do
   not equate conformance or `verified` with approval.
