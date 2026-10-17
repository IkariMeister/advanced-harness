import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type MemoryEntry,
  type BootstrapContext,
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

test('checkBootstrapReadiness permits existing worktrees and canonical edits but flags target collisions', (t) => {
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

  // Requires explicit approval to apply
  assert.throws(() => applyApprovedRulePromotion(plan, false), /Rule promotion requires explicit human approval/);
  const updated = applyApprovedRulePromotion(plan, true);
  assert.equal(updated, plan.updatedAgentsText);

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
