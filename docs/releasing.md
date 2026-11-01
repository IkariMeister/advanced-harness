# Releasing

A lightweight, manual release process (BH-044, issue #116). Release automation
(release-please, changesets, npm publish) and routine patch releases are out of
scope and tracked in #52 (BH-031).

## Versions

| Where | `package.json` version | Example |
| --- | --- | --- |
| A release tag `vX.Y.Z` | `X.Y.Z` | `v0.2.0` → `0.2.0` |
| `main` between releases | next minor with `-dev` | `0.2.0-dev` until `v0.2.0`, then `0.3.0-dev` |
| A `release/X.Y` patch branch | the patch being prepared | `0.2.1` |

- `package.json` and `package-lock.json` always carry the same version.
- `-dev` versions are never tagged. CI fails a `v*` tag whose name does not match
  both files (`node scripts/check-release-version.ts vX.Y.Z` runs the same check
  locally).
- Install, update and doctor print the version with the commit, e.g.
  `0.2.0-dev (<sha>)`. The commit is authoritative: update compares installed and
  source commits, not version strings.
- Agent and command files carry their own `schemaVersion` for their file format.
  It is unrelated to the release version.

## Running from a release tag

Projects that use the harness (for example the MarsRoverIA pilot) run a checkout
pinned to a release tag, not `main`:

```bash
git fetch --tags origin
git checkout v0.2.0
npm ci
```

On a release-tag checkout, `harness:update` compares with the newest remote `v*`
release tag (`git ls-remote --tags origin 'v*'`) and reports e.g.
`v0.2.1 is available`. It never offers unreleased `main` commits. On any other
checkout it compares with `origin/main`. `harness:doctor` prints the checkout
version and whether it is on a release tag, without network access. Neither
command changes the checkout; they print the `git` commands to run.

Day-to-day harness development stays in worktrees on `main`, with the `-dev`
version.

## Keeping `main` taggable

`main` should be releasable when a milestone closes:

- Merge unfinished features behind a gate (as Codex install is gated by #45), or
  keep them as an unmerged PR stack until complete.
- Fixes merge to `main` first.

## Release checklist

Run when a milestone closes. Steps marked **human** need explicit maintainer
approval; an agent prepares them but never tags, publishes, merges or changes
repository settings on its own (see `AGENTS.md`).

1. **Confirm the milestone.** Every issue in the milestone is closed or moved;
   CI is green on `main`.
2. **Upgrade check from the previous release** (see below). It must pass before
   tagging.
3. **Release PR** from `main` that:
   - sets `package.json` and `package-lock.json` to the release version
     (`npm version 0.2.0 --no-git-tag-version`);
   - moves the `CHANGELOG.md` Unreleased entries under a new `vX.Y.Z` heading,
     built from the milestone's merged PRs;
   - updates the `SECURITY.md` supported-versions table to the new line (e.g.
     `0.2.x`) and states what happens to the previous line (e.g. "`0.1.x`:
     upgrade to `0.2.x`; no backports promised").
4. **Merge the release PR** (**human**).
5. **Tag and push** the merge commit (**human**):
   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```
   CI checks that the tag matches `package.json`. If it fails, delete the remote
   tag before anyone uses it, fix, and tag again.
6. **Publish the GitHub release** from the tag, using the changelog entry as
   notes (**human**).
7. **Bump `main` to the next `-dev` version** in a PR
   (`npm version 0.3.0-dev --no-git-tag-version`) and add an empty Unreleased
   section to `CHANGELOG.md`.

### Upgrade check

v0.2.0 and later change receipts, per-role models and guardrails, so check that
an install made by the previous release updates cleanly. Use a disposable project
and recovery directory; do not use a real project or your own host config.

```bash
git worktree add ../harness-previous v0.1.0
git worktree add ../harness-candidate main   # or the release PR branch
```

1. From `../harness-previous`: `npm ci`, then `npm run harness:install` into the
   disposable project. Make a small user edit to an installed file you are
   allowed to customize (a role model or a custom field).
2. From `../harness-candidate`: `npm ci`, then `npm run harness:doctor` and
   `npm run harness:update` against the same project.
3. Confirm: update reports the installed stamp as the previous release, receipts
   chain from the previous install without conflicts, managed files update, the
   user edit and project context (`AGENTS.md`) are preserved, and doctor passes.
4. Record the result (pass/fail, hosts covered, who ran it) on the milestone's
   release issue. `harness:install` and `harness:update` prompt interactively; if
   no TTY is available, the check is run and reported by a human (see
   `AGENTS.md`).
5. Remove the worktrees: `git worktree remove ../harness-previous` and
   `git worktree remove ../harness-candidate`.

## Patch releases (manual, until #52)

Bug fixes ship in the next milestone release by default. When a released version
needs a fix sooner:

1. Merge the fix to `main` first.
2. Create `release/X.Y` from the `vX.Y.0` tag, only the first time it is needed:
   ```bash
   git switch -c release/0.2 v0.2.0
   git push -u origin release/0.2
   ```
3. Open a PR into `release/X.Y` that cherry-picks the fix (`git cherry-pick -x`),
   bumps to the patch version (`0.2.1`) and adds a `CHANGELOG.md` entry. CI runs
   on `release/**` branches and PRs into them.
4. After the **human** merge, tag `vX.Y.Z` on `release/X.Y` and publish the
   release (**human**), as in steps 5–6 above. Add the patch entry to the
   changelog on `main` too.

## Repository settings (human)

Not part of any code change; a maintainer configures and confirms them:

- On the `main` ruleset, require the status checks
  `Validate (Ubuntu / Node 24)`, `Smoke (ubuntu-latest / Node 24)` and
  `Smoke (windows-latest / Node 24)`, plus one approval.
- Apply the same rules to `release/**`.
- Keep the ruleset bypass for emergencies only.
