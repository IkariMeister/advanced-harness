import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './protocol.ts';

/**
 * Small-fixture snapshotter for the prototype: all files, including untracked files.
 * Android integration must supply an explicit input manifest, excluding build outputs
 * while including build configuration and toolchain inputs. Symlinks fail closed here.
 */
export function snapshotDirectory(directory: string): string {
  const root = realpathSync(directory);
  const hash = createHash('sha256');
  function walk(path: string, prefix: string): void {
    for (const name of readdirSync(path).sort()) {
      requireThat(name !== '.git', 'Use a fixture directory, not a Git checkout, with this snapshotter');
      const full = join(path, name);
      const relative = `${prefix}${name}`;
      const info = lstatSync(full);
      requireThat(!info.isSymbolicLink(), 'Snapshot does not follow symlinks');
      if (info.isDirectory()) {
        hash.update(JSON.stringify(['directory', relative]));
        walk(full, `${relative}/`);
      } else {
        requireThat(info.isFile(), 'Unsupported snapshot entry');
        const content = readFileSync(full);
        hash.update(JSON.stringify(['file', relative, info.mode & 0o111, content.length]));
        hash.update(content);
      }
    }
  }
  walk(root, '');
  return hash.digest('hex');
}
