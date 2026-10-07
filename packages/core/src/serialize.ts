import { gunzipSync, gzipSync } from 'node:zlib';
import type { Snapshot } from './snapshot.ts';

export function encodeSnapshot(s: Snapshot): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(s)));
}

export function decodeSnapshot(buf: Buffer): Snapshot {
  return JSON.parse(gunzipSync(buf).toString('utf8')) as Snapshot;
}
