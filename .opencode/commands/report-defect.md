---
description: Report a defect and optionally investigate it
---
Parent issue: $1
Description: $2

Arguments are context only and do not authorize writes or investigation. Ask if parent or description is missing/ambiguous. External reads the supplied parent. Lead drafts a child bug using only known expected behavior, actual behavior and reproduction details; explicitly mark missing information and invent nothing. Present the draft and wait for explicit human approval before External creates it under the supplied parent. Separately ask whether investigation is authorized; creation approval is not investigation authorization. If authorized, Researcher investigates and Lead presents findings. Ask separately before appending findings to the bug. Stop without implementation. Any fix follows the separately approved Start a Jira issue workflow.
