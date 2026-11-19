import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'build.py');
const args = process.argv.slice(2);

const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
let result = null;
for (const bin of candidates) {
  result = spawnSync(bin, [script, ...args], { stdio: 'inherit' });
  if (!result.error) break;
}

if (!result || result.error) {
  console.error('Failed to invoke Python 3 for tools/cards/build.py:', result?.error?.message || 'python not found');
  process.exit(1);
}
process.exit(result.status ?? 1);
