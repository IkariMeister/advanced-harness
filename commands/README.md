# Canonical workflow command sources

The six `*.md` files in this directory are the canonical command definitions. Their
versioned YAML frontmatter records schema and argument-binding metadata; Markdown bodies
are the source prompt text. `.opencode/commands/*.md` are generated OpenCode outputs and
must match the OpenCode emitter exactly. Edit the canonical sources, then regenerate
outputs; do not edit generated files independently.

`arguments.mode: full` binds the complete caller-provided argument string to the
template's `$ARGUMENTS` placeholder. The `report-defect` positional contract names
`$1` as `parent` and `$2` as `description`, with the second field consuming the
remainder. This records host bindings only: it does not tokenize, quote, validate, or
execute user input. Missing or unclear information is handled by the command's
clarification instructions. Inserted argument text is not recursively substituted.

Native host compilers may emit only the metadata and bindings their verified native
contracts support. Neutral schema fields must not leak into host-specific command
files. Command prose does not grant workflow permissions or infer `allowedTools`.
When an installed generated output has user customizations, preview/conflict handling
must be used; never overwrite it blindly.
