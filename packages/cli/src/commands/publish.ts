import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_SINCE, parseSince } from '@codeviz/analyzers';
import { exportSite, MAX_COMPARE_REFS } from '../export.ts';
import {
  DEFAULT_MAX_PAYLOAD_MB,
  estimateDeployPayload,
  findOnPath,
  listParticlesSites,
  particlesHost,
  readParticlesToken,
  refBreakdown,
  shellQuote,
  siteUrl,
  suggestDrops,
} from '../publish.ts';
import { originUrl, repoName } from '../repo.ts';

export const publishUsage =
  'codeviz publish <site-name> [ref...] [--since <v>] [--yes] [--dry-run] [--max-size <MB>] [--out <dir>] [--web-dir <path>]';

const SITE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.on('close', () => resolve(''));
    rl.question(question, (a) => {
      resolve(a);
      rl.close();
    });
  });
}

export async function publishCommand(args: string[]): Promise<number> {
  const positional: string[] = [];
  let since = DEFAULT_SINCE;
  let yes = false;
  let dryRun = false;
  let maxMb = DEFAULT_MAX_PAYLOAD_MB;
  let out: string | undefined;
  let webDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (flag: string): string | undefined => (a === flag ? args[++i] : a.slice(flag.length + 1));
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--since' || a.startsWith('--since=')) {
      const v = value('--since');
      if (!v) return fail('--since needs a value');
      since = v;
    } else if (a === '--max-size' || a.startsWith('--max-size=')) {
      const v = Number(value('--max-size'));
      if (!(v > 0)) return fail('--max-size needs a positive number of MB');
      maxMb = v;
    } else if (a === '--out' || a.startsWith('--out=')) {
      const v = value('--out');
      if (!v) return fail('--out needs a value');
      out = v;
    } else if (a === '--web-dir' || a.startsWith('--web-dir=')) {
      const v = value('--web-dir');
      if (!v) return fail('--web-dir needs a value');
      webDir = v;
    } else if (a.startsWith('-')) return fail(`unknown option ${a}\nusage: ${publishUsage}`, 2);
    else positional.push(a);
  }
  const [name, ...refs] = positional;
  if (!name) return fail(`expected <site-name>\nusage: ${publishUsage}`, 2);
  if (!SITE_NAME.test(name)) return fail(`invalid site name "${name}" (lowercase letters, digits and dashes)`, 2);
  try {
    parseSince(since);
  } catch (err) {
    return fail((err as Error).message);
  }

  const log = (s: string) => console.error(s);
  const dir = out ?? mkdtempSync(path.join(os.tmpdir(), 'codeviz-publish-'));
  let keep = out !== undefined;
  try {
    const root = process.cwd();
    const r = await exportSite({ root, dir, refs, since, webDir, log });
    const payload = estimateDeployPayload(r.dir);
    const limit = maxMb * 1024 * 1024;
    const host = particlesHost();
    const url = siteUrl(host, name);
    const token = readParticlesToken();
    const sites = token ? await listParticlesSites(host, token, log) : null;
    if (!token) log('warning: no Particles token (~/.particles/token); cannot check whether the site exists. Run `particles login`.');
    const existing = sites?.find((s) => s.name === name);

    const origin = originUrl(root);
    const lines = [
      '',
      'codeviz publish: this site will be visible to EVERYONE at Atomic Object.',
      `  repository:  ${repoName(root)}${origin ? `  (${origin})` : ''}`,
      `  site:        ${name}  ->  ${url}`,
      `  refs:        ${r.snapshots.map((s) => `${s.ref} ${s.sha.slice(0, 7)}`).join(', ')}`,
      `  payload:     ${payload.files} files, ${size(payload.base64Bytes)} base64 (${size(payload.bytes)} on disk; limit ${maxMb} MB)`,
    ];
    if (r.pairsSkipped) lines.push(`  note:        more than ${MAX_COMPARE_REFS} refs; compare view not included`);
    if (existing) {
      const when = existing.last_deployed_at ? new Date(existing.last_deployed_at).toLocaleString() : 'an unknown date';
      lines.push(
        `  !!! will OVERWRITE existing site "${name}" deployed by ${existing.deployer ?? 'unknown'} on ${when} (${size(Number(existing.size_bytes) || 0)})`,
        `      (Particles refuses names owned by someone else; codeviz never passes --force)`,
      );
    } else if (sites) lines.push(`  site status: new (no site named "${name}" exists yet)`);
    else lines.push('  site status: unknown (could not list Particles sites)');
    console.log(lines.join('\n'));

    if (payload.base64Bytes > limit) {
      const refList = r.snapshots.map((s) => ({ sha: s.sha, ref: s.ref }));
      const { shared, perRef } = refBreakdown(payload, refList);
      const rows = [
        `codeviz publish: payload ${size(payload.base64Bytes)} exceeds the ${maxMb} MB limit (base64; Particles deploys in one POST).`,
        `  web UI + index:  ${size(shared)}`,
        ...perRef.map((p) => `  ${`${p.ref} ${p.sha.slice(0, 7)}`.padEnd(24)} snapshot ${size(p.snapshot).padStart(9)}   compare ${size(p.compare).padStart(9)}`),
      ];
      const drops = suggestDrops(payload, refList, limit);
      if (drops === null) rows.push('  even a single ref does not fit; raise --max-size if the server accepts it');
      else rows.push(`  suggestion: drop ${drops.join(', ')}`);
      console.error(rows.join('\n'));
      return 1;
    }

    const particles = findOnPath('particles');
    const cmd = `particles deploy ${shellQuote(r.dir)} --name=${name}`;
    if (dryRun) {
      console.log(`\ndry run: nothing deployed. Command:\n  ${cmd}`);
      if (!keep) console.log('  (the export is a temp dir that is now removed; pass --out <dir> to keep it)');
      return 0;
    }

    if (!yes) {
      if (!process.stdin.isTTY) {
        console.error('codeviz publish: aborted: not a terminal; pass --yes to publish non-interactively');
        return 1;
      }
      const answer = await ask(`Publish ${repoName(root)} to ${url}? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.error('codeviz publish: aborted');
        return 1;
      }
    }

    if (!particles) {
      keep = true;
      console.log(`\nThe particles CLI is not on PATH. To deploy, run:\n  ${cmd}`);
      return 0;
    }
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = spawn(particles, ['deploy', r.dir, `--name=${name}`], { stdio: ['inherit', 'pipe', 'inherit'] });
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        process.stdout.write(d);
      });
      child.on('error', (err) => {
        console.error(`codeviz publish: could not run particles: ${err.message}`);
        resolve({ code: 1, stdout: buf });
      });
      child.on('close', (c) => resolve({ code: c ?? 1, stdout: buf }));
    });
    if (code !== 0) {
      console.error(`codeviz publish: particles deploy exited with ${code}`);
      return code;
    }
    const deployed = /(https?:\/\/\S+)/.exec(stdout.split('\n').find((l) => l.includes('→')) ?? '')?.[1] ?? url;
    console.log(`codeviz publish: published ${deployed}`);
    return 0;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

function fail(msg: string, code = 1): number {
  console.error(`codeviz publish: ${msg}`);
  return code;
}
