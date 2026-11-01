import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSourceVersion, checkRemoteHead, compareInstalledAndSource, toVersionStamp, formatVersionStamp, parseReleaseVersion, compareReleaseVersions, detectReleaseTag, checkRemoteReleaseTag, describeHarnessCheckout, checkReleaseTagVersion } from '../src/harness-version.ts';

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
    const error = new Error('diverged') as Error & { status: number };
    error.status = 1;
    throw error;
  };
  assert.deepEqual(checkRemoteHead('/repo', mockDiverged), {
    remoteHead: '1111111111111111111111111111111111111111',
    status: 'diverged'
  });
});

test('checkRemoteHead reports inconclusive when remote object is absent locally', () => {
  const runner = (_cmd: string, args: string[]) => {
    if (args[0] === 'ls-remote') return 'ffffffffffffffffffffffffffffffffffffffff\trefs/heads/main';
    if (args[0] === 'rev-parse') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const error = new Error('fatal: bad object ffffffffffffffffffffffffffffffffffffffff') as Error & { status: number };
    error.status = 128;
    throw error;
  };
  assert.deepEqual(checkRemoteHead('/repo', runner), {
    remoteHead: 'ffffffffffffffffffffffffffffffffffffffff',
    status: 'inconclusive'
  });
});

test('toVersionStamp omits dirty for clean checkouts and keeps it for dirty ones; formatVersionStamp mirrors the stamp', () => {
  const clean = toVersionStamp({ version: '0.1.0', commit: 'a'.repeat(40), dirty: false });
  assert.deepEqual(clean, { version: '0.1.0', commit: 'a'.repeat(40) });
  assert.equal('dirty' in clean, false);
  const dirty = toVersionStamp({ version: '0.1.0', commit: 'a'.repeat(40), dirty: true });
  assert.deepEqual(dirty, { version: '0.1.0', commit: 'a'.repeat(40), dirty: true });
  assert.equal(formatVersionStamp(clean), `0.1.0 (${'a'.repeat(40)})`);
  assert.equal(formatVersionStamp(dirty), `0.1.0 (${'a'.repeat(40)}) [dirty local changes]`);
});

const sha = (c: string) => c.repeat(40);

test('-dev versions format as-is and the commit stays authoritative for comparison', () => {
  const stamp = toVersionStamp({ version: '0.2.0-dev', commit: sha('a'), dirty: false });
  assert.equal(formatVersionStamp(stamp), `0.2.0-dev (${sha('a')})`);
  assert.equal(compareInstalledAndSource({ version: '0.1.0', commit: sha('a') }, { version: '0.2.0-dev', commit: sha('a'), dirty: false }), 'up-to-date');
  assert.equal(compareInstalledAndSource({ version: '0.2.0-dev', commit: sha('a') }, { version: '0.2.0-dev', commit: sha('b'), dirty: false }), 'source-newer');
});

test('main carries a -dev or release version in package.json and package-lock.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { version: string; packages: Record<string, { version: string }> };
  assert.ok(parseReleaseVersion(pkg.version), `unexpected version ${pkg.version}`);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages['']?.version, pkg.version);
});

test('parseReleaseVersion and compareReleaseVersions order releases numerically with prereleases first', () => {
  assert.deepEqual(parseReleaseVersion('v0.10.2'), { major: 0, minor: 10, patch: 2 });
  assert.deepEqual(parseReleaseVersion('0.3.0-dev'), { major: 0, minor: 3, patch: 0, prerelease: 'dev' });
  assert.equal(parseReleaseVersion('v1.2'), undefined);
  assert.equal(parseReleaseVersion('release-1'), undefined);
  const v = (text: string) => parseReleaseVersion(text)!;
  assert.equal(compareReleaseVersions(v('v0.10.0'), v('v0.9.9')), 1);
  assert.equal(compareReleaseVersions(v('0.3.0-dev'), v('0.3.0')), -1);
  assert.equal(compareReleaseVersions(v('0.2.1'), v('v0.2.1')), 0);
});

test('detectReleaseTag returns the newest release tag at HEAD and ignores prerelease or non-v tags', () => {
  const runner = (tags: string) => (_cmd: string, args: string[]) => {
    assert.deepEqual(args, ['tag', '--points-at', 'HEAD', '--list', 'v*']);
    return tags;
  };
  assert.equal(detectReleaseTag('/repo', runner('')), undefined);
  assert.equal(detectReleaseTag('/repo', runner('v0.2.0\nv0.2.0-rc.1\nvnext')), 'v0.2.0');
  assert.equal(detectReleaseTag('/repo', runner('v0.3.0-dev')), undefined);
  assert.equal(detectReleaseTag('/repo', runner('v0.2.0\r\nv0.2.1')), 'v0.2.1');
  assert.equal(detectReleaseTag('/repo', () => { throw new Error('not a git repo'); }), undefined);
});

test('checkRemoteReleaseTag compares with the newest remote release tag and never with main', () => {
  const calls: string[][] = [];
  const remote = [
    `${sha('1')}\trefs/tags/v0.1.0`,
    `${sha('2')}\trefs/tags/v0.2.0`,
    `${sha('3')}\trefs/tags/v0.2.0^{}`,
    `${sha('4')}\trefs/tags/v0.10.0-rc.1`,
    `${sha('5')}\trefs/tags/v0.2.1`,
    `${sha('6')}\trefs/tags/vnext`
  ].join('\n');
  const runner = (_cmd: string, args: string[]) => { calls.push(args); return remote; };
  assert.deepEqual(checkRemoteReleaseTag('/repo', 'v0.2.0', runner), { currentTag: 'v0.2.0', latestTag: 'v0.2.1', status: 'release-available' });
  assert.deepEqual(checkRemoteReleaseTag('/repo', 'v0.2.1', runner), { currentTag: 'v0.2.1', latestTag: 'v0.2.1', status: 'up-to-date' });
  assert.ok(calls.every(args => args.join(' ') === 'ls-remote --tags origin v*'));
  assert.ok(!calls.some(args => args.includes('refs/heads/main')));

  assert.deepEqual(checkRemoteReleaseTag('/repo', 'v0.2.0', () => { throw new Error('offline'); }), { currentTag: 'v0.2.0', status: 'inconclusive' });
  assert.deepEqual(checkRemoteReleaseTag('/repo', 'v0.2.0', () => ''), { currentTag: 'v0.2.0', status: 'inconclusive' });
});

test('describeHarnessCheckout labels release-tag and development checkouts', () => {
  const runner = (tags: string) => (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return sha('a');
    if (args[0] === 'status') return '';
    if (args[0] === 'tag') return tags;
    return '';
  };
  assert.ok(describeHarnessCheckout(process.cwd(), runner('v0.2.0')).endsWith(`(${sha('a')}) [release tag v0.2.0]`));
  assert.ok(describeHarnessCheckout(process.cwd(), runner('')).endsWith(`(${sha('a')}) [development checkout]`));
});

test('checkReleaseTagVersion fails when the tag and package versions disagree', () => {
  assert.deepEqual(checkReleaseTagVersion('v0.2.0', '0.2.0', '0.2.0'), []);
  assert.equal(checkReleaseTagVersion('v0.2.0', '0.2.0-dev', '0.2.0').length, 1);
  assert.equal(checkReleaseTagVersion('v0.2.0', '0.2.0', undefined).length, 1);
  assert.equal(checkReleaseTagVersion('v0.2.0', '0.1.0', '0.1.0').length, 2);
  assert.match(checkReleaseTagVersion('v0.3.0-dev', '0.3.0-dev', '0.3.0-dev')[0] ?? '', /-dev versions are for main/);
  assert.match(checkReleaseTagVersion('0.2.0', '0.2.0', '0.2.0')[0] ?? '', /not a vX\.Y\.Z release tag/);
});
