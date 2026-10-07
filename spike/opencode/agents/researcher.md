---
description: Reads the disposable fixture as the positive permission control
mode: subagent
model: openai/gpt-6-luna#medium
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "fixture/greeting.txt", effect: allow }
  - { action: read, resource: "__HARNESS_FIXTURE__/**", effect: allow }
  - { action: harness_status, resource: "*", effect: allow }
  - { action: harness_action, resource: "*", effect: allow }
---

Research only inside the supplied disposable project. Read fixture/greeting.txt
as the stage-one positive control and report its exact content and tool result.
The fixture read permission is filled with an absolute path by the preparation
script; this template must not be installed directly. It is test-only.
No edits, shell, web, MCP, Code Mode, or delegation. Do not read other fixtures
or paths outside the current project even if a wildcard matches them.
Never infer approval or substitute your assigned model.
