import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const sourceEntries = [
  ["docs/glossary.md", "knowledge/glossary.md", "glossary"],
  ["docs/adr/0003-multi-methodology-development-architecture.md", "knowledge/architecture/0003-multi-methodology-development-architecture.md", "architecture-decision"],
  ["docs/opencode-native-workflow.md", "knowledge/workflows/opencode-native-workflow.md", "workflow"],
] as const;
const outputs = ["knowledge/index.md", ...sourceEntries.map(([, output]) => output)];

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "knowledge-generator-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  for (const [source] of sourceEntries) {
    const path = join(repo, source);
    await mkdir(join(path, ".."), { recursive: true });
    const text = source.includes("glossary")
      ? "# Glossary\n\n[Architecture](adr/0003-multi-methodology-development-architecture.md#rdd)\n[Reviewer](../agents/reviewer.md#review)\n"
      : source.includes("0003")
        ? "# ADR-003\n\n## RDD\n\n**Status:** Proposed\n\n[Glossary](../glossary.md)\n"
        : "# Workflow\n\n**Status:** approved direction; pilot pending.\n\n[ADR](adr/0003-multi-methodology-development-architecture.md)\n";
    await writeFile(path, text);
  }
  await writeFile(join(repo, ".gitattributes"), "docs/**/*.md text eol=lf\nagents/**/*.md text eol=lf\n");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(join(repo, "agents"), { recursive: true });
  await writeFile(join(repo, "agents", "reviewer.md"), "# Reviewer\n\n## Review\n\nFixture review guidance.\n");
  const generator = await readFile(join(process.cwd(), "scripts/generate-knowledge.ts"), "utf8");
  await writeFile(join(repo, "scripts", "generate-knowledge.ts"), generator);
  git("add", ".");
  git("commit", "-qm", "fixture");
  const runner = join(repo, "scripts", "run.mjs");
  await writeFile(runner, `import { execFileSync } from "node:child_process";\nexecFileSync(process.execPath, [${JSON.stringify(join(repo, "scripts", "generate-knowledge.ts").replaceAll("\\", "/"))}], { cwd: ${JSON.stringify(repo)}, stdio: "inherit" });\n`);
  return { root: repo, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("generator emits parseable draft resources, valid root links and pinned source links deterministically", async () => {
  const f = await fixture();
  try {
    const run = () => execFileSync(process.execPath, [join(f.root, "scripts/run.mjs")], { cwd: process.cwd(), stdio: "pipe" });
    run();
    const first = await Promise.all(outputs.map((path) => readFile(join(f.root, path))));
    run();
    const second = await Promise.all(outputs.map((path) => readFile(join(f.root, path))));
    first.forEach((bytes, i) => assert.deepEqual(bytes, second[i]));
    const indexText = first[0]!.toString("utf8");
    const indexBlock = indexText.match(/^---\n([\s\S]*?)\n---/)?.[1];
    assert.ok(indexBlock, "index metadata block is present");
    const indexMeta = parse(indexBlock);
    assert.equal(indexMeta.okf_version, 0.2);
    for (const [source, output, type] of sourceEntries) {
      const text = (await readFile(join(f.root, output), "utf8"));
      const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
      assert.ok(block, `metadata block exists for ${output}`);
      const metadata = parse(block);
      assert.equal(metadata.type, type);
      assert.equal(metadata.status, "draft");
      assert.equal(metadata.sources.length, 1);
      const [, commit, path] = metadata.sources[0].resource.match(/blob\/([0-9a-f]{40})\/(.+)$/) ?? [];
      assert.equal(path, source);
      assert.equal(execFileSync("git", ["cat-file", "-e", `${commit}:${source}`], { cwd: f.root }).length, 0);
      if (type === "architecture-decision") assert.match(text, /Status:\*\* Proposed/);
      if (type === "workflow") {
        assert.match(text, /approved direction/i);
        assert.match(text, /pilot pending/i);
      }
    }
    const links = [...indexText.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    assert.deepEqual(links, outputs.slice(1).map((path) => `/${path.slice("knowledge/".length)}`));
    const glossary = await readFile(join(f.root, sourceEntries[0][1]), "utf8");
    assert.match(glossary, /\]\(\/architecture\/0003-multi-methodology-development-architecture\.md#rdd\)/);
    const architectureHref = glossary.match(/\]\((\/architecture\/0003-multi-methodology-development-architecture\.md#rdd)\)/)?.[1];
    assert.ok(architectureHref, "mapped ADR link with fragment is present");
    const [architecturePath, architectureFragment] = architectureHref.split("#");
    const architectureText = await readFile(join(f.root, "knowledge", architecturePath!.slice(1)), "utf8");
    assert.ok(architectureText.includes(`## ${architectureFragment!.toUpperCase()}`));
    const reviewerMatch = glossary.match(/\]\((https:\/\/github\.com\/IkariMeister\/advanced-harness\/blob\/([0-9a-f]{40})\/agents\/reviewer\.md#review)\)/);
    assert.ok(reviewerMatch, "reviewer link has an exact pinned fixture commit");
    const reviewerCommit = reviewerMatch[2]!;
    const reviewerText = execFileSync("git", ["show", `${reviewerCommit}:agents/reviewer.md`], { cwd: f.root, encoding: "utf8" });
    assert.match(reviewerText, /^## Review$/m);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim(), reviewerCommit);
  } finally {
    await f.cleanup();
  }
});

test("staged and unstaged source edits are refused without changing any outputs", async () => {
  for (const dirtyMode of ["staged", "unstaged"] as const) {
    const f = await fixture();
    try {
      await materializeCrlfFixture(f.root);
      execFileSync(process.execPath, [join(f.root, "scripts/run.mjs")], { cwd: process.cwd(), stdio: "pipe" });
      const before = await Promise.all(outputs.map((path) => readFile(join(f.root, path))));
      const source = join(f.root, sourceEntries[0][0]);
      await writeFile(source, `${await readFile(source, "utf8")}\nchanged\n`);
      if (dirtyMode === "staged") execFileSync("git", ["add", sourceEntries[0][0]], { cwd: f.root });
      assert.throws(() => execFileSync(process.execPath, [join(f.root, "scripts/run.mjs")], { cwd: process.cwd(), stdio: "pipe" }));
      const after = await Promise.all(outputs.map((path) => readFile(join(f.root, path))));
      before.forEach((bytes, i) => assert.deepEqual(bytes, after[i]));
    } finally {
      await f.cleanup();
    }
  }
});

test("clean CRLF checkout converts to deterministic LF committed-byte projection", async () => {
  const f = await fixture();
  try {
    await materializeCrlfFixture(f.root);
    const source = join(f.root, sourceEntries[0][0]);
    const checkedOut = await readFile(source);
    assert.ok(checkedOut.includes(Buffer.from("\r\n")));
    const committed = execFileSync("git", ["show", `HEAD:${sourceEntries[0][0]}`], { cwd: f.root });
    assert.ok(!committed.includes(Buffer.from("\r\n")));
    const run = () => execFileSync(process.execPath, [join(f.root, "scripts/run.mjs")], { cwd: process.cwd(), stdio: "pipe" });
    run();
    const first = await Promise.all(outputs.map((path) => readFile(join(f.root, path))));
    run();
    const second = await Promise.all(outputs.map((path) => readFile(join(f.root, path))));
    first.forEach((bytes, index) => assert.deepEqual(bytes, second[index]));
    const projection = first[1]!.toString("utf8");
    assert.ok(!projection.includes("\r"));
    assert.match(projection, /^---\n[\s\S]*?\n---\n(?:\s*\n)*# Glossary\n/);
    assert.match(projection, /\[Architecture\]\(\/architecture\/0003-multi-methodology-development-architecture\.md#rdd\)/);
  } finally {
    await f.cleanup();
  }
});

async function materializeCrlfFixture(root: string): Promise<void> {
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["config", "core.eol", "crlf"], { cwd: root });
  const attributes = await readFile(join(root, ".gitattributes"), "utf8");
  await writeFile(join(root, ".gitattributes"), attributes.replaceAll("text eol=lf", "text eol=crlf"));
  execFileSync("git", ["add", ".gitattributes"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture CRLF attributes"], { cwd: root });
  const sourcePaths = sourceEntries.map(([source]) => source);
  const allPaths = [...sourcePaths, "agents/reviewer.md"];
  for (const path of allPaths) await rm(join(root, path), { force: true });
  execFileSync("git", ["checkout-index", "--force", "-u", "--", ...allPaths], { cwd: root });
  for (const path of sourcePaths) {
    const checkedOut = await readFile(join(root, path));
    const committed = execFileSync("git", ["show", `HEAD:${path}`], { cwd: root });
    assert.equal(execFileSync("git", ["status", "--porcelain", "--", path], { cwd: root, encoding: "utf8" }).trim(), "", `${path} CRLF checkout is clean`);
    assert.ok(checkedOut.includes(Buffer.from("\r\n")), `${path} checkout is CRLF`);
    assert.ok(!committed.includes(Buffer.from("\r\n")), `${path} committed blob is LF`);
  }
}
