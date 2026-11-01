import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkReleaseTagVersion } from '../src/harness-version.ts';

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag || process.argv.includes('--help')) {
  console.log('Usage: node scripts/check-release-version.ts <vX.Y.Z>');
  console.log('Fails when the release tag does not match package.json and package-lock.json versions. Reads files only.');
  process.exitCode = tag ? 0 : 2;
} else {
  const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  const lockVersion = lock.packages?.['']?.version === lock.version ? lock.version : undefined;
  const errors = checkReleaseTagVersion(tag, pkg.version, lockVersion);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Release tag ${tag} matches package.json and package-lock.json.`);
  }
}
