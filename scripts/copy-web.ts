// Dev script: copy the built web UI next to the cli bundle (dist/web).
import { cpSync, existsSync, rmSync } from 'node:fs';

const from = 'packages/web/dist';
const to = 'dist/web';
if (!existsSync(`${from}/index.html`)) {
  console.error(`copy-web: ${from}/index.html missing; run build:web first`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`copy-web: ${from} -> ${to}`);
