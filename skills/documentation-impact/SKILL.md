---
schemaVersion: 1
name: documentation-impact
description: Assess change impact on documentation and list artifacts needing updates.
intendedRoles: [planner, implementer]
---
# Documentation impact

Identify material changes to APIs, integration contracts, installation/configuration, user-visible behavior, developer workflows, architecture, supported hosts, agent responsibilities, permissions, commands, and relied-upon repository instructions.

List each affected artifact, why it needs an update, and who owns that update; make ownership of each documentation change explicit in the plan, following the responsibilities in ADR-001. Check whether an existing ADR needs a status or decision update, and flag it rather than changing it: only the human decision and project process may change ADR status. If no update is warranted, record the reason; do not invent documentation work for trivial changes. When uncertain, make the uncertainty explicit and consult `docs/adr/0001-documentation-ownership-through-shared-skills.md`.

Use the project [glossary](../../docs/glossary.md) for project terms.
