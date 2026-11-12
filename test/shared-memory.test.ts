import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, unlinkSync, readdirSync, openSync, closeSync, chmodSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  validateBootstrapContext,
  checkBootstrapReadiness,
  validateMemoryEntry,
  parseMemoryEntryLine,
  parseSharedMemory,
  formatSharedMemory,
  deduplicateMemoryEntries,
  detectMemoryConflicts,
  readSharedMemory,
  writeSharedMemorySerialized,
  planRulePromotion,
  applyApprovedRulePromotion,
  resolvePersonalRulesPath,
  parsePersonalRules,
  validatePersonalRuleText,
  formatPersonalRules,
  readPersonalRules,
  writePersonalRulesSerialized,
  detectPersonalRuleContradictions,
  detectPruningCandidates,
  planMemoryPruning,
  markEntryReviewed,
  applyApprovedMemoryPruning,
  computePruningPlanHash,
  validatePromotedRuleText,
  MemoryPruningApplyError,
  type MemoryEntry,
  type BootstrapContext,
  type PruningCandidate,
  type PruningDisposition,
  type TriStateResult,
} from '../src/shared-memory.ts';

function createFixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-mem-test-'));
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  const projectRoot = join(dir, 'repo');
  const worktreeDirectory = join(dir, 'worktrees');
  const memoryDir = join(dir, 'data');
  const memoryPath = join(memoryDir, 'MEMORY.md');
  return { dir, projectRoot, worktreeDirectory, memoryPath };
}

test('validateBootstrapContext validates valid paths and rejects violations', (t) => {
  const { projectRoot, worktreeDirectory, memoryPath } = createFixture(t);
  const valid: BootstrapContext = {
    projectRoot,
    baseBranch: 'main',
    worktreeDirectory,
    memoryPath,
  };
  assert.deepEqual(validateBootstrapContext(valid), valid);

  // Rejects invalid branches
  assert.throws(() => validateBootstrapContext({ ...valid, baseBranch: 'main..dev' }), /Invalid baseBranch/);
  assert.throws(() => validateBootstrapContext({ ...valid, baseBranch: '@' }), /Invalid baseBranch/);
  assert.throws(() => validateBootstrapContext({ ...valid, baseBranch: 'feature with space' }), /Invalid baseBranch/);

  // Rejects worktree inside project
  assert.throws(() => validateBootstrapContext({ ...valid, worktreeDirectory: join(projectRoot, 'trees') }), /Worktree parent directory must be outside/);

  // Rejects memory inside project
  assert.throws(() => validateBootstrapContext({ ...valid, memoryPath: join(projectRoot, 'MEMORY.md') }), /Shared memory must be outside/);

  // Rejects memory not ending in MEMORY.md
  assert.throws(() => validateBootstrapContext({ ...valid, memoryPath: join(worktreeDirectory, '..', 'data', 'notes.txt') }), /must end in MEMORY.md/);

  // Rejects memory inside worktree parent
  assert.throws(() => validateBootstrapContext({ ...valid, memoryPath: join(worktreeDirectory, 'MEMORY.md') }), /must not be inside the worktree parent/);
});

test('checkBootstrapReadiness permits existing worktrees but flags target collisions', (t) => {
  const { projectRoot, worktreeDirectory, memoryPath } = createFixture(t);
  const context: BootstrapContext = {
    projectRoot,
    baseBranch: 'main',
    worktreeDirectory,
    memoryPath,
  };

  // Ready when target is fresh, even if other worktrees and branches exist
  const ready = checkBootstrapReadiness({
    context,
    targetBranch: 'feature/bh012',
    targetWorktreePath: join(worktreeDirectory, 'feature-bh012'),
    existingBranches: ['main', 'feature/bh009', 'feature/bh010'],
    existingWorktrees: [projectRoot, join(worktreeDirectory, 'feature-bh009')],
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.reasons.length, 0);

  // Blocked when target branch already exists
  const branchCollision = checkBootstrapReadiness({
    context,
    targetBranch: 'feature/bh009',
    targetWorktreePath: join(worktreeDirectory, 'feature-bh009-new'),
    existingBranches: ['main', 'feature/bh009'],
  });
  assert.equal(branchCollision.status, 'blocked');
  assert.ok(branchCollision.reasons.some(r => r.includes('Target branch "feature/bh009" already exists.')));

  // Blocked when target worktree already registered
  const wtCollision = checkBootstrapReadiness({
    context,
    targetBranch: 'feature/bh012',
    targetWorktreePath: join(worktreeDirectory, 'feature-bh009'),
    existingWorktrees: [join(worktreeDirectory, 'feature-bh009')],
  });
  assert.equal(wtCollision.status, 'blocked');
  assert.ok(wtCollision.reasons.some(r => r.includes('already registered in Git worktrees')));

  // Blocked when target worktree is outside worktree parent
  const outsideWt = checkBootstrapReadiness({
    context,
    targetBranch: 'feature/bh012',
    targetWorktreePath: join(projectRoot, 'trees', 'feature-bh012'),
  });
  assert.equal(outsideWt.status, 'blocked');
  assert.ok(outsideWt.reasons.some(r => r.includes('not inside configured worktree parent')));
});

test('Memory entry validation and parsing enforce structure, rejection of secrets and log dumps', () => {
  const valid: MemoryEntry = {
    source: 'Human confirmation',
    scope: 'Advanced Harness BH-012',
    confirmation: 'explicitly approved',
    fact: 'Feature worktree path is agreed.',
  };
  validateMemoryEntry(valid);

  // Line parser round-trips
  const line = `- [Source: Human confirmation; scope: Advanced Harness BH-012; confirmation: explicitly approved] Feature worktree path is agreed.`;
  const parsed = parseMemoryEntryLine(line);
  assert.deepEqual(parsed, valid);

  // Rejects empty fields
  assert.throws(() => validateMemoryEntry({ ...valid, source: '' }), /source cannot be empty/);
  assert.throws(() => validateMemoryEntry({ ...valid, scope: '   ' }), /scope cannot be empty/);
  assert.throws(() => validateMemoryEntry({ ...valid, confirmation: '' }), /confirmation cannot be empty/);
  assert.throws(() => validateMemoryEntry({ ...valid, fact: '' }), /fact cannot be empty/);

  // Rejects credentials / secrets
  assert.throws(() => validateMemoryEntry({ ...valid, fact: 'Token was ghp_123456789012345678901234567890.' }), /potential secret or credential/);
  assert.throws(() => validateMemoryEntry({ ...valid, fact: 'OpenAI key sk-123456789012345678901234567890.' }), /potential secret or credential/);
  assert.throws(() => validateMemoryEntry({ ...valid, fact: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz' }), /potential secret or credential/);
  assert.throws(() => validateMemoryEntry({ ...valid, fact: 'http://user:password123@internal.corp/git' }), /potential secret or credential/);
  assert.throws(() => validateMemoryEntry({ ...valid, fact: 'password=supersecret123' }), /potential secret or credential/);
  assert.throws(() => validateMemoryEntry({ ...valid, fact: '-----BEGIN PRIVATE KEY-----' }), /potential secret or credential/);

  // Rejects multiline or gigantic raw operational log dump
  assert.throws(() => validateMemoryEntry({ ...valid, fact: 'Line 1\nLine 2' }), /must not contain raw newlines/);
  assert.throws(() => validateMemoryEntry({ ...valid, fact: 'x'.repeat(2001) }), /Operational log dumps are not permitted/);
  for (const field of ['source', 'scope', 'confirmation'] as const) {
    assert.throws(() => formatSharedMemory([{ ...valid, [field]: `value; scope: forged` }]), /unsupported delimiters/);
    assert.throws(() => formatSharedMemory([{ ...valid, [field]: 'first\nsecond' }]), /raw newlines/);
    const entry = { ...valid, [field]: 'safe value' };
    assert.deepEqual(parseSharedMemory(formatSharedMemory([entry])), [entry]);
  }
  for (const field of ['source', 'scope', 'confirmation', 'fact'] as const) {
    for (const newline of ['\n', '\r']) {
      assert.throws(() => formatSharedMemory([{ ...valid, [field]: `${newline}value` }]), /raw newlines/);
      assert.throws(() => formatSharedMemory([{ ...valid, [field]: `value${newline}` }]), /raw newlines/);
    }
  }
});

test('shared memory parser accepts generated and entry-only files but rejects unsupported lines with safe line numbers', () => {
  const entry: MemoryEntry = { source: 'Human', scope: 'Setup', confirmation: 'approved', fact: 'Use the selected context.' };
  const formatted = formatSharedMemory([entry]);
  assert.deepEqual(parseSharedMemory(formatted), [entry]);
  assert.deepEqual(parseSharedMemory(formatted.replace(/\n/g, '\r\n')), [entry]);
  assert.deepEqual(parseSharedMemory(`\uFEFF${formatted}`), [entry]);
  assert.deepEqual(parseSharedMemory(''), []);
  assert.deepEqual(parseSharedMemory('\n  \n'), []);
  assert.deepEqual(parseSharedMemory('\n- [Source: Human; scope: Setup; confirmation: approved] Use the selected context.'), [entry]);
  for (const malformed of ['legacy private note', '# Different memory format', '- not a structured entry']) {
    assert.throws(() => parseSharedMemory(`\n${malformed}`), /line 2/);
  }
  assert.throws(() => parseSharedMemory(`\nprivate-key-material`), err => {
    assert.match((err as Error).message, /line 2/);
    assert.doesNotMatch((err as Error).message, /private-key-material/);
    return true;
  });
});

test('deduplicateMemoryEntries removes normalized duplicate entries idempotently', () => {
  const entries: MemoryEntry[] = [
    { source: 'Human', scope: 'Setup', confirmation: 'approved', fact: 'Path is X' },
    { source: ' human ', scope: 'setup', confirmation: ' APPROVED ', fact: 'Path is X' },
    { source: 'Human', scope: 'Setup', confirmation: 'approved', fact: 'Path is Y' },
  ];
  const deduplicated = deduplicateMemoryEntries(entries);
  assert.equal(deduplicated.length, 2);
  assert.equal(deduplicated[0]!.fact, 'Path is X');
  assert.equal(deduplicated[1]!.fact, 'Path is Y');
});

test('detectMemoryConflicts surfaces conflicting facts and AGENTS violations unless confirmed replacement', () => {
  const existing: MemoryEntry[] = [
    { source: 'Human', scope: 'GitHub Integration', confirmation: 'approved', fact: 'Use gh CLI for github.com' },
  ];

  // Contradictory fact in same scope without replacement keyword
  const conflict = detectMemoryConflicts(
    existing,
    { source: 'Operator', scope: 'GitHub Integration', confirmation: 'reported', fact: 'Use mcp backend for github.com' }
  );
  assert.equal(conflict.hasConflict, true);
  assert.match(conflict.reason ?? '', /Potential conflict in scope "GitHub Integration"/);

  // Allowed when confirmation explicitly states replacement
  const replacement = detectMemoryConflicts(
    existing,
    { source: 'Human', scope: 'GitHub Integration', confirmation: 'replacement approved', fact: 'Use mcp backend for github.com' }
  );
  assert.equal(replacement.hasConflict, false);

  // Contradicts AGENTS.md rule
  const agentsText = '# Project rules\n\nOnly a human merges. Merging remains human-only.\n';
  const mergeConflict = detectMemoryConflicts(
    existing,
    { source: 'Lead', scope: 'Release', confirmation: 'reported', fact: 'Operator auto-merges the PR.' },
    agentsText
  );
  assert.equal(mergeConflict.hasConflict, true);
  assert.match(mergeConflict.reason ?? '', /contradicts AGENTS.md instruction/);
});

test('multi-worktree fixture: shared MEMORY.md serialized writes and concurrent conflict refusal', (t) => {
  const { worktreeDirectory, memoryPath } = createFixture(t);
  const wt1 = join(worktreeDirectory, 'feature-alpha');
  const wt2 = join(worktreeDirectory, 'feature-beta');

  // Initial read when file does not exist
  const initial = readSharedMemory(memoryPath);
  assert.equal(initial.exists, false);
  assert.equal(initial.entries.length, 0);

  // WT1 writes first entry
  const entry1: MemoryEntry = {
    source: 'WT1',
    scope: 'Alpha Task',
    confirmation: 'approved',
    fact: 'Initialized alpha feature in worktree.',
  };
  const write1 = writeSharedMemorySerialized(memoryPath, [entry1], initial.hash);
  assert.equal(write1.success, true);

  // WT2 reads the updated memory
  const wt2Read = readSharedMemory(memoryPath);
  assert.equal(wt2Read.exists, true);
  assert.equal(wt2Read.entries.length, 1);
  assert.equal(wt2Read.hash, write1.hash);

  // WT2 appends its entry using WT2's fresh baseline hash
  const entry2: MemoryEntry = {
    source: 'WT2',
    scope: 'Beta Task',
    confirmation: 'approved',
    fact: 'Beta worktree started concurrently.',
  };
  const write2 = writeSharedMemorySerialized(memoryPath, [...wt2Read.entries, entry2], wt2Read.hash);
  assert.equal(write2.success, true);

  // WT1 tries to write with stale initial.hash or stale write1.hash -> refused
  assert.throws(
    () => writeSharedMemorySerialized(memoryPath, [entry1], initial.hash),
    /Concurrent modification detected on shared MEMORY.md/
  );
  assert.throws(
    () => writeSharedMemorySerialized(memoryPath, [entry1], write1.hash),
    /Concurrent modification detected on shared MEMORY.md/
  );

  // File on disk remains intact with both entries
  const finalRead = readSharedMemory(memoryPath);
  assert.equal(finalRead.entries.length, 2);
  assert.equal(finalRead.entries[0]!.scope, 'Alpha Task');
  assert.equal(finalRead.entries[1]!.scope, 'Beta Task');
});

test('simultaneous child-process writers contend on the lock and preserve the winner', async (t) => {
  const { memoryPath } = createFixture(t);
  mkdirSync(join(memoryPath, '..'), { recursive: true });
  const baseline = readSharedMemory(memoryPath);
  const a: MemoryEntry = { source: 'A', scope: 'A', confirmation: 'approved', fact: 'writer A' };
  const b: MemoryEntry = { source: 'B', scope: 'B', confirmation: 'approved', fact: 'writer B' };
  const script = `import { syncBuiltinESMExports } from 'node:module';\nimport fs from 'node:fs';\nconst originalWrite=fs.writeFileSync;\nconst [path, fact, barrier, ready, lockAcquired] = process.argv.slice(1);\nfs.writeFileSync = function(file, ...args) { if (String(file).endsWith('.tmp')) { originalWrite(ready, 'acquired'); const until=Date.now()+7000; while (!fs.existsSync(barrier)) { if(Date.now()>until) throw new Error('writer barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } } return originalWrite(file,...args); };\nsyncBuiltinESMExports();\nconst { writeSharedMemorySerialized, readSharedMemory } = await import(${JSON.stringify(new URL('../src/shared-memory.ts', import.meta.url).href)});\nconst baseline=readSharedMemory(path).hash; originalWrite(lockAcquired,'baseline');\ntry { writeSharedMemorySerialized(path,[{source:fact,scope:fact,confirmation:'approved',fact}],baseline); console.log('won:'+fact); } catch(e) { console.log('lost:'+fact+':'+e.message); }`;
  const runnerArgs = process.execArgv.filter(arg => arg.includes('loader') || arg.startsWith('--experimental-strip-types') || arg.startsWith('--import'));
  const children = new Set<ReturnType<typeof spawn>>();
  const runChild = (fact: string, barrier: string, ready: string, baselineReady: string) => new Promise<string>((resolve, reject) => {
    const args = [...runnerArgs, '--input-type=module', '-e', script, memoryPath, fact, barrier, ready, baselineReady];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const timeout=setTimeout(()=>child.kill(),10000);
    let out = ''; let err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); children.delete(child); code === 0 ? resolve(out.trim()) : reject(new Error(`child exit ${code}: ${err}`)); });
  });
  const lockPath = `${memoryPath}.lock`;
  const ownerScript = `import {openSync,closeSync,unlinkSync} from 'node:fs'; const p=${JSON.stringify(lockPath)}; const fd=openSync(p,'wx'); console.log('locked'); process.stdin.once('data',()=>{closeSync(fd);unlinkSync(p);});`;
  let owner: ReturnType<typeof spawn> | undefined;
  const closeOwner = async () => {
    if (!owner) return;
    if (owner.exitCode === null && owner.signalCode === null) { owner.stdin?.write('release'); }
    if (owner.exitCode === null && owner.signalCode === null) { const timer=setTimeout(()=>owner?.kill(),5000); await once(owner,'close'); clearTimeout(timer); }
    if (existsSync(lockPath)) unlinkSync(lockPath);
  };
  try {
    const ownerReady = new Promise<void>((resolve,reject) => {
      owner = spawn(process.execPath, [...runnerArgs, '--input-type=module', '-e', ownerScript], { stdio: ['pipe','pipe','pipe'] });
      let out=''; let err=''; owner.stdout?.setEncoding('utf8').on('data', chunk => { out+=chunk; if(out.includes('locked')) resolve(); }); owner.stderr?.setEncoding('utf8').on('data', chunk=>{err+=chunk;});
      owner.once('error',reject); owner.once('exit',(code,signal)=>{if(!out.includes('locked'))reject(new Error(`owner exited before lock readiness (${code}/${signal}): ${err}`));});
    });
    await ownerReady;
    const blocked=await runChild('contender',join(memoryPath,'..','unused'),join(memoryPath,'..','unused-ready'),join(memoryPath,'..','unused-base'));
    assert.match(blocked, /lost:contender:Concurrent modification detected.*lock/);
    assert.equal(existsSync(lockPath), true);
  } finally {
    await closeOwner();
  }
  assert.equal(existsSync(lockPath), false);
  // Two writers read the same baseline. A child-only fs hook pauses the first writer
  // after it has acquired the production lock (at its temp-file write), allowing the
  // other actual writer to contend while the lock is held.
  const fixtureDir=join(memoryPath,'..'); const barrier=join(fixtureDir,'release-writer'); const readyA=join(fixtureDir,'writer-a-acquired'); const readyB=join(fixtureDir,'writer-b-acquired'); const baseA=join(fixtureDir,'writer-a-baseline'); const baseB=join(fixtureDir,'writer-b-baseline');
  const aPromise=runChild('winner A',barrier,readyA,baseA); const bPromise=runChild('winner B',barrier,readyB,baseB);
  const waitFor = async (predicate:()=>boolean,label:string) => { const deadline=Date.now()+8000; while(!predicate()) { if(Date.now()>deadline) throw new Error(`${label} timed out`); await new Promise(resolve=>setTimeout(resolve,10)); } };
  try { await waitFor(()=>existsSync(baseA)&&existsSync(baseB),'writers did not read baseline'); await waitFor(()=>existsSync(readyA)||existsSync(readyB),'neither writer acquired lock');
  const acquired=existsSync(readyA)?readyA:readyB;
  const outcomePromise=Promise.all([aPromise,bPromise]);
  const contenderResult=await Promise.race([outcomePromise.then(results=>({results})),new Promise<{results?:string[]}>(resolve=>setTimeout(()=>resolve({}),300))]);
  assert.equal(contenderResult.results,undefined,'both actual writer processes must overlap before release');
  writeFileSync(barrier,'go'); const outcomes=await outcomePromise;
  assert.equal(outcomes.filter(result => result.startsWith('won:')).length, 1);
  assert.equal(outcomes.filter(result => result.startsWith('lost:')).length, 1);
  const winner = outcomes.find(result => result.startsWith('won:'))!.slice(4);
  assert.equal(winner,acquired===readyA?'winner A':'winner B','the writer holding the lock must win');
  assert.deepEqual(readSharedMemory(memoryPath).entries.map(entry => entry.fact), [winner]);
  assert.equal(readFileSync(memoryPath, 'utf8').includes(winner), true);
  assert.equal(existsSync(`${memoryPath}.lock`), false);
  assert.deepEqual(readdirSync(join(memoryPath,'..')).filter(name=>name.endsWith('.tmp')), []);
  } finally { if(existsSync(barrier)===false) writeFileSync(barrier,'cleanup'); for(const child of children) child.kill(); await Promise.allSettled([aPromise,bPromise]); }
});

test('planRulePromotion and applyApprovedRulePromotion handle dispositions, diffs, and safety', () => {
  const agentsOriginal = `# Project Guidelines

Some initial rules.

<!-- advanced-harness:project:start -->
## Advanced Harness project settings
\`\`\`json
{
  "version": 1
}
\`\`\`
<!-- advanced-harness:project:end -->
`;

  const entries: MemoryEntry[] = [
    { source: 'Pilot', scope: 'Roborazzi', confirmation: 'approved', fact: 'Always verify screenshots before PR.' },
    { source: 'Pilot', scope: 'Observation', confirmation: 'noted', fact: 'Gradle build runs faster on JDK 17.' },
    { source: 'Pilot', scope: 'Old Info', confirmation: 'obsolete', fact: 'Temporary workaround for lint.' },
  ];

  const plan = planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [
      { type: 'promote', entry: entries[0]! },
      { type: 'keep-memory', entry: entries[1]! },
      { type: 'discard', entry: entries[2]! },
    ],
  });

  assert.equal(plan.promotedCount, 1);
  assert.equal(plan.keptCount, 1);
  assert.equal(plan.discardedCount, 1);
  assert.ok(plan.diff.includes('+## Promoted Project Rules'));
  assert.ok(plan.diff.includes('+- Always verify screenshots before PR.'));
  assert.ok(plan.updatedAgentsText.includes('<!-- advanced-harness:project:start -->'));

  // Rejects empty, raw-newlines, or >2000-character rules on promotion (F-15)
  assert.throws(() => planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [{ type: 'promote', entry: entries[0]!, targetRuleText: '' }],
  }), /cannot be empty/);

  assert.throws(() => planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [{ type: 'promote', entry: entries[0]!, targetRuleText: 'line 1\nline 2' }],
  }), /must not contain raw newlines/);

  assert.throws(() => planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [{ type: 'promote', entry: entries[0]!, targetRuleText: 'a'.repeat(2001) }],
  }), /exceeds maximum length/);

  // Rejects promotion of secrets or machine-local worktree paths
  assert.throws(() => {
    planRulePromotion({
      memoryEntries: entries,
      agentsText: agentsOriginal,
      dispositions: [
        { type: 'promote', entry: { source: 'A', scope: 'B', confirmation: 'C', fact: 'C:\\Users\\jcgse\\Projects\\advanced-harness-worktrees\\temp' } },
      ],
    });
  }, /machine-local worktree or operational paths/);
  for (const path of ['C:\\Users\\Alice\\Projects\\app-worktrees\\feature-x', '/Users/alice/worktrees/feature-x', 'Use `/Users/alice/Projects/app/cache`.', 'Use C:/Users/Alice/AppData/Local/harness/cache.']) {
    assert.throws(() => planRulePromotion({
      memoryEntries: entries,
      agentsText: agentsOriginal,
      dispositions: [{ type: 'promote', entry: { source: 'A', scope: 'B', confirmation: 'C', fact: path } }],
    }), /machine-local worktree or operational paths/);
  }
  for (const secret of ['password=supersecret123', '-----BEGIN PRIVATE KEY-----']) {
    assert.throws(() => planRulePromotion({
      memoryEntries: entries,
      agentsText: agentsOriginal,
      dispositions: [{ type: 'promote', entry: { source: 'A', scope: 'B', confirmation: 'C', fact: secret } }],
    }), /potential secret or credential tokens|potential secret\/token patterns/);
  }
  for (const pem of ['-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----']) {
    assert.throws(() => validateMemoryEntry({ source: 'A', scope: 'B', confirmation: 'C', fact: pem }), /potential secret or credential/);
    assert.throws(() => planRulePromotion({
      memoryEntries: entries,
      agentsText: agentsOriginal,
      dispositions: [{ type: 'promote', entry: entries[0]!, targetRuleText: `Use key ${pem}` }],
    }), /potential secret\/token patterns/);
  }
  for (const path of ['Use `/Users/alice/Projects/app/cache`.', 'Use C:/Users/Alice/AppData/Local/harness/cache.']) {
    assert.throws(() => planRulePromotion({
      memoryEntries: entries,
      agentsText: agentsOriginal,
      dispositions: [{ type: 'promote', entry: entries[0]!, targetRuleText: path }],
    }), /machine-local worktree or operational paths/);
  }
});

test('promotion finds standalone headings outside code/config and preserves embedded content and newline bytes', () => {
  const entry: MemoryEntry = { source: 'Human', scope: 'Rules', confirmation: 'approved', fact: 'Keep the release checklist current.' };
  const source = [
    '# Guide',
    '',
    '```md',
    '## Promoted Project Rules',
    '- literal fenced text',
    '```',
    '',
    '<!-- advanced-harness:project:start -->',
    '## Promoted Project Rules',
    '```json',
    '{"value":"keep bytes"}',
    '```',
    '<!-- advanced-harness:project:end -->',
    '',
    '## Promoted Project Rules',
    '- Existing rule.',
    '',
    '## Next section',
    'Leave unchanged.',
    '',
  ].join('\r\n');
  const plan = planRulePromotion({ memoryEntries: [entry], agentsText: source, dispositions: [{ type: 'promote', entry }] });
  assert.equal(plan.updatedAgentsText.split('## Promoted Project Rules').length - 1, 3);
  assert.match(plan.updatedAgentsText, /## Promoted Project Rules\r\n- Existing rule\.\r\n- Keep the release checklist current\.\r\n\r\n## Next section/);
  assert.ok(plan.updatedAgentsText.includes('## Promoted Project Rules\r\n```json\r\n{"value":"keep bytes"}\r\n```'));
  assert.ok(plan.updatedAgentsText.endsWith('\r\n'));
});

test('promotion inserts safely at embedded-section boundary or EOF and rejects ambiguity/malformed boundaries', () => {
  const entry: MemoryEntry = { source: 'Human', scope: 'Rules', confirmation: 'approved', fact: 'Keep the release checklist current.' };
  const promote = (agentsText: string) => planRulePromotion({ memoryEntries: [entry], agentsText, dispositions: [{ type: 'promote', entry }] });
  const embedded = '<!-- advanced-harness:project:start -->\n{}\n<!-- advanced-harness:project:end -->';
  const inserted = promote(`# Guide\n\n${embedded}`).updatedAgentsText;
  assert.ok(inserted.indexOf('## Promoted Project Rules') < inserted.indexOf(embedded));
  assert.ok(inserted.endsWith(embedded));
  const eof = promote('# Guide');
  assert.ok(eof.updatedAgentsText.endsWith('- Keep the release checklist current.\n'));
  assert.throws(() => promote('## Promoted Project Rules\n\n## Promoted Project Rules'), /Ambiguous duplicate/);
  assert.throws(() => promote('<!-- advanced-harness:project:start -->\nunfinished'), /Malformed embedded harness section/);
  assert.throws(() => promote('```\nunfinished'), /Malformed fenced code block/);
});

test('promotion keeps existing section insertion outside embedded block and separates unterminated final rule', () => {
  const entry: MemoryEntry = { source: 'Human', scope: 'Rules', confirmation: 'approved', fact: 'Add the release checklist.' };
  for (const eol of ['\n', '\r\n']) {
    const promote = (agentsText: string) => planRulePromotion({ memoryEntries: [entry], agentsText, dispositions: [{ type: 'promote', entry }] });
    const embedded = [
      '<!-- advanced-harness:project:start -->',
      '## Advanced Harness project settings',
      '```json',
      '{"keep":"these exact bytes"}',
      '```',
      '<!-- advanced-harness:project:end -->',
    ].join(eol);
    const existing = ['# Guide', '## Promoted Project Rules', '- Existing rule.', embedded, '## After', 'Untouched.'].join(eol);
    const plan = promote(existing);
    const applied = applyApprovedRulePromotion(plan, true);
    assert.ok(applied.indexOf('- Add the release checklist.') < applied.indexOf('<!-- advanced-harness:project:start -->'));
    assert.ok(applied.includes(embedded), 'embedded block must remain byte-for-byte unchanged');
    assert.ok(applied.includes(`- Existing rule.${eol}- Add the release checklist.${eol}${embedded}`));
    assert.ok(applied.includes(`${eol}## After${eol}Untouched.`));

    const unterminated = ['# Guide', '## Promoted Project Rules', '- Existing rule.'].join(eol);
    const eofPlan = promote(unterminated);
    const eofApplied = applyApprovedRulePromotion(eofPlan, true);
    assert.ok(eofApplied.includes(`- Existing rule.${eol}- Add the release checklist.${eol}`));
    assert.ok(eofApplied.endsWith(`- Add the release checklist.${eol}`));
  }
});

test('promotion ignores fenced embedded-marker examples as boundaries and keeps insertion outside fences', () => {
  const entry: MemoryEntry = { source: 'Human', scope: 'Rules', confirmation: 'approved', fact: 'Add the release checklist.' };
  for (const eol of ['\n', '\r\n']) {
    const fenceExample = ['```md', '<!-- advanced-harness:project:start -->', '## Example settings', '```'].join(eol);
    const embedded = ['<!-- advanced-harness:project:start -->', '## Actual settings', '{"keep":true}', '<!-- advanced-harness:project:end -->'].join(eol);
    const source = ['# Guide', '## Promoted Project Rules', '- Existing rule.', fenceExample, embedded, '## After', 'Untouched.'].join(eol);
    const plan = planRulePromotion({ memoryEntries: [entry], agentsText: source, dispositions: [{ type: 'promote', entry }] });
    const updated = applyApprovedRulePromotion(plan, true);
    assert.ok(updated.includes(fenceExample), 'fenced example remains byte-for-byte unchanged');
    assert.ok(updated.includes(embedded), 'actual embedded section remains byte-for-byte unchanged');
    const ruleIndex = updated.indexOf('- Add the release checklist.');
    const fenceEnd = updated.indexOf(eol + '```', updated.indexOf('```md')) + eol.length + 3;
    assert.ok(ruleIndex >= fenceEnd, 'rule follows the fenced marker example');
    assert.ok(ruleIndex < updated.indexOf(embedded), 'rule precedes the actual embedded section');
  }
});

test('malformed legacy memory is preserved on serialized write even without a baseline', (t) => {
  const { memoryPath } = createFixture(t);
  mkdirSync(join(memoryPath, '..'), { recursive: true });
  const legacy = '# Old operator notes\nSensitive legacy body must stay untouched.\n';
  writeFileSync(memoryPath, legacy);
  assert.throws(() => readSharedMemory(memoryPath), /Unsupported shared MEMORY.md content on line 1/);
  assert.throws(() => writeSharedMemorySerialized(memoryPath, [], undefined), /Unsupported shared MEMORY.md content on line 1/);
  assert.equal(readFileSync(memoryPath, 'utf8'), legacy);
  assert.equal(existsSync(`${memoryPath}.lock`), false);
  assert.deepEqual(readdirSync(join(memoryPath, '..')).filter(name => name.endsWith('.tmp')), []);
});

test('personal rules: resolvePersonalRulesPath, parsing, formatting, serialized write, and validation', (t) => {
  const { memoryPath } = createFixture(t);
  const personalPath = resolvePersonalRulesPath(memoryPath);
  assert.equal(personalPath, join(memoryPath, '..', 'AGENTS.personal.md'));

  // Nonexistent file returns exists: false, empty rules
  const initial = readPersonalRules(personalPath);
  assert.equal(initial.exists, false);
  assert.deepEqual(initial.rules, []);

  // Write rules
  const rules = ['Prefer verbose logging when debugging tests.', 'Always run npm run check before submitting.'];
  const res = writePersonalRulesSerialized(personalPath, rules, initial.hash);
  assert.equal(res.success, true);

  const readBack = readPersonalRules(personalPath);
  assert.equal(readBack.exists, true);
  assert.deepEqual(readBack.rules, rules);
  assert.equal(readBack.hash, res.hash);

  // Rejects concurrent write on mismatched baseline
  assert.throws(() => {
    writePersonalRulesSerialized(personalPath, ['New rule'], 'outdated_hash');
  }, /Concurrent modification detected on AGENTS.personal.md/);

  // Validate personal rule text rejects secrets and machine-local worktree paths
  assert.throws(() => validatePersonalRuleText('github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz'), /Personal rule contains potential secret\/token patterns/);
  assert.throws(() => validatePersonalRuleText('C:\\Users\\Alice\\Projects\\advanced-harness-worktrees\\issue-1'), /machine-local worktree or operational paths/);
  assert.throws(() => validatePersonalRuleText(''), /cannot be empty/);
  assert.throws(() => validatePersonalRuleText('Multi\nline'), /must not contain raw newlines/);
});

test('planRulePromotion handles "personal" disposition and validates rules', () => {
  const agentsOriginal = '# Project Guidelines\n\nSome initial rules.\n';
  const entries: MemoryEntry[] = [
    { source: 'Pilot', scope: 'Personal Preference', confirmation: 'approved', fact: 'Use 2-space indentation for yaml.' },
    { source: 'Pilot', scope: 'Repo Rule', confirmation: 'approved', fact: 'Check linter before PR.' },
    { source: 'Pilot', scope: 'Invalid Entry', confirmation: 'approved', fact: 'Valid fact initially' },
  ];

  const plan = planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [
      { type: 'personal', entry: entries[0]! },
      { type: 'promote', entry: entries[1]! },
    ],
  });

  assert.equal(plan.personalCount, 1);
  assert.equal(plan.promotedCount, 1);
  assert.deepEqual(plan.personalRulesToAdd, ['Use 2-space indentation for yaml.']);
  // AGENTS.md diff contains the promoted rule, not the personal rule
  assert.ok(plan.diff.includes('Check linter before PR.'));
  assert.ok(!plan.diff.includes('Use 2-space indentation for yaml.'));

  // Rejects invalid rules during planning (empty, multiline, oversized, secret, path)
  assert.throws(() => planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [{ type: 'personal', entry: entries[2]!, targetRuleText: '   ' }],
  }), /Personal rule cannot be empty/);

  assert.throws(() => planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [{ type: 'personal', entry: entries[2]!, targetRuleText: 'line 1\nline 2' }],
  }), /must not contain raw newlines/);

  assert.throws(() => planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [{ type: 'personal', entry: entries[2]!, targetRuleText: 'a'.repeat(2001) }],
  }), /exceeds maximum length/);

  assert.throws(() => planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [{ type: 'personal', entry: entries[2]!, targetRuleText: 'ghp_012345678901234567890123456789' }],
  }), /Personal rule contains potential secret\/token patterns/);

  assert.throws(() => planRulePromotion({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    dispositions: [{ type: 'personal', entry: entries[2]!, targetRuleText: 'C:\\Users\\Alice\\Projects\\advanced-harness-worktrees\\issue-1' }],
  }), /machine-local worktree or operational paths/);
});

test('personal rules file size limit, multibyte content, and failure preservation', (t) => {
  const { memoryPath } = createFixture(t);
  const personalPath = resolvePersonalRulesPath(memoryPath);

  // Write initial valid file
  const initialRules = ['Rule 1: keep state.', 'Rule 2: utf8 multibyte ✨🚀.'];
  const res = writePersonalRulesSerialized(personalPath, initialRules, undefined);
  assert.equal(res.success, true);
  const baseline = readPersonalRules(personalPath);
  assert.equal(baseline.rules.length, 2);

  // Attempt to write aggregate overflow (>1 MiB) with multibyte content
  const largeRule = 'Multi-byte rule: 🌟 ' + 'x'.repeat(1950);
  const manyRules: string[] = [];
  // Each rule ~2000 bytes. ~600 rules will exceed 1 MiB
  for (let i = 0; i < 600; i++) {
    manyRules.push(`${largeRule} #${i}`);
  }

  assert.throws(() => {
    writePersonalRulesSerialized(personalPath, manyRules, baseline.hash);
  }, /Personal rules file exceeds 1 MiB size limit/);

  // Verify failure preserves previous file completely
  const preserved = readPersonalRules(personalPath);
  assert.equal(preserved.hash, baseline.hash);
  assert.deepEqual(preserved.rules, initialRules);
});

test('detectPersonalRuleContradictions identifies contradictions with AGENTS.md and accounts for negation', () => {
  const agents = `# Instructions\n\nMerging remains human-only. Always check before commit.\n`;
  const personal = [
    'Merges automatically when green',
    'Never check before commit',
    'Prefer dark theme in IDE',
    'Never auto-merge',
    'Do not auto-merge pull requests',
    'Must not auto-merge',
    'Do not rebase; auto-merge when green',
    'Never force push, auto-merge if tests pass',
    'Do not rebase; never auto-merge',
  ];

  const contradictions = detectPersonalRuleContradictions(personal, agents);
  assert.equal(contradictions.length, 4);
  assert.equal(contradictions[0]!.rule, 'Merges automatically when green');
  assert.match(contradictions[0]!.contradictionReason, /human-only/);
  assert.equal(contradictions[1]!.rule, 'Never check before commit');
  assert.match(contradictions[1]!.contradictionReason, /forbids/);
  assert.equal(contradictions[2]!.rule, 'Do not rebase; auto-merge when green');
  assert.match(contradictions[2]!.contradictionReason, /human-only/);
  assert.equal(contradictions[3]!.rule, 'Never force push, auto-merge if tests pass');
  assert.match(contradictions[3]!.contradictionReason, /human-only/);
});

test('detectPruningCandidates avoids false positives and handles tri-state checks', () => {
  const agents = `# Instructions\n\nMerging remains human-only.\n`;
  const personal = ['', '   ', 'valid-personal-rule'];

  const entries: MemoryEntry[] = [
    // Should NOT be flagged as redundant because fact is short ("Node")
    { source: 'Test', scope: 'General', confirmation: 'approved', fact: 'Node' },
    // Should NOT be flagged by empty personal rules
    { source: 'Test', scope: 'General', confirmation: 'approved', fact: 'Some fact not in personal rules' },
    // Should NOT be flagged as contradicted because it explicitly negates auto-merge before or after
    { source: 'Git', scope: 'Workflow', confirmation: 'approved', fact: 'Never auto-merge pull requests' },
    { source: 'Git', scope: 'Workflow', confirmation: 'approved', fact: 'Auto-merge is not allowed' },
    // Two unrelated facts in the same scope: should NOT flag the first as contradicted
    { source: 'Tooling', scope: 'Versions', confirmation: 'approved', fact: 'Node 24 is active' },
    { source: 'Tooling', scope: 'Versions', confirmation: 'approved', fact: 'TypeScript 7 is active' },
    // Prose with "the main branch must be clean": should NOT match branch obsolete check
    { source: 'Security', scope: 'Git', confirmation: 'approved', fact: 'The main branch must be clean before push' },
    // Prose with "Priority is #1": should NOT match obsolete issue check
    { source: 'Rank', scope: 'Priority', confirmation: 'approved', fact: 'Priority is #1 item in queue' },
    // Candidates with external checks that return "unknown" or throw: must NOT be flagged as obsolete (F-29)
    { source: 'Bug', scope: 'Fixes', confirmation: 'approved', fact: 'Fixes issue #888' },
    { source: 'Git', scope: 'Branches', confirmation: 'approved', fact: 'Tracking branch `feature/unknown-branch`' },
    { source: 'Repo', scope: 'Files', confirmation: 'approved', fact: 'Inspect file `src/unknown-file.ts`' },
    // Longer fact merely containing shorter personal rule: should NOT flag as redundant (F-22)
    { source: 'Personal', scope: 'Settings', confirmation: 'approved', fact: 'Use valid-personal-rule when compiling releases in production' },
    // Distinct subject nouns: Docker compose vs Docker desktop should NOT supersede each other (F-01)
    { source: 'DevOps', scope: 'Containers', confirmation: 'approved', fact: 'Docker compose is required for local testing' },
    { source: 'DevOps', scope: 'Containers', confirmation: 'approved', fact: 'Docker desktop is required for local testing' },
    // File path with a..b.ts: valid file should not be skipped as path traversal (F-04)
    { source: 'Repo', scope: 'Files', confirmation: 'approved', fact: 'Inspect file `src/a..b.ts`' },
    // Issue reference in parentheses: (#123) should match (F-01)
    { source: 'Fix', scope: 'Issue', confirmation: 'approved', fact: 'Resolves issue (#123)' },
  ];

  const externalChecker = {
    checkIssueExists: (id: string) => {
      if (id === '888') return { status: 'unknown' as TriStateResult, evidence: 'Network error' };
      if (id === '1') return { status: 'missing' as TriStateResult, evidence: 'Issue #1 missing' };
      if (id === '123') return { status: 'missing' as TriStateResult, evidence: 'Issue #123 missing' };
      return { status: 'missing' as TriStateResult, evidence: 'Missing' };
    },
    checkBranchExists: (branch: string) => {
      if (branch === 'feature/unknown-branch') throw new Error('Offline error');
      return { status: 'missing' as TriStateResult, evidence: 'Missing branch' };
    },
    checkFileExists: (filePath: string) => {
      if (filePath.includes('unknown-file')) return { status: 'unknown' as TriStateResult, evidence: 'Unknown file' };
      if (filePath === 'src/a..b.ts') return { status: 'missing' as TriStateResult, evidence: 'Missing a..b.ts' };
      return { status: 'missing' as TriStateResult, evidence: 'Missing file' };
    },
  };

  const candidates = detectPruningCandidates({
    memoryEntries: entries,
    agentsText: agents,
    personalRules: personal,
    externalChecker,
  });

  // Only the valid obsolete (#123) and valid file (src/a..b.ts) should be flagged!
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]!.kind, 'obsolete');
  assert.equal(candidates[0]!.evidenceKey, 'file:src/a..b.ts');
  assert.equal(candidates[1]!.kind, 'obsolete');
  assert.equal(candidates[1]!.evidenceKey, 'issue:123');
});

test('detectPruningCandidates identifies redundant, contradicted/superseded, and obsolete entries', () => {
  const agents = `# Instructions\n\nAlways run tests before PR. Merging remains human-only.\n`;
  const personal = ['Use 2 spaces for indentation'];

  const entries: MemoryEntry[] = [
    // 0: redundant with AGENTS.md
    { source: 'Review', scope: 'Repo', confirmation: 'approved', fact: 'Always run tests before PR.' },
    // 1: redundant with personal rules
    { source: 'Operator', scope: 'Editor', confirmation: 'approved', fact: 'Use 2 spaces for indentation' },
    // 2: contradicted by AGENTS.md
    { source: 'Operator', scope: 'Git', confirmation: 'approved', fact: 'Merges automatically when tests pass' },
    // 3: older entry superseded by newer entry in same scope with shared topic
    { source: 'Test', scope: 'Tooling', confirmation: 'approved', fact: 'Node 18 is required for builds' },
    // 4: newer entry superseding #3
    { source: 'Test', scope: 'Tooling', confirmation: 'replaces Node 18', fact: 'Node 24 is required for builds' },
    // 5: obsolete: refers to deleted issue #999
    { source: 'IssueTracker', scope: 'Fixes', confirmation: 'approved', fact: 'Resolves issue #999 for good' },
    // 6: obsolete: refers to deleted branch issue/999
    { source: 'Git', scope: 'Branches', confirmation: 'approved', fact: 'Tracking branch `issue/999`' },
    // 7: obsolete: refers to deleted file obsolete.ts
    { source: 'Repo', scope: 'Files', confirmation: 'approved', fact: 'Inspect file `src/obsolete.ts` on start' },
    // 8: active and valid entry
    { source: 'Dev', scope: 'Context', confirmation: 'approved', fact: 'All active work happens in task worktrees' },
  ];

  const externalChecker = {
    checkIssueExists: (id: string) => (id === '999' ? { status: 'missing' as TriStateResult, evidence: 'Issue #999 deleted' } : 'exists' as TriStateResult),
    checkBranchExists: (branch: string) => (branch === 'issue/999' ? { status: 'missing' as TriStateResult, evidence: 'Branch deleted' } : 'exists' as TriStateResult),
    checkFileExists: (path: string) => (path.includes('obsolete.ts') ? { status: 'missing' as TriStateResult, evidence: 'File removed' } : 'exists' as TriStateResult),
  };

  const candidates = detectPruningCandidates({
    memoryEntries: entries,
    agentsText: agents,
    personalRules: personal,
    externalChecker,
  });

  assert.equal(candidates.length, 7);

  // Redundant with AGENTS.md
  assert.equal(candidates[0]!.kind, 'redundant');
  assert.equal(candidates[0]!.entry.fact, 'Always run tests before PR.');
  assert.match(candidates[0]!.reason, /AGENTS\.md/);
  assert.equal(candidates[0]!.evidenceKey, 'agents-rule');

  // Redundant with personal
  assert.equal(candidates[1]!.kind, 'redundant');
  assert.equal(candidates[1]!.entry.fact, 'Use 2 spaces for indentation');
  assert.match(candidates[1]!.reason, /personal rule/);
  assert.equal(candidates[1]!.evidenceKey, 'personal-rule');

  // Contradicted by AGENTS.md
  assert.equal(candidates[2]!.kind, 'contradicted');
  assert.equal(candidates[2]!.entry.fact, 'Merges automatically when tests pass');
  assert.equal(candidates[2]!.evidenceKey, 'agents-merging');

  // Superseded by newer entry
  assert.equal(candidates[3]!.kind, 'contradicted');
  assert.equal(candidates[3]!.entry.fact, 'Node 18 is required for builds');
  assert.match(candidates[3]!.evidence, /Node 24 is required for builds/);

  // Obsolete issue
  assert.equal(candidates[4]!.kind, 'obsolete');
  assert.equal(candidates[4]!.entry.fact, 'Resolves issue #999 for good');
  assert.match(candidates[4]!.reason, /#999/);
  assert.equal(candidates[4]!.evidenceKey, 'issue:999');

  // Obsolete branch
  assert.equal(candidates[5]!.kind, 'obsolete');
  assert.equal(candidates[5]!.entry.fact, 'Tracking branch `issue/999`');
  assert.match(candidates[5]!.reason, /branch "issue\/999"/);
  assert.equal(candidates[5]!.evidenceKey, 'branch:issue/999');

  // Obsolete file
  assert.equal(candidates[6]!.kind, 'obsolete');
  assert.equal(candidates[6]!.entry.fact, 'Inspect file `src/obsolete.ts` on start');
  assert.match(candidates[6]!.reason, /file "src\/obsolete\.ts"/);
  assert.equal(candidates[6]!.evidenceKey, 'file:src/obsolete.ts');
});

test('planMemoryPruning handles end-to-end detect, plan with keep, discard, promote, and re-detection', () => {
  const agentsOriginal = '# Project Guidelines\n\nAlways check tests before commit.\n';
  const entries: MemoryEntry[] = [
    { source: 'Dev', scope: 'Issues', confirmation: 'approved', fact: 'Referenced in issue #12 for tracking' },
    { source: 'Dev', scope: 'Files', confirmation: 'approved', fact: 'Inspect file `src/a.ts` on start' },
    { source: 'Dev', scope: 'Branches', confirmation: 'approved', fact: 'Tracking branch `feature/x`' },
    { source: 'Dev', scope: 'Redundant', confirmation: 'approved', fact: 'Always check tests before commit.' },
    { source: 'Dev', scope: 'DiscardMe', confirmation: 'approved', fact: 'Obsolete note with issue #99' },
  ];

  const externalChecker = {
    checkIssueExists: (id: string) => (id === '12' || id === '99' ? { status: 'missing' as TriStateResult, evidence: 'Issue closed' } : 'exists' as TriStateResult),
    checkBranchExists: (branch: string) => (branch === 'feature/x' ? { status: 'missing' as TriStateResult, evidence: 'Branch deleted' } : 'exists' as TriStateResult),
    checkFileExists: (path: string) => (path === 'src/a.ts' ? { status: 'missing' as TriStateResult, evidence: 'File removed' } : 'exists' as TriStateResult),
  };

  // 1. Detect candidate
  const initialCandidates = detectPruningCandidates({
    memoryEntries: entries,
    agentsText: agentsOriginal,
    externalChecker,
  });
  assert.equal(initialCandidates.length, 5);

  // 2. Plan dispositions: keep issue #12, file, branch; promote redundant; discard obsolete
  const plan = planMemoryPruning({
    memoryEntries: entries,
    candidates: initialCandidates,
    dispositions: [
      { entry: entries[0]!, disposition: 'keep' },
      { entry: entries[1]!, disposition: 'keep' },
      { entry: entries[2]!, disposition: 'keep' },
      { entry: entries[3]!, disposition: 'promote' },
      { entry: entries[4]!, disposition: 'discard' },
    ],
    agentsText: agentsOriginal,
    agentsPath: join(tmpdir(), 'AGENTS.md'),
  });

  assert.equal(plan.keptCount, 3);
  assert.equal(plan.discardedCount, 1);
  assert.equal(plan.promotedToAgents.length, 1);
  assert.equal(plan.updatedMemoryEntries.length, 3); // Kept entries remain, discarded and promoted are gone
  assert.ok(plan.updatedMemoryEntries[0]!.confirmation.includes('reviewed-keep:obsolete:issue:12'));
  assert.ok(plan.updatedMemoryEntries[1]!.confirmation.includes('reviewed-keep:obsolete:file:src/a.ts'));
  assert.ok(plan.updatedMemoryEntries[2]!.confirmation.includes('reviewed-keep:obsolete:branch:feature/x'));

  // Assert explicitly that discarded and promoted entries are completely gone from updatedMemoryEntries (F-29)
  assert.ok(!plan.updatedMemoryEntries.some((e) => e.fact.includes('Obsolete note with issue #99')));
  assert.ok(!plan.updatedMemoryEntries.some((e) => e.fact.includes('Always check tests before commit.')));
  assert.ok(plan.updatedAgentsText?.includes('Always check tests before commit.'));
  assert.ok(plan.agentsDiff?.includes('+- Always check tests before commit.'));

  // 3. Re-detect with the exact output of planMemoryPruning: must produce zero candidates!
  const recheckedCandidates = detectPruningCandidates({
    memoryEntries: plan.updatedMemoryEntries,
    agentsText: agentsOriginal,
    externalChecker,
  });
  assert.equal(recheckedCandidates.length, 0);

  // 4. Prefix collision tests (F-17, F-29):
  // 4a. Kept issue:12 must not suppress issue:1 when fact changes to issue #1
  const modifiedEntriesIssue: MemoryEntry[] = [
    { ...plan.updatedMemoryEntries[0]!, fact: 'Referenced in issue #1 for tracking' },
  ];
  const checkerFor1 = {
    checkIssueExists: (id: string) => (id === '1' ? { status: 'missing' as TriStateResult, evidence: 'Issue #1 closed' } : 'exists' as TriStateResult),
  };
  const recheckedWithNewReason = detectPruningCandidates({
    memoryEntries: modifiedEntriesIssue,
    agentsText: agentsOriginal,
    externalChecker: checkerFor1,
  });
  assert.equal(recheckedWithNewReason.length, 1);
  assert.equal(recheckedWithNewReason[0]!.evidenceKey, 'issue:1');

  // 4b. Kept file:src/a.ts must not suppress file:src/a.tsx (F-17, F-29)
  const modifiedEntriesFile: MemoryEntry[] = [
    { ...plan.updatedMemoryEntries[1]!, fact: 'Inspect file `src/a.tsx` on start' },
  ];
  const checkerForFileTsx = {
    checkFileExists: (path: string) => (path === 'src/a.tsx' ? { status: 'missing' as TriStateResult, evidence: 'File missing' } : 'exists' as TriStateResult),
  };
  const recheckedFile = detectPruningCandidates({
    memoryEntries: modifiedEntriesFile,
    agentsText: agentsOriginal,
    externalChecker: checkerForFileTsx,
  });
  assert.equal(recheckedFile.length, 1);
  assert.equal(recheckedFile[0]!.evidenceKey, 'file:src/a.tsx');

  // 4c. Kept branch:feature/x must not suppress branch:feature/x-2 (F-17, F-29)
  const modifiedEntriesBranch: MemoryEntry[] = [
    { ...plan.updatedMemoryEntries[2]!, fact: 'Tracking branch `feature/x-2`' },
  ];
  const checkerForBranch2 = {
    checkBranchExists: (branch: string) => (branch === 'feature/x-2' ? { status: 'missing' as TriStateResult, evidence: 'Branch deleted' } : 'exists' as TriStateResult),
  };
  const recheckedBranch = detectPruningCandidates({
    memoryEntries: modifiedEntriesBranch,
    agentsText: agentsOriginal,
    externalChecker: checkerForBranch2,
  });
  assert.equal(recheckedBranch.length, 1);
  assert.equal(recheckedBranch[0]!.evidenceKey, 'branch:feature/x-2');
});

test('planMemoryPruning validates candidates, dispositions, and supports complex supersession with delimiters', () => {
  const entryA: MemoryEntry = { source: 'Dev', scope: 'ScopeA', confirmation: 'approved', fact: 'Fact A' };
  const entryB: MemoryEntry = { source: 'Dev', scope: 'ScopeA', confirmation: 'approved', fact: 'Fact B; with [brackets] and long delimiters' };
  const candidateA: PruningCandidate = {
    entry: entryA,
    kind: 'contradicted',
    reason: 'Superseded',
    evidence: 'Newer',
    evidenceKey: 'newer-entry:123456789abc',
  };

  // Candidate not matching any entry throws
  const foreignEntry: MemoryEntry = { source: 'Foreign', scope: 'ScopeA', confirmation: 'approved', fact: 'Unknown' };
  assert.throws(() => planMemoryPruning({
    memoryEntries: [entryA, entryB],
    candidates: [{ ...candidateA, entry: foreignEntry }],
    dispositions: [],
  }), /Candidate does not match any entry in memoryEntries/);

  // Disposition not recognized as candidate throws
  assert.throws(() => planMemoryPruning({
    memoryEntries: [entryA, entryB],
    candidates: [candidateA],
    dispositions: [{ entry: entryB, disposition: 'keep' }],
  }), /not a recognized pruning candidate/);

  // Duplicate disposition throws
  assert.throws(() => planMemoryPruning({
    memoryEntries: [entryA, entryB],
    candidates: [candidateA],
    dispositions: [
      { entry: entryA, disposition: 'keep' },
      { entry: entryA, disposition: 'keep' },
    ],
  }), /Duplicate disposition/);

  // Unknown disposition type throws
  assert.throws(() => planMemoryPruning({
    memoryEntries: [entryA, entryB],
    candidates: [candidateA],
    dispositions: [{ entry: entryA, disposition: 'invalid' as any }],
  }), /Unknown disposition type/);

  // Promote without agentsText throws
  assert.throws(() => planMemoryPruning({
    memoryEntries: [entryA],
    candidates: [candidateA],
    dispositions: [{ entry: entryA, disposition: 'promote' }],
    agentsText: undefined,
  }), /Promotion disposition requires agentsText/);

  // Newer fact with ; and ] generates safe evidenceKey without semicolon or bracket
  const entrySuperseded: MemoryEntry = { source: 'Dev', scope: 'ScopeA', confirmation: 'approved', fact: 'Old fact' };
  const entrySuperseding: MemoryEntry = { source: 'Dev', scope: 'ScopeA', confirmation: 'replaces Old fact', fact: 'Fact B; with [brackets] and long delimiters' };
  const candidatesFromDetection = detectPruningCandidates({
    memoryEntries: [entrySuperseded, entrySuperseding],
  });
  assert.equal(candidatesFromDetection.length, 1);
  assert.equal(candidatesFromDetection[0]!.kind, 'contradicted');
  assert.ok(!candidatesFromDetection[0]!.evidenceKey.includes(';'));
  assert.ok(!candidatesFromDetection[0]!.evidenceKey.includes(']'));

  // Keeping candidate with ; and ] produces valid memory entry that formats and parses without error
  const keepPlan = planMemoryPruning({
    memoryEntries: [entrySuperseded, entrySuperseding],
    candidates: candidatesFromDetection,
    dispositions: [{ entry: entrySuperseded, disposition: 'keep' }],
  });
  const formatted = formatSharedMemory(keepPlan.updatedMemoryEntries);
  const parsed = parseSharedMemory(formatted);
  assert.equal(parsed.length, 2);
  assert.ok(parsed[0]!.confirmation.includes('reviewed-keep:contradicted:newer-entry:'));
});

test('applyApprovedMemoryPruning enforces atomic write sequencing, baseline verification, and partial failure receipts', (t) => {
  const { memoryPath, projectRoot } = createFixture(t);
  mkdirSync(projectRoot, { recursive: true });
  const personalPath = resolvePersonalRulesPath(memoryPath);
  const agentsPath = join(projectRoot, 'AGENTS.md');

  const initialEntry: MemoryEntry = { source: 'A', scope: 'General', confirmation: 'confirmed', fact: 'Valid fact initially' };
  const retainedEntry: MemoryEntry = { source: 'B', scope: 'RetainedScope', confirmation: 'confirmed', fact: 'Retained fact stays' };
  writeSharedMemorySerialized(memoryPath, [initialEntry, retainedEntry], undefined);
  const initialPersonal = ['Personal rule 1: keep local'];
  writePersonalRulesSerialized(personalPath, initialPersonal, undefined);
  const initialAgentsText = '# Existing AGENTS\n\nRule 0.\n';
  writeFileSync(agentsPath, initialAgentsText, 'utf8');

  const memBase = readSharedMemory(memoryPath);
  const personalBase = readPersonalRules(personalPath);
  const agentsBaseHash = createHash('sha256').update(readFileSync(agentsPath, 'utf8')).digest('hex');

  const candidate: PruningCandidate = {
    entry: initialEntry,
    kind: 'redundant',
    reason: 'Covered',
    evidence: 'test',
    evidenceKey: 'test',
  };

  const plan = planMemoryPruning({
    memoryEntries: [initialEntry, retainedEntry],
    candidates: [candidate],
    dispositions: [{ entry: initialEntry, disposition: 'personal', targetRuleText: 'New personal rule 2' }],
    agentsText: initialAgentsText,
  });

  // 1. Missing baseline hashes or expectedPlanHash throw (F-25)
  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: true,
    memoryPath,
    memoryBaselineHash: '',
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  }), /valid memoryBaselineHash/);

  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: '',
    expectedPlanHash: plan.planHash,
  }), /valid personalBaselineHash/);

  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: '',
  }), /valid expectedPlanHash/);

  // 2. Mismatched or tampered planHash throws (F-25, F-31)
  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: 'tampered-plan-hash',
  }), /Approval plan hash does not match/);

  // Tampered plan content retaining old planHash throws (recomputed mismatch) (F-25, F-31)
  const tamperedPersonalPlan = {
    ...plan,
    promotedToPersonal: ['Tampered unapproved rule'],
  };
  assert.throws(() => applyApprovedMemoryPruning({
    plan: tamperedPersonalPlan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  }), /planHash does not match computed hash of plan content/);

  // Mutating updatedMemoryEntries[0].source throws (F-31)
  const tamperedSourcePlan = {
    ...plan,
    updatedMemoryEntries: plan.updatedMemoryEntries.map((e, i) => (i === 0 ? { ...e, source: 'TamperedSource' } : e)),
  };
  assert.throws(() => applyApprovedMemoryPruning({
    plan: tamperedSourcePlan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  }), /planHash does not match computed hash of plan content/);

  // Mutating updatedMemoryEntries[0].scope throws (F-31)
  const tamperedScopePlan = {
    ...plan,
    updatedMemoryEntries: plan.updatedMemoryEntries.map((e, i) => (i === 0 ? { ...e, scope: 'TamperedScope' } : e)),
  };
  assert.throws(() => applyApprovedMemoryPruning({
    plan: tamperedScopePlan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  }), /planHash does not match computed hash of plan content/);

  // Mutating updatedAgentsText throws (F-31)
  const tamperedAgentsTextPlan = {
    ...plan,
    updatedAgentsText: '# Tampered AGENTS\n',
  };
  assert.throws(() => applyApprovedMemoryPruning({
    plan: tamperedAgentsTextPlan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  }), /planHash does not match computed hash of plan content/);

  // Mutating agentsDiff throws (F-31)
  const tamperedAgentsDiffPlan = {
    ...plan,
    agentsDiff: '--- a/AGENTS.md\n+++ b/AGENTS.md\n+Tampered\n',
  };
  assert.throws(() => applyApprovedMemoryPruning({
    plan: tamperedAgentsDiffPlan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  }), /planHash does not match computed hash of plan content/);

  // 2b. Mutation tests on a real promotion plan covering candidates, dispositions, agentsBaselineHash, updatedAgentsText, agentsDiff, and agentsPath (F-40, F-43)
  const promoPlanForHashTest = planMemoryPruning({
    memoryEntries: [initialEntry, retainedEntry],
    candidates: [candidate],
    dispositions: [{ entry: initialEntry, disposition: 'promote', targetRuleText: 'Real promoted rule' }],
    agentsText: initialAgentsText,
    agentsPath,
  });

  assert.throws(() => applyApprovedMemoryPruning({
    plan: {
      ...promoPlanForHashTest,
      candidates: promoPlanForHashTest.candidates.map((c, i) => (i === 0 ? { ...c, reason: 'Tampered reason' } : c)),
    },
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: promoPlanForHashTest.planHash,
    agentsPath,
    agentsBaselineHash: promoPlanForHashTest.agentsBaselineHash,
  }), /planHash does not match computed hash of plan content/);

  assert.throws(() => applyApprovedMemoryPruning({
    plan: {
      ...promoPlanForHashTest,
      dispositions: promoPlanForHashTest.dispositions.map((d, i) => (i === 0 ? { ...d, targetRuleText: 'Tampered rule' } : d)),
    },
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: promoPlanForHashTest.planHash,
    agentsPath,
    agentsBaselineHash: promoPlanForHashTest.agentsBaselineHash,
  }), /planHash does not match computed hash of plan content/);

  assert.throws(() => applyApprovedMemoryPruning({
    plan: {
      ...promoPlanForHashTest,
      agentsBaselineHash: '0'.repeat(64),
    },
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: promoPlanForHashTest.planHash,
    agentsPath,
    agentsBaselineHash: promoPlanForHashTest.agentsBaselineHash,
  }), /planHash does not match computed hash of plan content/);

  assert.throws(() => applyApprovedMemoryPruning({
    plan: {
      ...promoPlanForHashTest,
      updatedAgentsText: promoPlanForHashTest.updatedAgentsText + '# extra\n',
    },
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: promoPlanForHashTest.planHash,
    agentsPath,
    agentsBaselineHash: promoPlanForHashTest.agentsBaselineHash,
  }), /planHash does not match computed hash of plan content/);

  assert.throws(() => applyApprovedMemoryPruning({
    plan: {
      ...promoPlanForHashTest,
      agentsDiff: promoPlanForHashTest.agentsDiff + '\n+tampered',
    },
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: promoPlanForHashTest.planHash,
    agentsPath,
    agentsBaselineHash: promoPlanForHashTest.agentsBaselineHash,
  }), /planHash does not match computed hash of plan content/);

  // Pointing an agentsPath-bound plan at a different AGENTS.md path throws even if content/baseline hash matches (F-43)
  const altAgentsPath = join(projectRoot, 'AGENTS.alt.md');
  writeFileSync(altAgentsPath, initialAgentsText, 'utf8');
  assert.throws(() => applyApprovedMemoryPruning({
    plan: promoPlanForHashTest,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: promoPlanForHashTest.planHash,
    agentsPath: altAgentsPath,
    agentsBaselineHash: promoPlanForHashTest.agentsBaselineHash,
  }), /AGENTS\.md path does not match the path recorded in MemoryPruningPlan/);

  // 3. Hand-built plan with promotedToAgents but missing updatedAgentsText throws before writing and leaves files unchanged (F-26, F-33)
  const planWithMissingAgentsText = {
    ...plan,
    promotedToAgents: ['Rule to promote'],
    updatedAgentsText: undefined,
  };
  (planWithMissingAgentsText as any).planHash = computePruningPlanHash(planWithMissingAgentsText);
  assert.throws(() => applyApprovedMemoryPruning({
    plan: planWithMissingAgentsText,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: planWithMissingAgentsText.planHash,
    agentsPath,
    agentsBaselineHash: agentsBaseHash,
  }), /Promotion to AGENTS\.md requires updatedAgentsText/);
  assert.equal(readSharedMemory(memoryPath).hash, memBase.hash);
  assert.equal(readPersonalRules(personalPath).hash, personalBase.hash);
  assert.equal(createHash('sha256').update(readFileSync(agentsPath, 'utf8')).digest('hex'), agentsBaseHash);

  // 4. Stale baseline hash or mismatched plan.agentsBaselineHash fails (F-32, F-33)
  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: true,
    memoryPath,
    memoryBaselineHash: 'stale-hash',
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  }), /Baseline hash does not match/);

  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: 'stale-personal-hash',
    expectedPlanHash: plan.planHash,
  }), /Baseline hash does not match/);

  // Pairing an older plan with a newer AGENTS.md disk baseline throws (F-32)
  const promotePlanForBaselineTest = planMemoryPruning({
    memoryEntries: [initialEntry, retainedEntry],
    candidates: [candidate],
    dispositions: [{ entry: initialEntry, disposition: 'promote', targetRuleText: 'Promoted rule for baseline test' }],
    agentsText: initialAgentsText,
    agentsPath,
  });
  writeFileSync(agentsPath, '# Existing AGENTS\n\nRule 0.\nNew concurrent edit.\n', 'utf8');
  const newerDiskAgentsHash = createHash('sha256').update(readFileSync(agentsPath, 'utf8')).digest('hex');
  // Passing the old baseline hash fails against disk
  assert.throws(() => applyApprovedMemoryPruning({
    plan: promotePlanForBaselineTest,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: promotePlanForBaselineTest.planHash,
    agentsPath,
    agentsBaselineHash: agentsBaseHash,
  }), /Concurrent modification detected on AGENTS\.md/);
  // Passing the newer disk hash fails against plan.agentsBaselineHash (F-32)
  assert.throws(() => applyApprovedMemoryPruning({
    plan: promotePlanForBaselineTest,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: promotePlanForBaselineTest.planHash,
    agentsPath,
    agentsBaselineHash: newerDiskAgentsHash,
  }), /AGENTS\.md baseline hash does not match the baseline hash recorded in MemoryPruningPlan/);
  // Restore AGENTS.md to initialAgentsText
  writeFileSync(agentsPath, initialAgentsText, 'utf8');

  // 5. Decline (approved: false) leaves files byte-identical
  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: false,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  }), /requires explicit human approval/);

  assert.equal(readSharedMemory(memoryPath).hash, memBase.hash);
  assert.equal(readPersonalRules(personalPath).hash, personalBase.hash);

  // 6. No-op plan leaves both files byte-identical without rewriting
  const noOpPlan = planMemoryPruning({
    memoryEntries: [initialEntry, retainedEntry],
    candidates: [],
    dispositions: [],
    agentsText: initialAgentsText,
  });
  const noOpRes = applyApprovedMemoryPruning({
    plan: noOpPlan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: noOpPlan.planHash,
  });
  assert.equal(noOpRes.success, true);
  assert.equal(readSharedMemory(memoryPath).hash, memBase.hash);
  assert.equal(readPersonalRules(personalPath).hash, personalBase.hash);

  // 7. Success path:
  // 7a. Personal rule promotion + MEMORY.md update
  const successRes = applyApprovedMemoryPruning({
    plan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
  });
  assert.equal(successRes.success, true);
  const updatedPersonal = readPersonalRules(personalPath);
  assert.ok(updatedPersonal.rules.includes('Personal rule 1: keep local'));
  assert.ok(updatedPersonal.rules.includes('New personal rule 2'));
  assert.equal(successRes.receipt.personalWritten, true);
  assert.equal(successRes.receipt.memoryWritten, true);
  assert.equal(successRes.receipt.personalHash, updatedPersonal.hash);
  const updatedMem = readSharedMemory(memoryPath);
  assert.equal(updatedMem.entries.length, 1);
  assert.equal(updatedMem.entries[0]!.fact, 'Retained fact stays');
  assert.equal(successRes.receipt.memoryHash, updatedMem.hash);

  // 7b. Successful AGENTS.md promotion write path: verifies content, receipt.agentsHash, and no leftover .tmp/.lock (F-33, F-35)
  const memBefore7b = readSharedMemory(memoryPath);
  const personalBefore7b = readPersonalRules(personalPath);
  const agentsPlan7b = planMemoryPruning({
    memoryEntries: [retainedEntry],
    candidates: [{ entry: retainedEntry, kind: 'redundant', reason: 'Covered', evidence: 'test', evidenceKey: 'k-7b' }],
    dispositions: [{ entry: retainedEntry, disposition: 'promote', targetRuleText: 'Always verify receipts after apply.' }],
    agentsText: readFileSync(agentsPath, 'utf8'),
    agentsPath,
  });
  const res7b = applyApprovedMemoryPruning({
    plan: agentsPlan7b,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBefore7b.hash,
    personalBaselineHash: personalBefore7b.hash,
    expectedPlanHash: agentsPlan7b.planHash,
    agentsPath,
    agentsBaselineHash: agentsPlan7b.agentsBaselineHash,
  });
  assert.equal(res7b.success, true);
  assert.equal(res7b.receipt.agentsWritten, true);
  assert.equal(res7b.receipt.personalWritten, false);
  assert.equal(res7b.receipt.memoryWritten, true);
  const writtenAgentsDisk = readFileSync(agentsPath, 'utf8');
  assert.equal(writtenAgentsDisk, agentsPlan7b.updatedAgentsText);
  const expectedAgentsDiskHash = createHash('sha256').update(writtenAgentsDisk).digest('hex');
  assert.equal(res7b.receipt.agentsHash, expectedAgentsDiskHash);
  assert.equal(res7b.agentsHash, expectedAgentsDiskHash);
  const leftoverFiles = readdirSync(projectRoot).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
  assert.deepEqual(leftoverFiles, []);

  // 8. Partial failures and no-files-modified failures across write positions (F-27, F-33, F-35, F-37):
  const thirdEntry: MemoryEntry = { source: 'C', scope: 'General', confirmation: 'confirmed', fact: 'Fact 3' };
  const fourthEntry: MemoryEntry = { source: 'D', scope: 'General', confirmation: 'confirmed', fact: 'Fact 4' };

  // 8.0. Failure at step 1 ('agents' locked) before any file is written reports "no files were modified" and failedStep === 'agents' (F-35, F-37)
  writeSharedMemorySerialized(memoryPath, [thirdEntry], undefined);
  const memHash80 = readSharedMemory(memoryPath).hash;
  const personalHash80 = readPersonalRules(personalPath).hash;
  const agentsText80 = readFileSync(agentsPath, 'utf8');
  const plan80 = planMemoryPruning({
    memoryEntries: [thirdEntry],
    candidates: [{ entry: thirdEntry, kind: 'redundant', reason: 'Covered', evidence: 'test', evidenceKey: 'k3' }],
    dispositions: [{ entry: thirdEntry, disposition: 'promote', targetRuleText: 'Rule blocked by lock' }],
    agentsText: agentsText80,
    agentsPath,
  });
  const agentsLockFd = openSync(`${agentsPath}.lock`, 'wx');
  try {
    let err80: any;
    try {
      applyApprovedMemoryPruning({
        plan: plan80,
        approved: true,
        memoryPath,
        memoryBaselineHash: memHash80,
        personalBaselineHash: personalHash80,
        expectedPlanHash: plan80.planHash,
        agentsPath,
        agentsBaselineHash: plan80.agentsBaselineHash,
      });
    } catch (err) {
      err80 = err;
    }
    assert.ok(err80 instanceof MemoryPruningApplyError);
    assert.match(err80.message, /no files were modified/);
    assert.equal(err80.receipt.failedStep, 'agents');
    assert.match(err80.receipt.cause ?? '', /Another writer holds the lock/);
    assert.equal(err80.receipt.agentsWritten, false);
    assert.equal(err80.receipt.personalWritten, false);
    assert.equal(err80.receipt.memoryWritten, false);
  } finally {
    closeSync(agentsLockFd);
    unlinkSync(`${agentsPath}.lock`);
  }

  // 8a. AGENTS.md written, then personal rule write fails (locked)
  const memHashBefore8a = readSharedMemory(memoryPath).hash;
  const personalHashBefore8a = readPersonalRules(personalPath).hash;
  const agentsTextBefore8a = readFileSync(agentsPath, 'utf8');

  const personalLockFd = openSync(`${personalPath}.lock`, 'wx');
  try {
    let err8a: any;
    try {
      const planWithBoth = planMemoryPruning({
        memoryEntries: [thirdEntry, fourthEntry],
        candidates: [
          { entry: thirdEntry, kind: 'redundant', reason: 'Covered', evidence: 'test', evidenceKey: 'k3' },
          { entry: fourthEntry, kind: 'redundant', reason: 'Covered', evidence: 'test', evidenceKey: 'k4' },
        ],
        dispositions: [
          { entry: thirdEntry, disposition: 'promote', targetRuleText: 'Promoted rule from 8a' },
          { entry: fourthEntry, disposition: 'personal', targetRuleText: 'Personal rule causing failure' },
        ],
        agentsText: agentsTextBefore8a,
        agentsPath,
      });

      applyApprovedMemoryPruning({
        plan: planWithBoth,
        approved: true,
        memoryPath,
        memoryBaselineHash: memHashBefore8a,
        personalBaselineHash: personalHashBefore8a,
        expectedPlanHash: planWithBoth.planHash,
        agentsPath,
        agentsBaselineHash: planWithBoth.agentsBaselineHash,
      });
    } catch (err) {
      err8a = err;
    }
    assert.ok(err8a instanceof MemoryPruningApplyError);
    assert.match(err8a.message, /Partial failure during memory pruning write sequence at personal/);
    assert.equal(err8a.receipt.failedStep, 'personal');
    assert.match(err8a.receipt.cause ?? '', /Another writer holds the lock/);
    assert.equal(err8a.receipt.agentsWritten, true);
    assert.equal(
      err8a.receipt.agentsHash,
      createHash('sha256').update(readFileSync(agentsPath, 'utf8')).digest('hex')
    );
    assert.equal(err8a.receipt.personalWritten, false);
    assert.equal(err8a.receipt.memoryWritten, false);
  } finally {
    closeSync(personalLockFd);
    unlinkSync(`${personalPath}.lock`);
  }

  // 8b. AGENTS.md written, then MEMORY.md fails (locked) (F-33)
  const agentsTextAfter8a = readFileSync(agentsPath, 'utf8');
  const currentPersonalHashAfter8a = readPersonalRules(personalPath).hash;
  const currentMemHashAfter8a = readSharedMemory(memoryPath).hash;

  const plan8b = planMemoryPruning({
    memoryEntries: [thirdEntry, fourthEntry],
    candidates: [{ entry: thirdEntry, kind: 'redundant', reason: 'Covered', evidence: 'test', evidenceKey: 'k3' }],
    dispositions: [
      { entry: thirdEntry, disposition: 'promote', targetRuleText: 'Promoted rule from 8b' },
    ],
    agentsText: agentsTextAfter8a,
    agentsPath,
  });

  const memLockFd8b = openSync(`${memoryPath}.lock`, 'wx');
  try {
    let err8b: any;
    try {
      applyApprovedMemoryPruning({
        plan: plan8b,
        approved: true,
        memoryPath,
        memoryBaselineHash: currentMemHashAfter8a,
        personalBaselineHash: currentPersonalHashAfter8a,
        expectedPlanHash: plan8b.planHash,
        agentsPath,
        agentsBaselineHash: plan8b.agentsBaselineHash,
      });
    } catch (err) {
      err8b = err;
    }
    assert.ok(err8b instanceof MemoryPruningApplyError);
    assert.match(err8b.message, /Partial failure during memory pruning write sequence at memory/);
    assert.equal(err8b.receipt.failedStep, 'memory');
    assert.match(err8b.receipt.cause ?? '', /Another writer holds the lock/);
    assert.equal(err8b.receipt.agentsWritten, true);
    assert.equal(
      err8b.receipt.agentsHash,
      createHash('sha256').update(readFileSync(agentsPath, 'utf8')).digest('hex')
    );
    assert.equal(err8b.receipt.personalWritten, false);
    assert.equal(err8b.receipt.memoryWritten, false);
  } finally {
    closeSync(memLockFd8b);
    unlinkSync(`${memoryPath}.lock`);
  }

  // 8c. Personal written, then MEMORY.md fails (locked)
  const agentsTextAfter8b = readFileSync(agentsPath, 'utf8');
  const currentPersonalHashAfter8b = readPersonalRules(personalPath).hash;
  const currentMemHashAfter8b = readSharedMemory(memoryPath).hash;

  const plan8c = planMemoryPruning({
    memoryEntries: [thirdEntry, fourthEntry],
    candidates: [{ entry: thirdEntry, kind: 'redundant', reason: 'Covered', evidence: 'test', evidenceKey: 'k3' }],
    dispositions: [
      { entry: thirdEntry, disposition: 'personal', targetRuleText: 'New personal rule 8c' },
    ],
    agentsText: agentsTextAfter8b,
  });

  const memLockFd8c = openSync(`${memoryPath}.lock`, 'wx');
  try {
    let err8c: any;
    try {
      applyApprovedMemoryPruning({
        plan: plan8c,
        approved: true,
        memoryPath,
        memoryBaselineHash: currentMemHashAfter8b,
        personalBaselineHash: currentPersonalHashAfter8b,
        expectedPlanHash: plan8c.planHash,
      });
    } catch (err) {
      err8c = err;
    }
    assert.ok(err8c instanceof MemoryPruningApplyError);
    assert.match(err8c.message, /Partial failure during memory pruning write sequence at memory/);
    assert.equal(err8c.receipt.failedStep, 'memory');
    assert.equal(err8c.receipt.agentsWritten, false);
    assert.equal(err8c.receipt.personalWritten, true);
    assert.equal(err8c.receipt.personalHash, readPersonalRules(personalPath).hash);
    assert.equal(err8c.receipt.memoryWritten, false);
  } finally {
    closeSync(memLockFd8c);
    unlinkSync(`${memoryPath}.lock`);
  }

  // 8d. Rejects directory at agentsPath (non-regular file guard) (F-35)
  const dirAsAgentsPath = join(projectRoot, 'AGENTS_DIR');
  mkdirSync(dirAsAgentsPath, { recursive: true });
  const plan8d = planMemoryPruning({
    memoryEntries: [thirdEntry, fourthEntry],
    candidates: [{ entry: thirdEntry, kind: 'redundant', reason: 'Covered', evidence: 'test', evidenceKey: 'k3' }],
    dispositions: [{ entry: thirdEntry, disposition: 'promote', targetRuleText: 'Promoted rule from 8b' }],
    agentsText: agentsTextAfter8a,
    agentsPath: dirAsAgentsPath,
  });
  assert.throws(() => applyApprovedMemoryPruning({
    plan: plan8d,
    approved: true,
    memoryPath,
    memoryBaselineHash: currentMemHashAfter8b,
    personalBaselineHash: readPersonalRules(personalPath).hash,
    expectedPlanHash: plan8d.planHash,
    agentsPath: dirAsAgentsPath,
    agentsBaselineHash: plan8d.agentsBaselineHash,
  }), /AGENTS\.md path must be a regular file/);
});

test('markEntryReviewed caps keep tags and evicts oldest, preserving case and rejecting invalid keys', () => {
  let entry: MemoryEntry = { source: 'Dev', scope: 'General', confirmation: 'initial', fact: 'Fact' };

  // Add 6 keep tags sequentially: oldest should be evicted at cap of 5 (F-30)
  for (let i = 1; i <= 6; i++) {
    const candidate: PruningCandidate = {
      entry,
      kind: 'obsolete',
      reason: 'test',
      evidence: 'test',
      evidenceKey: `Issue:${i}`, // Case should be preserved
    };
    entry = markEntryReviewed(entry, candidate);
  }

  assert.ok(entry.confirmation.includes('(reviewed-keep:obsolete:Issue:6)'));
  assert.ok(entry.confirmation.includes('(reviewed-keep:obsolete:Issue:2)'));
  // Oldest (Issue:1) must be evicted!
  assert.ok(!entry.confirmation.includes('Issue:1'));

  // Rejects keys containing ) or newlines
  assert.throws(() => markEntryReviewed(entry, {
    entry,
    kind: 'obsolete',
    reason: 'test',
    evidence: 'test',
    evidenceKey: 'issue:100)',
  }), /closing parenthesis/);

  assert.throws(() => markEntryReviewed(entry, {
    entry,
    kind: 'obsolete',
    reason: 'test',
    evidence: 'test',
    evidenceKey: 'issue:100\nmalformed',
  }), /closing parenthesis|newlines/);
});

test('validatePromotedRuleText and validatePersonalRuleText reject secrets, paths, and limits', () => {
  assert.throws(() => validatePromotedRuleText(''), /cannot be empty/);
  assert.throws(() => validatePromotedRuleText('   '), /cannot be empty/);
  assert.throws(() => validatePromotedRuleText('line 1\nline 2'), /must not contain raw newlines/);
  assert.throws(() => validatePromotedRuleText('ghp_012345678901234567890123456789'), /potential secret\/token/);
  assert.throws(() => validatePromotedRuleText('/Users/test/Projects/advanced-harness-worktrees/test'), /machine-local/);
  assert.throws(() => validatePromotedRuleText('/home/alice/Projects/advanced-harness-worktrees/test'), /machine-local/);
  assert.throws(() => validatePromotedRuleText('C:\\Users\\Alice\\Projects\\advanced-harness-worktrees\\issue-1'), /machine-local/);
  assert.throws(() => validatePromotedRuleText('\\\\server\\share\\Projects\\advanced-harness-worktrees\\issue-1'), /machine-local/);
  assert.throws(() => validatePromotedRuleText('a'.repeat(2001)), /exceeds maximum length/);

  // Positive valid rule check executes without error
  validatePromotedRuleText('Always check lint before commit.');
  validatePersonalRuleText('Use dark theme in developer tools.');
});

test('applyApprovedMemoryPruning handles Windows path case and preserves POSIX mode', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-pruning-case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const memoryPath = join(dir, 'MEMORY.md');
  const personalPath = join(dir, 'AGENTS.personal.md');
  const agentsPath = join(dir, 'AGENTS.md');

  const entry = {
    date: '2026-11-12',
    scope: 'edge-topic',
    summary: 'Edge test learning',
    fact: 'Edge test learning',
    confirmation: 'approved',
    source: 'PR #224',
    tags: [],
  };
  const initialAgentsText = '# AGENTS\n\n- Existing rule\n';
  writeFileSync(memoryPath, formatSharedMemory([entry]), 'utf8');
  writeFileSync(personalPath, '', 'utf8');
  writeFileSync(agentsPath, initialAgentsText, 'utf8');

  if (process.platform !== 'win32') {
    chmodSync(agentsPath, 0o640);
  }

  const memBase = readSharedMemory(memoryPath);
  const personalBase = readPersonalRules(personalPath);
  const agentsBaseHash = createHash('sha256').update(initialAgentsText, 'utf8').digest('hex');

  const candidate = {
    entry,
    kind: 'redundant' as const,
    reason: 'Covered by AGENTS.md',
    evidence: 'AGENTS.md',
    evidenceKey: 'agents:1',
  };
  const plan = planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [{ entry, disposition: 'promote', targetRuleText: 'Promoted edge rule' }],
    agentsText: initialAgentsText,
    agentsPath,
  });

  const caseVariantAgentsPath = process.platform === 'win32'
    ? agentsPath.toUpperCase()
    : agentsPath;

  const result = applyApprovedMemoryPruning({
    plan,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: plan.planHash,
    agentsPath: caseVariantAgentsPath,
    agentsBaselineHash: agentsBaseHash,
  });
  assert.equal(result.receipt.agentsWritten, true);
  assert.match(readFileSync(agentsPath, 'utf8'), /Promoted edge rule/);
  assert.equal(readSharedMemory(memoryPath).entries.length, 0);

  if (process.platform !== 'win32') {
    assert.equal(statSync(agentsPath).mode & 0o777, 0o640);
  }
});

test('applyApprovedMemoryPruning reports stale lock and rejects missing AGENTS.md parent', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-pruning-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const memoryPath = join(dir, 'MEMORY.md');
  const personalPath = join(dir, 'AGENTS.personal.md');
  const agentsPath = join(dir, 'AGENTS.md');

  const entry = {
    date: '2026-11-12',
    scope: 'edge-topic',
    summary: 'Edge test learning',
    fact: 'Edge test learning',
    confirmation: 'approved',
    source: 'PR #224',
    tags: [],
  };
  const initialAgentsText = '# AGENTS\n\n- Existing rule\n';
  writeFileSync(memoryPath, formatSharedMemory([entry]), 'utf8');
  writeFileSync(personalPath, '', 'utf8');
  writeFileSync(agentsPath, initialAgentsText, 'utf8');

  const memBase = readSharedMemory(memoryPath);
  const personalBase = readPersonalRules(personalPath);
  const agentsBaseHash = createHash('sha256').update(initialAgentsText, 'utf8').digest('hex');

  const candidate = {
    entry,
    kind: 'redundant' as const,
    reason: 'Covered by AGENTS.md',
    evidence: 'AGENTS.md',
    evidenceKey: 'agents:1',
  };

  const lockPath = `${agentsPath}.lock`;
  writeFileSync(lockPath, 'stale', 'utf8');
  try {
    const plan = planMemoryPruning({
      memoryEntries: [entry],
      candidates: [candidate],
      dispositions: [{ entry, disposition: 'promote', targetRuleText: 'Promoted edge rule' }],
      agentsText: initialAgentsText,
      agentsPath,
    });
    assert.throws(() => applyApprovedMemoryPruning({
      plan,
      approved: true,
      memoryPath,
      memoryBaselineHash: memBase.hash,
      personalBaselineHash: personalBase.hash,
      expectedPlanHash: plan.planHash,
      agentsPath,
      agentsBaselineHash: agentsBaseHash,
    }), /remove stale AGENTS\.md\.lock/i);
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }

  const missingParentAgents = join(dir, 'missing-parent', 'AGENTS.md');
  const planMissingParent = planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [{ entry, disposition: 'promote', targetRuleText: 'Promoted edge rule 2' }],
    agentsText: initialAgentsText,
    agentsPath: missingParentAgents,
  });
  assert.throws(() => applyApprovedMemoryPruning({
    plan: planMissingParent,
    approved: true,
    memoryPath,
    memoryBaselineHash: memBase.hash,
    personalBaselineHash: personalBase.hash,
    expectedPlanHash: planMissingParent.planHash,
    agentsPath: missingParentAgents,
    agentsBaselineHash: agentsBaseHash,
  }), /parent directory does not exist/i);
});

test('applyApprovedMemoryPruning rejects dangling AGENTS.md symlink', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-pruning-symlink-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const memoryPath = join(dir, 'MEMORY.md');
  const personalPath = join(dir, 'AGENTS.personal.md');
  const danglingAgents = join(dir, 'dangling-AGENTS.md');

  const entry = {
    date: '2026-11-12',
    scope: 'edge-topic',
    summary: 'Edge test learning',
    fact: 'Edge test learning',
    confirmation: 'approved',
    source: 'PR #224',
    tags: [],
  };
  const initialAgentsText = '# AGENTS\n\n- Existing rule\n';
  writeFileSync(memoryPath, formatSharedMemory([entry]), 'utf8');
  writeFileSync(personalPath, '', 'utf8');

  try {
    symlinkSync(join(dir, 'nonexistent-target.md'), danglingAgents);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Symlink creation requires elevated privileges on Windows');
      return;
    }
    throw err;
  }

  const candidate = {
    entry,
    kind: 'redundant' as const,
    reason: 'Covered by AGENTS.md',
    evidence: 'AGENTS.md',
    evidenceKey: 'agents:1',
  };
  const planDangling = planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [{ entry, disposition: 'promote', targetRuleText: 'Promoted edge rule' }],
    agentsText: initialAgentsText,
    agentsPath: danglingAgents,
  });
  assert.throws(() => applyApprovedMemoryPruning({
    plan: planDangling,
    approved: true,
    memoryPath,
    memoryBaselineHash: readSharedMemory(memoryPath).hash,
    personalBaselineHash: readPersonalRules(personalPath).hash,
    expectedPlanHash: planDangling.planHash,
    agentsPath: danglingAgents,
    agentsBaselineHash: createHash('sha256').update(initialAgentsText, 'utf8').digest('hex'),
  }), /symlink/i);
});

test('planMemoryPruning and applyApprovedMemoryPruning require agentsPath when promotions exist', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-pruning-unbound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const memoryPath = join(dir, 'MEMORY.md');
  const personalPath = join(dir, 'AGENTS.personal.md');
  const agentsPath = join(dir, 'AGENTS.md');

  const entry = {
    date: '2026-11-12',
    scope: 'edge-topic',
    summary: 'Edge test learning',
    fact: 'Edge test learning',
    confirmation: 'approved',
    source: 'PR #224',
    tags: [],
  };
  const initialAgentsText = '# AGENTS\n\n- Existing rule\n';
  writeFileSync(memoryPath, formatSharedMemory([entry]), 'utf8');
  writeFileSync(personalPath, '', 'utf8');
  writeFileSync(agentsPath, initialAgentsText, 'utf8');

  const candidate = {
    entry,
    kind: 'redundant' as const,
    reason: 'Covered by AGENTS.md',
    evidence: 'AGENTS.md',
    evidenceKey: 'agents:1',
  };

  assert.throws(() => planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [{ entry, disposition: 'promote', targetRuleText: 'Promoted unbound rule' }],
    agentsText: initialAgentsText,
  }), /requires agentsPath when agentsText is provided/i);

  const validPlan = planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [{ entry, disposition: 'promote', targetRuleText: 'Promoted unbound rule' }],
    agentsText: initialAgentsText,
    agentsPath,
  });
  const unboundPlan = { ...validPlan, agentsPath: undefined };
  unboundPlan.planHash = computePruningPlanHash(unboundPlan);

  assert.throws(() => applyApprovedMemoryPruning({
    plan: unboundPlan,
    approved: true,
    memoryPath,
    memoryBaselineHash: readSharedMemory(memoryPath).hash,
    personalBaselineHash: readPersonalRules(personalPath).hash,
    expectedPlanHash: unboundPlan.planHash,
    agentsPath,
    agentsBaselineHash: createHash('sha256').update(initialAgentsText, 'utf8').digest('hex'),
  }), /requires agentsPath to be recorded in MemoryPruningPlan/i);
});

test('applyApprovedMemoryPruning cleans up temp file when source AGENTS.md is read-only', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-pruning-readonly-'));
  t.after(() => {
    try { chmodSync(join(dir, 'AGENTS.md'), 0o644); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  const memoryPath = join(dir, 'MEMORY.md');
  const personalPath = join(dir, 'AGENTS.personal.md');
  const agentsPath = join(dir, 'AGENTS.md');

  const entry = {
    date: '2026-11-12',
    scope: 'edge-topic',
    summary: 'Edge test learning',
    fact: 'Edge test learning',
    confirmation: 'approved',
    source: 'PR #224',
    tags: [],
  };
  const initialAgentsText = '# AGENTS\n\n- Existing rule\n';
  writeFileSync(memoryPath, formatSharedMemory([entry]), 'utf8');
  writeFileSync(personalPath, '', 'utf8');
  writeFileSync(agentsPath, initialAgentsText, 'utf8');
  chmodSync(agentsPath, 0o444);

  const candidate = {
    entry,
    kind: 'redundant' as const,
    reason: 'Covered by AGENTS.md',
    evidence: 'AGENTS.md',
    evidenceKey: 'agents:1',
  };
  const plan = planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [{ entry, disposition: 'promote', targetRuleText: 'Promoted readonly rule' }],
    agentsText: initialAgentsText,
    agentsPath,
  });

  if (process.platform === 'win32') {
    let caught: unknown;
    try {
      applyApprovedMemoryPruning({
        plan,
        approved: true,
        memoryPath,
        memoryBaselineHash: readSharedMemory(memoryPath).hash,
        personalBaselineHash: readPersonalRules(personalPath).hash,
        expectedPlanHash: plan.planHash,
        agentsPath,
        agentsBaselineHash: createHash('sha256').update(initialAgentsText, 'utf8').digest('hex'),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof MemoryPruningApplyError);
    assert.equal(caught.receipt.failedStep, 'agents');
    assert.equal(caught.receipt.agentsWritten, false);
  } else {
    const result = applyApprovedMemoryPruning({
      plan,
      approved: true,
      memoryPath,
      memoryBaselineHash: readSharedMemory(memoryPath).hash,
      personalBaselineHash: readPersonalRules(personalPath).hash,
      expectedPlanHash: plan.planHash,
      agentsPath,
      agentsBaselineHash: createHash('sha256').update(initialAgentsText, 'utf8').digest('hex'),
    });
    assert.equal(result.receipt.agentsWritten, true);
    assert.equal(statSync(agentsPath).mode & 0o777, 0o444);
  }

  const leftover = readdirSync(dir).filter((f) => f.startsWith('.AGENTS.') && f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});
