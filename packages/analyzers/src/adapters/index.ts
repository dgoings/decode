import { listAdapters, registerAdapter, type Adapter } from '../registry.ts';
import { tsAdapter } from './ts.ts';
import { goAdapter } from './go.ts';
import { textAdapter } from './text.ts';

export { tsAdapter, goAdapter, textAdapter };

export const builtinAdapters: Adapter[] = [tsAdapter, goAdapter, textAdapter];

/** Register the built-in adapters once; safe to call repeatedly. */
export function registerBuiltinAdapters(): void {
  const have = new Set(listAdapters());
  for (const a of builtinAdapters) if (!have.has(a)) registerAdapter(a);
}
