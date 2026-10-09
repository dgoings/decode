// Minimal Chrome DevTools Protocol client over Node's global WebSocket, used by `trace browser --attach`
// (no Playwright needed to attach to a Chrome started with --remote-debugging-port).

export interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, fn: (params: any) => void): void; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Resolves when the target or socket goes away. */
  closed: Promise<void>;
  close(): Promise<void>;
}

interface TargetInfo {
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

/** Attach to a page target of a Chrome debug port. Prefers a page whose URL starts with `urlPrefix`. */
export async function attachToPage(port: number, urlPrefix?: string): Promise<{ session: CdpSession; url: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`).catch((err: Error) => {
    throw new Error(`cannot reach Chrome on port ${port} (start it with --remote-debugging-port=${port}): ${err.message}`);
  });
  const targets = ((await res.json()) as TargetInfo[]).filter(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://'),
  );
  const target = (urlPrefix ? targets.find((t) => t.url.startsWith(urlPrefix)) : undefined) ?? targets[0];
  if (!target) throw new Error(`no page targets on port ${port}`);
  return { session: await connect(target.webSocketDebuggerUrl!), url: target.url };
}

function connect(wsUrl: string): Promise<CdpSession> {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error('this Node has no global WebSocket (need Node 22+)');
  const ws = new WS(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, ((p: unknown) => void)[]>();
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((r) => (markClosed = r));

  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    if (process.env.CODEVIZ_TRACE_DEBUG) console.error(`cdp < ${msg.id ?? msg.method}${msg.error ? ' ' + msg.error.message : ''}`);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
      if (msg.method === 'Inspector.detached' || msg.method === 'Inspector.targetCrashed') markClosed();
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP connection closed'));
    pending.clear();
    markClosed();
  });

  const session: CdpSession = {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 10_000);
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        if (process.env.CODEVIZ_TRACE_DEBUG) console.error(`cdp > ${id} ${method}`);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    closed,
    async close() {
      ws.close();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
    },
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(session), { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot open ${wsUrl}`)), { once: true });
  });
}
