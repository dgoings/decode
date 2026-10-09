// `codeviz trace collect`: receive NDJSON posts from harness/bun-trace.ts and write a trace file.
import { createServer } from 'node:http';
import { createTraceWriter, isTraceHeader, type TraceTick } from './format.ts';

export const DEFAULT_COLLECTOR_PORT = 7357;

export interface CollectOptions {
  port: number;
  out: string;
  durationS?: number;
  log: (s: string) => void;
}

export interface CollectSummary {
  ticks: number;
  files: Set<string>;
  edges: number;
}

export async function runCollector(o: CollectOptions): Promise<CollectSummary> {
  const writer = createTraceWriter(o.out);
  const summary: CollectSummary = { ticks: 0, files: new Set(), edges: 0 };
  let headerWritten = false;
  const pending: TraceTick[] = [];

  const accept = (line: string) => {
    const rec = JSON.parse(line) as unknown;
    if (isTraceHeader(rec)) {
      if (headerWritten) return;
      writer.write(rec);
      headerWritten = true;
      for (const t of pending.splice(0)) accept(JSON.stringify(t));
      return;
    }
    const tick = rec as TraceTick;
    if (typeof tick?.t !== 'number' || !Array.isArray(tick.files)) return;
    if (!headerWritten) {
      pending.push(tick);
      return;
    }
    writer.write(tick);
    summary.ticks++;
    summary.edges += tick.edges?.length ?? 0;
    for (const [p] of tick.files) summary.files.add(p);
  };

  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`codeviz trace collector: ${summary.ticks} ticks\n`);
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      try {
        for (const l of body.split('\n')) if (l.trim()) accept(l);
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end((err as Error).message);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => resolve());
  });
  o.log(`collecting on http://127.0.0.1:${o.port}/trace -> ${o.out} (Ctrl-C to finish)`);

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    if (o.durationS) setTimeout(done, o.durationS * 1000).unref();
  });
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await closed;
  await writer.close();
  return summary;
}
