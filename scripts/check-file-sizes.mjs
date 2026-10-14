// Fails when any source file exceeds the project line limit (500).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const LIMIT = 500;
const roots = ['src', 'tests'];
const offenders = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|mjs|js)$/.test(name)) {
      const lines = readFileSync(p, 'utf8').split('\n').length;
      if (lines > LIMIT) offenders.push(`${p}: ${lines} lines`);
    }
  }
};
for (const r of roots) walk(r);
if (offenders.length) {
  console.error(`Files over ${LIMIT} lines:\n  ` + offenders.join('\n  '));
  process.exit(1);
}
console.log('file sizes OK');
