---
schemaVersion: 1
name: documentation-validation
description: Validate documentation links, commands, examples, and implementation alignment.
intendedRoles: [implementer, reviewer]
---
# Documentation validation

Run applicable repository checks and inspect changed documentation against implementation, requirements, configuration, and approved decisions. Check local links, heading fragments, images, repository paths, package scripts, and documented native workflow commands. Record exact commands/results; validation is evidence, not acceptance.

Consult the project [glossary](../../docs/glossary.md). Use semantic judgment to flag project-specific terms missing from it and terms used with conflicting meanings; automated checking cannot guarantee this natural-language review. Report unsupported forms or exclusions explicitly rather than implying they were validated.
