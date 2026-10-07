import { version } from './version.ts';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(version);
} else {
  console.log(`codeviz ${version}\nUsage: codeviz --version`);
}
