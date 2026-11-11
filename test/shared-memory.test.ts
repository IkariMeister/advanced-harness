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
  validatePromotedRuleText,
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
  assert.throws(() => validatePersonalRuleText('github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz'), /potential secret or credential/);
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
  }), /potential secret or credential/);

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
    // Should NOT be flagged as contradicted because it explicitly negates auto-merge
    { source: 'Git', scope: 'Workflow', confirmation: 'approved', fact: 'Never auto-merge pull requests' },
    // Two unrelated facts in the same scope: should NOT flag the first as contradicted
    { source: 'Tooling', scope: 'Versions', confirmation: 'approved', fact: 'Node 24 is active' },
    { source: 'Tooling', scope: 'Versions', confirmation: 'approved', fact: 'TypeScript 7 is active' },
    // Prose with "branch protection": should NOT match branch obsolete check
    { source: 'Security', scope: 'Git', confirmation: 'approved', fact: 'Configure branch protection for main' },
    // Prose with "#1": should NOT match obsolete issue if it's not an issue reference
    { source: 'Rank', scope: 'Priority', confirmation: 'approved', fact: 'Priority is #1 item in queue' },
    // Candidate with external check that returns "unknown" (e.g. offline/error): must NOT be flagged as obsolete
    { source: 'Bug', scope: 'Fixes', confirmation: 'approved', fact: 'Fixes issue #888' },
  ];

  const externalChecker = {
    checkIssueExists: (id: string) => (id === '888' ? { status: 'unknown' as TriStateResult, evidence: 'Network error' } : { status: 'exists' as TriStateResult, evidence: 'Exists' }),
    checkBranchExists: () => 'exists' as TriStateResult,
    checkFileExists: () => 'exists' as TriStateResult,
  };

  const candidates = detectPruningCandidates({
    memoryEntries: entries,
    agentsText: agents,
    personalRules: personal,
    externalChecker,
  });

  // Zero false positives should be produced
  assert.equal(candidates.length, 0);
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
    { source: 'Test', scope: 'Tooling', confirmation: 'approved', fact: 'Node 18 is required' },
    // 4: newer entry superseding #3
    { source: 'Test', scope: 'Tooling', confirmation: 'replaces Node 18', fact: 'Node 24 is required' },
    // 5: obsolete: refers to deleted issue #999
    { source: 'IssueTracker', scope: 'Fixes', confirmation: 'approved', fact: 'Resolves issue #999 for good' },
    // 6: obsolete: refers to deleted branch issue/999
    { source: 'Git', scope: 'Branches', confirmation: 'approved', fact: 'Tracking branch issue/999' },
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

  // Redundant with personal
  assert.equal(candidates[1]!.kind, 'redundant');
  assert.equal(candidates[1]!.entry.fact, 'Use 2 spaces for indentation');
  assert.match(candidates[1]!.reason, /personal rule/);

  // Contradicted by AGENTS.md
  assert.equal(candidates[2]!.kind, 'contradicted');
  assert.equal(candidates[2]!.entry.fact, 'Merges automatically when tests pass');

  // Superseded by newer entry
  assert.equal(candidates[3]!.kind, 'contradicted');
  assert.equal(candidates[3]!.entry.fact, 'Node 18 is required');
  assert.match(candidates[3]!.evidence, /Node 24 is required/);

  // Obsolete issue
  assert.equal(candidates[4]!.kind, 'obsolete');
  assert.equal(candidates[4]!.entry.fact, 'Resolves issue #999 for good');
  assert.match(candidates[4]!.reason, /#999/);

  // Obsolete branch
  assert.equal(candidates[5]!.kind, 'obsolete');
  assert.equal(candidates[5]!.entry.fact, 'Tracking branch issue/999');
  assert.match(candidates[5]!.reason, /branch "issue\/999"/);

  // Obsolete file
  assert.equal(candidates[6]!.kind, 'obsolete');
  assert.equal(candidates[6]!.entry.fact, 'Inspect file `src/obsolete.ts` on start');
  assert.match(candidates[6]!.reason, /file "src\/obsolete\.ts"/);
});

test('planMemoryPruning handles promote, personal, keep, and discard dispositions accurately and rechecks', () => {
  const agentsOriginal = '# Project Guidelines\n\nExisting rule.\n';
  const entries: MemoryEntry[] = [
    { source: 'Review', scope: 'Repo', confirmation: 'approved', fact: 'Promote this rule to AGENTS' },
    { source: 'Operator', scope: 'User', confirmation: 'approved', fact: 'Promote this rule to personal' },
    { source: 'Test', scope: 'Legacy', confirmation: 'approved', fact: 'Discard this obsolete fact' },
    { source: 'Dev', scope: 'Context', confirmation: 'approved', fact: 'Keep this valid fact in memory' },
  ];

  const candidates: PruningCandidate[] = [
    { entry: entries[0]!, kind: 'redundant', reason: 'Covered', evidence: 'agents-rule' },
    { entry: entries[1]!, kind: 'redundant', reason: 'Personal rule', evidence: 'personal-rule' },
    { entry: entries[2]!, kind: 'obsolete', reason: 'Obsolete', evidence: 'file:deleted.ts' },
    { entry: entries[3]!, kind: 'obsolete', reason: 'Issue closed', evidence: 'issue:100' },
  ];

  const dispositions: PruningDisposition[] = [
    { entry: entries[0]!, disposition: 'promote', targetRuleText: 'Promoted rule for AGENTS' },
    { entry: entries[1]!, disposition: 'personal', targetRuleText: 'Personal preference rule' },
    { entry: entries[2]!, disposition: 'discard' },
    { entry: entries[3]!, disposition: 'keep' },
  ];

  const plan = planMemoryPruning({
    memoryEntries: entries,
    candidates,
    dispositions,
    agentsText: agentsOriginal,
  });

  // Verify memory removals and keep retention
  assert.equal(plan.updatedMemoryEntries.length, 1);
  assert.equal(plan.updatedMemoryEntries[0]!.fact, 'Keep this valid fact in memory');
  assert.ok(plan.updatedMemoryEntries[0]!.confirmation.includes('reviewed-keep:obsolete'));

  // Counts
  assert.equal(plan.keptCount, 1);
  assert.equal(plan.discardedCount, 1);
  assert.deepEqual(plan.promotedToAgents, ['Promoted rule for AGENTS']);
  assert.deepEqual(plan.promotedToPersonal, ['Personal preference rule']);

  // AGENTS.md diff
  assert.ok(plan.agentsDiff?.includes('+- Promoted rule for AGENTS'));
  assert.ok(!plan.agentsDiff?.includes('Personal preference rule'));

  // Re-checking with the SAME trigger yields ZERO candidates for the kept entry
  const externalChecker = {
    checkIssueExists: (id: string) => (id === '100' ? { status: 'missing' as TriStateResult, evidence: 'issue:100' } : 'exists' as TriStateResult),
  };
  const rechecked = detectPruningCandidates({
    memoryEntries: plan.updatedMemoryEntries,
    externalChecker,
  });
  assert.equal(rechecked.length, 0);

  // If evidence changes (e.g. now referring to a branch), it IS re-proposed
  const changedEvidenceChecker = {
    checkIssueExists: () => 'exists' as TriStateResult,
    checkBranchExists: () => ({ status: 'missing' as TriStateResult, evidence: 'branch:new-branch' }),
  };
  const withBranchFact: MemoryEntry[] = [
    { ...plan.updatedMemoryEntries[0]!, fact: 'Tracking branch issue/100' },
  ];
  const recheckedNewReason = detectPruningCandidates({
    memoryEntries: withBranchFact,
    externalChecker: changedEvidenceChecker,
  });
  assert.equal(recheckedNewReason.length, 1);
});

test('planMemoryPruning validates dispositions, rejects non-candidates and duplicates, and enforces atomicity', (t) => {
  const { memoryPath } = createFixture(t);
  const entry: MemoryEntry = { source: 'A', scope: 'B', confirmation: 'C', fact: 'Valid fact' };
  const candidate: PruningCandidate = { entry, kind: 'redundant', reason: 'Covered', evidence: 'test' };

  // Rejects disposition for non-candidate
  assert.throws(() => planMemoryPruning({
    memoryEntries: [entry],
    candidates: [],
    dispositions: [{ entry, disposition: 'discard' }],
  }), /not a recognized pruning candidate/);

  // Rejects duplicate dispositions
  assert.throws(() => planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [
      { entry, disposition: 'discard' },
      { entry, disposition: 'keep' },
    ],
  }), /Duplicate disposition/);

  // Rejects promote without agentsText
  assert.throws(() => planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [{ entry, disposition: 'promote' }],
    agentsText: undefined,
  }), /requires agentsText destination/);

  // Apply without approval throws
  const plan = planMemoryPruning({
    memoryEntries: [entry],
    candidates: [candidate],
    dispositions: [{ entry, disposition: 'discard' }],
    agentsText: '# Rules',
  });
  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: false,
    memoryPath,
  }), /requires explicit human approval/);

  // Decline / cancel writes nothing
  writeSharedMemorySerialized(memoryPath, [entry], undefined);
  const beforeMem = readSharedMemory(memoryPath);
  assert.throws(() => applyApprovedMemoryPruning({
    plan,
    approved: false,
    memoryPath,
  }), /explicit human approval/);
  const afterMem = readSharedMemory(memoryPath);
  assert.equal(beforeMem.hash, afterMem.hash);
});

test('validatePromotedRuleText rejects secrets, Windows and UNC local paths', () => {
  assert.throws(() => validatePromotedRuleText(''), /cannot be empty/);
  assert.throws(() => validatePromotedRuleText('line 1\nline 2'), /must not contain raw newlines/);
  assert.throws(() => validatePromotedRuleText('ghp_012345678901234567890123456789'), /potential secret\/token/);
  assert.throws(() => validatePromotedRuleText('/Users/test/Projects/advanced-harness-worktrees/test'), /machine-local/);
  assert.throws(() => validatePromotedRuleText('C:\\Users\\Alice\\Projects\\advanced-harness-worktrees\\issue-1'), /machine-local/);
  assert.throws(() => validatePromotedRuleText('\\\\server\\share\\Projects\\advanced-harness-worktrees\\issue-1'), /machine-local/);
  assert.doesNotMatch('Always check lint before commit', /error/);
});
