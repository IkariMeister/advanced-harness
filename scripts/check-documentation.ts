import { checkDocumentation } from '../src/documentation-check.ts';
const errors = checkDocumentation();
if (errors.length) {
  for (const error of errors) console.error(`${error.file}:${error.line}: ${error.message}`);
  process.exitCode = 1;
} else console.log('Documentation checks passed.');
