import { listAdapters, registerAdapter, type Adapter } from '../registry.ts';
import { tsAdapter } from './ts.ts';

export { tsAdapter };

export const builtinAdapters: Adapter[] = [tsAdapter];

/** Register the built-in adapters once; safe to call repeatedly. */
export function registerBuiltinAdapters(): void {
  const have = new Set(listAdapters());
  for (const a of builtinAdapters) if (!have.has(a)) registerAdapter(a);
}
