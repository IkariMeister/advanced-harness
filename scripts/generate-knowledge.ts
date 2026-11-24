import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { posix as posixPath } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  {
    source: "docs/glossary.md",
    output: "knowledge/glossary.md",
    type: "glossary",
    title: "Advanced Harness Glossary",
    description: "Canonical terminology used across Advanced Harness documentation.",
  },
  {
    source: "docs/adr/0003-multi-methodology-development-architecture.md",
    output: "knowledge/architecture/0003-multi-methodology-development-architecture.md",
    type: "architecture-decision",
    title: "Multi-Methodology Development Architecture",
    description: "Proposed architecture for methodology selection, execution boundaries, governance, and evaluation.",
  },
  {
    source: "docs/opencode-native-workflow.md",
    output: "knowledge/workflows/opencode-native-workflow.md",
    type: "workflow",
    title: "OpenCode-Native Workflow",
    description: "Approved workflow direction; native template configuration and a real-project pilot remain pending.",
  },
] as const;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function normalizeMarkdownLinks(markdown: string, source: string, commit: string): string {
  return markdown.replace(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label: string, rawTarget: string) => {
    const hash = rawTarget.indexOf("#");
    const target = hash < 0 ? rawTarget : rawTarget.slice(0, hash);
    const fragment = hash < 0 ? "" : rawTarget.slice(hash);
    if (!target || /^(?:[a-z]+:|\/)/i.test(target)) return whole;
    const relativeTarget = posixPath.normalize(posixPath.join(posixPath.dirname(source), target));
    if (relativeTarget === ".." || relativeTarget.startsWith("../")) return whole;
    const projected = sources.find((candidate) => candidate.source === relativeTarget);
    if (projected) {
      const path = `/${projected.output.slice("knowledge/".length)}`;
      return `[${label}](${path}${fragment})`;
    }
    try {
      const targetCommit = git("log", "-1", "--format=%H", commit, "--", relativeTarget);
      if (!targetCommit) return whole;
      execFileSync("git", ["cat-file", "-e", `${targetCommit}:${relativeTarget}`], { cwd: root, stdio: "ignore" });
      return `[${label}](https://github.com/IkariMeister/advanced-harness/blob/${targetCommit}/${relativeTarget}${fragment})`;
    } catch {
      return whole;
    }
  });
}

async function generate(): Promise<void> {
  const projected: { output: string; content: string }[] = [];
  for (const item of sources) {
    const commit = git("log", "-1", "--format=%H", "HEAD", "--", item.source);
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`No committed revision for ${item.source}`);
    const status = git("status", "--porcelain", "--", item.source);
    if (status) throw new Error(`Refusing staged or unstaged source changes: ${item.source}`);
    const committed = execFileSync("git", ["show", `HEAD:${item.source}`], { cwd: root });
    const body = normalizeMarkdownLinks(committed.toString("utf8").replace(/\r\n/g, "\n").replace(/\n*$/, "\n"), item.source, commit);
    const meta = [
      "---",
      `type: ${item.type}`,
      `title: ${yaml(item.title)}`,
      "status: draft",
      `description: ${yaml(item.description)}`,
      "sources:",
      `  - resource: ${yaml(`https://github.com/IkariMeister/advanced-harness/blob/${commit}/${item.source}`)}`,
      "---",
      "",
    ].join("\n");
    projected.push({ output: item.output, content: `${meta}${body}` });
  }

  const index = [
    "---",
    "okf_version: 0.2",
    "type: index",
    "---",
    "",
    "# Advanced Harness knowledge bundle",
    "",
    "Draft projections of selected project documentation. These derived resources do not change their source documents or lifecycle states.",
    "",
  ...sources.map((item) => `- [${item.title}](/${item.output.slice("knowledge/".length)}) — \`${item.type}\``),
    "",
  ].join("\n");
  projected.unshift({ output: "knowledge/index.md", content: index });

  // All inputs are checked and all outputs composed before the first filesystem write.
  for (const item of projected) await mkdir(dirname(resolve(root, item.output)), { recursive: true });
  for (const item of projected) await writeFile(resolve(root, item.output), item.content, "utf8");
}

generate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
