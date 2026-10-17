import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceVersion, checkRemoteHead, compareInstalledAndSource } from '../src/harness-version.ts';

test('compareInstalledAndSource reports unknown-installed for undefined or missing stamps', () => {
  assert.equal(compareInstalledAndSource(undefined, { version: '0.1.0', commit: 'abc', dirty: false }), 'unknown-installed');
  assert.equal(compareInstalledAndSource({ version: '0.1.0', commit: '' }, { version: '0.1.0', commit: 'abc', dirty: false }), 'unknown-installed');
});

test('compareInstalledAndSource reports up-to-date when commits match', () => {
  assert.equal(
    compareInstalledAndSource(
      { version: '0.1.0', commit: 'b1a927d' },
      { version: '0.1.0', commit: 'b1a927d', dirty: false }
    ),
    'up-to-date'
  );
});

test('compareInstalledAndSource reports source-newer when commits differ', () => {
  assert.equal(
    compareInstalledAndSource(
      { version: '0.1.0', commit: 'old-commit' },
      { version: '0.1.0', commit: 'new-commit', dirty: false }
    ),
    'source-newer'
  );
});

test('readSourceVersion uses runner and package.json', () => {
  const runner = (cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return 'abc1234';
    if (args[0] === 'status') return ' M src/foo.ts';
    return '';
  };
  const res = readSourceVersion(process.cwd(), runner);
  assert.equal(res.commit, 'abc1234');
  assert.equal(res.dirty, true);
  assert.equal(typeof res.version, 'string');
});

test('checkRemoteHead detects up-to-date, remote-newer, local-ahead, diverged, and inconclusive', () => {
  // 1. Inconclusive on ls-remote failure
  assert.deepEqual(
    checkRemoteHead('/repo', () => { throw new Error('network down'); }),
    { status: 'inconclusive' }
  );

  // 2. Up to date
  const mockUpToDate = (_cmd: string, args: string[]) => {
    if (args[0] === 'ls-remote') return '1111111111111111111111111111111111111111\trefs/heads/main';
    if (args[0] === 'rev-parse') return '1111111111111111111111111111111111111111';
    return '';
  };
  assert.deepEqual(checkRemoteHead('/repo', mockUpToDate), {
    remoteHead: '1111111111111111111111111111111111111111',
    status: 'up-to-date'
  });

  // 3. Local ahead
  const mockLocalAhead = (_cmd: string, args: string[]) => {
    if (args[0] === 'ls-remote') return '1111111111111111111111111111111111111111\trefs/heads/main';
    if (args[0] === 'rev-parse') return '2222222222222222222222222222222222222222';
    if (args[0] === 'merge-base' && args[2] === '1111111111111111111111111111111111111111') {
      // remote is ancestor of local
      return '';
    }
    throw new Error('not ancestor');
  };
  assert.deepEqual(checkRemoteHead('/repo', mockLocalAhead), {
    remoteHead: '1111111111111111111111111111111111111111',
    status: 'local-ahead'
  });

  // 4. Remote newer
  const mockRemoteNewer = (_cmd: string, args: string[]) => {
    if (args[0] === 'ls-remote') return '1111111111111111111111111111111111111111\trefs/heads/main';
    if (args[0] === 'rev-parse') return '2222222222222222222222222222222222222222';
    if (args[0] === 'merge-base' && args[2] === '2222222222222222222222222222222222222222') {
      // local is ancestor of remote
      return '';
    }
    throw new Error('not ancestor');
  };
  assert.deepEqual(checkRemoteHead('/repo', mockRemoteNewer), {
    remoteHead: '1111111111111111111111111111111111111111',
    status: 'remote-newer'
  });

  // 5. Diverged
  const mockDiverged = (_cmd: string, args: string[]) => {
    if (args[0] === 'ls-remote') return '1111111111111111111111111111111111111111\trefs/heads/main';
    if (args[0] === 'rev-parse') return '2222222222222222222222222222222222222222';
    throw new Error('diverged');
  };
  assert.deepEqual(checkRemoteHead('/repo', mockDiverged), {
    remoteHead: '1111111111111111111111111111111111111111',
    status: 'diverged'
  });
});
