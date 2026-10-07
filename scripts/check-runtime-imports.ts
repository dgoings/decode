// Dev script: fails if runtime packages use Bun.* or bun:* modules.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['core', 'analyzers', 'cli'].map((p) => join('packages', p, 'src'));
const pattern = /\bBun\.|["']bun:/;
const bad: string[] = [];

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) {
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (pattern.test(line)) bad.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
  }
}

roots.forEach(walk);
if (bad.length) {
  console.error('Bun-specific APIs found in runtime code:\n' + bad.join('\n'));
  process.exit(1);
}
console.log('check: no Bun.* / bun: usage in runtime packages');
