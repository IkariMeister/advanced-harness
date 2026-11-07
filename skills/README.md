# Procedure skills

Procedure skills are host-neutral source folders under `skills/<name>/SKILL.md`. The frontmatter requires `schemaVersion: 1`, a directory-matching canonical lowercase single-hyphen `name`, a nonblank description (at most 1024 characters), and a nonempty unique `intendedRoles` list selected from the native roles (`lead`, `operator`, `external`, `researcher`, `planner`, `implementer`, `reviewer`, `qa`). Unknown/duplicate fields, unsupported versions, malformed YAML, empty bodies, and invalid roles/names are rejected. Names are at most 64 characters; emitted names add `harness-procedure-` and must also fit the 64-character host limit.

The documentation procedures are `documentation-impact` (Planner and Implementer), `adr-authoring` (Planner), `technical-documentation` (Implementer), `documentation-validation` (Implementer and Reviewer), and `documentation-review` (Reviewer). These role references are advisory, not role discovery or enforcement. Validation and review consult `docs/glossary.md` and require human semantic judgment for undefined project terms or conflicting meanings.

Example:

```yaml
---
schemaVersion: 1
name: documentation-impact
description: Assess change impact on documentation and list artifacts needing updates.
intendedRoles: [planner, implementer]
---
List affected docs, their owners, and the reason when no change is needed.
```

Optional supporting files are retained recursively with their relative paths and exact bytes. Links, symlinks, junctions and other non-regular entries are rejected; traversal/absolute paths, unsafe Windows path components and case-insensitive collisions are not accepted. Skills are never executed. `npm run docs:check` separately checks bounded Markdown forms across root/docs/agents/commands/skills for local destinations, reference links, supported heading fragments, repository paths, package script names (inline and supported text/shell command fences), and native workflow-command names against the canonical registry. It also checks simple native `npm run` workflow steps. It is offline and does not execute documented commands. External URLs, machine-local paths, placeholders, illustrative Markdown/JSON fixtures, and arbitrary shell syntax are excluded; unsupported Markdown link forms are not guaranteed checked. The tool cannot perform semantic glossary review.

The compiler emits native frontmatter containing exactly `name` and `description`; neutral metadata is removed and intended-role guidance is added to the body as explicitly advisory. It creates no permissions or allowed-tools configuration and does not enforce approval, decision authority, or role discovery.

Host output locations are `.opencode/skills/<emitted-name>/SKILL.md`, `.claude/skills/<emitted-name>/SKILL.md`, and `.agents/skills/<emitted-name>/SKILL.md` for both Antigravity and Codex. The `harness-procedure-` namespace is reserved against workflow command IDs. Compilation is artifact generation only, not installation.

Concrete compiler smoke using the exported API:

```ts
import { loadProcedureSkill, emitProcedureSkill, combineProcedureSkillArtifacts } from './src/procedure-skills.ts';
const skill = loadProcedureSkill('./skills/documentation-impact');
const artifacts = ['opencode', 'claude-code', 'antigravity', 'codex']
  .flatMap(host => emitProcedureSkill(skill, host as 'opencode' | 'claude-code' | 'antigravity' | 'codex'));
const combined = combineProcedureSkillArtifacts([artifacts]);
```

Inspect generated files/frontmatter and advisory text, plus a nested support-file fixture and combined workflow artifacts. No host install/configuration or service access is involved.
