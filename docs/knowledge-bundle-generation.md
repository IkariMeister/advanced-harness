# Knowledge bundle generation

`npm run knowledge:generate` regenerates the checked-in OKF v0.2 projection under
`knowledge/`. The explicit allowlist is defined in `scripts/generate-knowledge.ts`:
the glossary, ADR-003, and the OpenCode-native workflow. Runtime instructions,
agent templates, and operational memory are excluded.

Each resource is marked `status: draft` and includes its source document's latest
committed revision in a GitHub blob permalink. Generation checks Git's staged and
unstaged status for every source and projects the committed `HEAD` bytes, avoiding
false dirty detection from platform line-ending conversion. Commit or discard source
edits before generating. Validate all sources before changing any generated output;
only the four named bundle files are maintained. Index links are rooted at the
bundle root (for example, `/glossary.md`); relative links between projected sources
are rewritten to their projected targets, while other repository links point to
pinned committed revisions.

ADR-003 remains Proposed. The workflow records its approved direction separately
from the still-pending pilot. Neither projected draft status nor a Proposed ADR
accepts a decision or authorizes implementation; implementation follows its own
approved plan.

To roll back generated content, remove or regenerate the four files under
`knowledge/`. Do not revert or alter canonical source documents as part of bundle
rollback. The generator derives provenance from Git at runtime rather than storing
revision hashes in code.
