import { describe, expect, test } from 'bun:test';
import { compileGlob, detectEntryPoints, impactedScreens, implicitEdges, mdEscape, specificScreens, type EdgeEntry } from './index.ts';

const imp = (from: string, to: string): EdgeEntry => ({ from, to, kind: 'import', level: 'file' });

describe('detectEntryPoints', () => {
  test('next pages router', () => {
    const e = detectEntryPoints([
      'src/pages/index.tsx',
      'src/pages/users/[id].tsx',
      'src/pages/docs/[...slug].tsx',
      'src/pages/_app.tsx',
      'src/pages/api/hello.ts',
      'src/pages/about.test.tsx',
    ]);
    expect(e.map((x) => x.route)).toEqual(['/', '/docs/*', '/users/:id']);
  });

  test('next app router drops groups and slots', () => {
    const e = detectEntryPoints([
      'app/page.tsx',
      'app/(shop)/cart/page.tsx',
      'app/blog/[slug]/page.tsx',
      'app/@modal/login/page.tsx',
      'app/layout.tsx',
    ]);
    expect(e.map((x) => [x.path, x.route])).toEqual([
      ['app/page.tsx', '/'],
      ['app/blog/[slug]/page.tsx', '/blog/:slug'],
      ['app/(shop)/cart/page.tsx', '/cart'],
      ['app/@modal/login/page.tsx', '/login'],
    ]);
  });

  test('remix-style routes', () => {
    const e = detectEntryPoints([
      'app/routes/_index.tsx',
      'app/routes/users.$id.tsx',
      'app/routes/files.$.tsx',
      'app/routes/settings/index.tsx',
      'app/routes/_auth.login.tsx',
    ]);
    expect(e.map((x) => x.route).sort()).toEqual(['/', '/files/*', '/login', '/settings', '/users/:id']);
  });

  test('tanstack routes: __root is a layout, trailing underscores are layout escapes', () => {
    const paths = ['src/routes/__root.tsx', 'src/routes/index.tsx', 'src/routes/admin/sessions/$sessionId_.preview.tsx', 'src/routes/admin/settings.tsx'];
    const e = detectEntryPoints(paths);
    expect(e.map((x) => x.route)).toEqual(['/', '/admin/sessions/:sessionId/preview', '/admin/settings']);
    const edges = implicitEdges(paths, e).map((x) => `${x.from}>${x.to}`);
    expect(edges).toContain('src/routes/admin/settings.tsx>src/routes/__root.tsx');
    expect(edges).toHaveLength(3);
  });

  test('non-JSX files under routes/ or pages/ are not screens (server handlers are .ts)', () => {
    const e = detectEntryPoints(['server/routes/users.ts', 'src/routes/data.ts', 'src/pages/Home.js', 'src/pages/Home.tsx', 'app/(x)/pages/y/page.tsx']);
    expect(e.map((x) => [x.path, x.route])).toEqual([['src/pages/Home.tsx', '/Home'], ['app/(x)/pages/y/page.tsx', '/pages/y']]);
  });

  test('screens under directories named services, api or server are still screens', () => {
    const e = detectEntryPoints(['app/(marketing)/services/page.tsx', 'src/pages/services/index.tsx', 'apps/web/pages/index.tsx']);
    expect(e.map((x) => x.route)).toEqual(['/', '/services', '/services']);
  });

  test('pages/ and routes/ only count at a project root, not as nested folder names', () => {
    const e = detectEntryPoints(['src/components/pages/Home.tsx', 'src/features/routes/Table.tsx', 'lib/pages/x.tsx', 'src/pages/Real.tsx', 'apps/web/src/routes/ok.tsx']);
    expect(e.map((x) => x.path)).toEqual(['src/pages/Real.tsx', 'apps/web/src/routes/ok.tsx']);
  });

  test('folder-style route files (route.tsx) are the route itself', () => {
    const e = detectEntryPoints(['src/routes/users/$id/route.tsx', 'src/routes/users.$id.settings/route.tsx']);
    expect(e.map((x) => x.route)).toEqual(['/users/:id', '/users/:id/settings']);
  });

  test('pathless layout routes are not screens', () => {
    const e = detectEntryPoints(['src/routes/_auth.tsx', 'src/routes/_auth.login.tsx', 'src/routes/_index.tsx', 'src/routes/admin/_layout.tsx']);
    expect(e.map((x) => x.route)).toEqual(['/', '/login']);
  });

  test('overrides win and use the file path as route', () => {
    const e = detectEntryPoints(['src/screens/Home.tsx', 'src/screens/util/x.ts', 'src/lib/a.ts'], ['src/screens/*.tsx']);
    expect(e).toEqual([{ path: 'src/screens/Home.tsx', route: 'src/screens/Home.tsx' }]);
  });
});

describe('compileGlob', () => {
  test('* stays in a segment, ** crosses, **/ is any number of directories', () => {
    expect(compileGlob('src/*.tsx').test('src/a.tsx')).toBe(true);
    expect(compileGlob('src/*.tsx').test('src/x/a.tsx')).toBe(false);
    expect(compileGlob('src/**/*.tsx').test('src/a.tsx')).toBe(true);
    expect(compileGlob('src/**/*.tsx').test('src/x/y/a.tsx')).toBe(true);
    expect(compileGlob('src/**').test('src/x/y/a.tsx')).toBe(true);
    expect(compileGlob('a?c').test('abc')).toBe(true);
    expect(compileGlob('a?c').test('a/c')).toBe(false);
    expect(compileGlob('a.b').test('aXb')).toBe(false);
    expect(compileGlob('**/a/**/b').test('x/a/y/b')).toBe(true);
  });

  test('rejects overlong patterns, and many wildcards cannot make matching slow', () => {
    expect(() => compileGlob('a'.repeat(201))).toThrow('too long');
    const hostile = compileGlob('*a'.repeat(60) + 'b');
    const t0 = performance.now();
    expect(hostile.test('a'.repeat(120))).toBe(false);
    expect(compileGlob('**/'.repeat(30) + 'x').test('a/'.repeat(60) + 'y')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('implicitEdges', () => {
  test('layouts wrap pages below them; _app wraps pages', () => {
    const paths = ['app/layout.tsx', 'app/shop/layout.tsx', 'app/shop/cart/page.tsx', 'app/page.tsx', 'pages/_app.tsx', 'pages/a.tsx'];
    const entries = detectEntryPoints(paths);
    const edges = implicitEdges(paths, entries).map((e) => `${e.from}>${e.to}`).sort();
    expect(edges).toEqual([
      'app/page.tsx>app/layout.tsx',
      'app/shop/cart/page.tsx>app/layout.tsx',
      'app/shop/cart/page.tsx>app/shop/layout.tsx',
      'pages/a.tsx>pages/_app.tsx',
    ]);
  });
});

describe('impactedScreens', () => {
  const entries = [
    { path: 'pages/a.tsx', route: '/a' },
    { path: 'pages/b.tsx', route: '/b' },
    { path: 'pages/c.tsx', route: '/c' },
  ];
  const edges = [
    imp('pages/a.tsx', 'ui/Save.tsx'),
    imp('ui/Save.tsx', 'lib/api.ts'),
    imp('pages/b.tsx', 'lib/api.ts'),
    imp('pages/c.tsx', 'ui/Other.tsx'),
  ];

  test('finds screens, chains and hop counts, nearest first', () => {
    const r = impactedScreens(edges, ['lib/api.ts', 'ui/Save.tsx'], entries);
    expect(r.screens.map((s) => s.entry.route)).toEqual(['/a', '/b']);
    const a = r.screens[0]!;
    expect(a.reached.map((x) => [x.file, x.hops])).toEqual([['ui/Save.tsx', 1], ['lib/api.ts', 2]]);
    expect(a.reached[1]!.chain).toEqual(['pages/a.tsx', 'ui/Save.tsx', 'lib/api.ts']);
    expect(r.screens[1]!.reached[0]!.chain).toEqual(['pages/b.tsx', 'lib/api.ts']);
  });

  test('a changed screen file is hops 0', () => {
    const r = impactedScreens(edges, ['pages/c.tsx'], entries);
    expect(r.screens).toHaveLength(1);
    expect(r.screens[0]!.reached[0]).toMatchObject({ file: 'pages/c.tsx', hops: 0, chain: ['pages/c.tsx'] });
  });

  test('files no screen reaches are listed, module-level edges are ignored', () => {
    const r = impactedScreens([...edges, { from: 'pages/c.tsx', to: 'lib', kind: 'import', level: 'module' }], ['x.ts', 'lib'], entries);
    expect(r.screens).toEqual([]);
    expect(r.unreached).toEqual(['lib', 'x.ts']);
  });

  test('widespread files are shared and rank below screen-specific changes', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ path: `pages/p${i}.tsx`, route: `/p${i}` }));
    const e = [...many.map((m) => imp(m.path, 'ui/Button.tsx')), imp('pages/p5.tsx', 'ui/Special.tsx')];
    const r = impactedScreens(e, ['ui/Button.tsx', 'ui/Special.tsx'], many);
    expect(r.shared).toEqual([{ file: 'ui/Button.tsx', screens: 6 }]);
    expect(r.screens[0]!.entry.route).toBe('/p5');
    expect(r.screens[0]!.nearest).toBe(1);
    expect(r.screens[1]!.nearest).toBeNull();
    expect(r.screens[1]!.reached[0]!.shared).toBe(true);
    // Only /p5 has its own reason to be listed; the rest are covered by the shared entry.
    expect(specificScreens(r).map((s) => s.entry.route)).toEqual(['/p5']);
  });

  test('a screen does not reach through another screen (router manifests import every route)', () => {
    const e = [
      imp('pages/a.tsx', 'router.tsx'),
      imp('router.tsx', 'routeTree.gen.ts'),
      imp('routeTree.gen.ts', 'pages/b.tsx'),
      imp('pages/b.tsx', 'ui/OnlyB.tsx'),
    ];
    const r = impactedScreens(e, ['ui/OnlyB.tsx', 'pages/b.tsx'], entries);
    expect(r.screens.map((s) => s.entry.route)).toEqual(['/b']);
    expect(r.screens[0]!.reached.map((x) => x.file)).toEqual(['pages/b.tsx', 'ui/OnlyB.tsx']);
  });

  test('in a small app a file reaching every screen is shared; one reaching only some is not', () => {
    const three = [{ path: 'p/a.tsx', route: '/a' }, { path: 'p/b.tsx', route: '/b' }, { path: 'p/c.tsx', route: '/c' }];
    const e = [...three.map((x) => imp(x.path, 'ui/Nav.tsx')), imp('p/a.tsx', 'ui/OnlyA.tsx')];
    const r = impactedScreens(e, ['ui/Nav.tsx', 'ui/OnlyA.tsx'], three);
    expect(r.shared).toEqual([{ file: 'ui/Nav.tsx', screens: 3 }]);
    expect(specificScreens(r).map((s) => s.entry.route)).toEqual(['/a']);
  });

  test('cycles terminate', () => {
    const r = impactedScreens([imp('pages/a.tsx', 'x.ts'), imp('x.ts', 'y.ts'), imp('y.ts', 'x.ts')], ['y.ts'], entries);
    expect(r.screens[0]!.reached[0]!.chain).toEqual(['pages/a.tsx', 'x.ts', 'y.ts']);
  });
});

describe('mdEscape', () => {
  test('escapes markdown syntax in prose but keeps code spans, and flattens newlines', () => {
    expect(mdEscape('Click “Save *all* [x](http://e)” in `a_b*c`')).toBe('Click “Save \\*all\\* \\[x\\](http://e)” in `a_b*c`');
    expect(mdEscape('two\nlines <b>')).toBe('two lines \\<b\\>');
  });
});
