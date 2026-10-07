import { analyzeCommand, analyzeUsage } from './commands/analyze.ts';
import { compareCommand, compareUsage } from './commands/compare.ts';
import { serveCommand, serveUsage } from './commands/serve.ts';
import { version } from './version.ts';

const usage = `codeviz ${version}

Usage:
  ${analyzeUsage}
  ${compareUsage}
  ${serveUsage}
  codeviz help
  codeviz --version`;

const commands: Record<string, (args: string[]) => Promise<number>> = {
  analyze: analyzeCommand,
  compare: compareCommand,
  serve: serveCommand,
  help: async () => {
    console.log(usage);
    return 0;
  },
};

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') {
    console.log(version);
    return 0;
  }
  if (cmd === undefined || cmd === '--help' || cmd === '-h') return commands.help!([]);
  const run = commands[cmd];
  if (!run) {
    console.error(`codeviz: unknown command "${cmd}"\n\n${usage}`);
    return 2;
  }
  return run(rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  },
);
