// Plain-language wording for steps. Pure string functions; no I/O.

/** `TagsSettingsSection` -> `tags settings section`, `handleAddTag` -> `add tag`, `on_rename` -> `rename`. */
export function humanize(id: string): string {
  const words = id
    .replace(/\?\./g, '.')
    .split('.')
    .pop()!
    .replace(/^(?:handle|on|use)(?=[A-Z_])/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words || id.toLowerCase();
}

export const sentence = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** A component or file name as a heading: `TagsSettingsSection` -> `Tags settings section`. */
export function areaName(id: string): string {
  return sentence(humanize(id));
}

const plural = (noun: string): boolean => /[^s]s$/.test(noun) && !/(status|address|class|access)$/.test(noun);
const be = (noun: string): string => (plural(noun) ? 'are' : 'is');
const have = (noun: string): string => (plural(noun) ? 'have' : 'has');

/** What a render condition means to a person, in both directions. */
export interface ConditionPhrase {
  /** The state the condition describes when it is true: `the tags are still loading`. */
  pos: string;
  /** The state when it is false: `the tags have loaded`. */
  neg: string;
  /** How to put the app in the `pos` / `neg` state when that takes some doing. */
  how?: { pos?: string; neg?: string };
}

export interface ConditionContext {
  /** `x` comes from a data-fetching hook (`useQuery`, `useSWR`...), so `x === undefined` means still loading. */
  isQuery(name: string): boolean;
}

/** Drop parentheses that wrap the whole expression: `(a)` yes, `(a) && (b)` no. */
function stripParens(text: string): string {
  let t = text.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let closesAt = -1;
    for (let i = 0; i < t.length && closesAt < 0; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')' && --depth === 0) closesAt = i;
    }
    if (closesAt !== t.length - 1) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

const strip = (s: string): string => stripParens(s).replace(/\?\./g, '.').trim();
const noun = (path: string): string => humanize(path);

const LOADING = /^(?:is)?(?:loading|pending|fetching)$/i;
const ERROR = /^(?:is|has)?error$/i;
const SLOW = 'Reload the page, or slow the network in the browser dev tools, so the data has not arrived yet.';
const FAIL = 'Force a failure, for example by going offline or making the request fail.';

/** Translate a render condition (`tags === undefined`, `!items.length`, `isLoading`...) into words. */
export function conditionPhrase(rawText: string, ctx: ConditionContext = { isQuery: () => false }): ConditionPhrase {
  const text = strip(rawText);
  let m: RegExpExecArray | null;

  // x === undefined | null (and the negations)
  if ((m = /^([\w$.]+)\s*(===|==|!==|!=)\s*(undefined|null)$/.exec(text))) {
    const n = noun(m[1]!);
    const isNil = m[2] === '===' || m[2] === '==';
    const root = m[1]!.split('.')[0]!;
    // Query hooks give `undefined` while loading; a loose `== null` also covers that case.
    if ((m[3] === 'undefined' || m[2]!.length === 2) && ctx.isQuery(root)) {
      const loading: ConditionPhrase = {
        pos: `the ${n} ${be(n)} still loading`,
        neg: `the ${n} ${have(n)} loaded`,
        how: { pos: SLOW },
      };
      return isNil ? loading : flip(loading);
    }
    const unset: ConditionPhrase = { pos: `there is no ${n}`, neg: `there is a ${n}` };
    return isNil ? unset : flip(unset);
  }
  // x.length === 0 | < 1 | <= 0, !x.length  /  x.length > 0 | >= 1 | !== 0, x.length
  if ((m = /^([\w$.]+)\.length\s*(?:(?:===|==)\s*0|<\s*1|<=\s*0)$/.exec(text)) || (m = /^!([\w$.]+)\.length$/.exec(text))) {
    return emptiness(m[1]!);
  }
  if ((m = /^([\w$.]+)\.length\s*(?:>\s*0|>=\s*1|!==?\s*0)$/.exec(text)) || (m = /^([\w$.]+)\.length$/.exec(text))) {
    return flip(emptiness(m[1]!));
  }
  // x === 'literal'
  if ((m = /^([\w$.]+)\s*(===|==|!==|!=)\s*(['"`])(.*)\3$/.exec(text))) {
    const eq: ConditionPhrase = { pos: `the ${noun(m[1]!)} is "${m[4]}"`, neg: `the ${noun(m[1]!)} is not "${m[4]}"` };
    return m[2]!.startsWith('!') ? flip(eq) : eq;
  }
  // !x
  if ((m = /^!\s*([\w$.]+)$/.exec(text))) return flip(truthy(m[1]!, ctx));
  // x
  if ((m = /^([\w$.]+)$/.exec(text))) return truthy(m[1]!, ctx);

  return { pos: `this holds: \`${text}\``, neg: `this does not hold: \`${text}\`` };
}

function flip(p: ConditionPhrase): ConditionPhrase {
  return { pos: p.neg, neg: p.pos, how: { pos: p.how?.neg, neg: p.how?.pos } };
}

function emptiness(path: string): ConditionPhrase {
  const n = noun(path);
  return {
    pos: `the ${n} ${be(n)} empty`,
    neg: `the ${n} ${have(n)} at least one item`,
    how: { pos: `Use an account or project that has no ${n}.` },
  };
}

function truthy(path: string, ctx: ConditionContext): ConditionPhrase {
  const last = path.split('.').pop()!;
  if (LOADING.test(last)) {
    return { pos: 'the page is still loading', neg: 'the page has finished loading', how: { pos: SLOW } };
  }
  if (ERROR.test(last)) {
    return { pos: 'something goes wrong', neg: 'nothing goes wrong', how: { pos: FAIL } };
  }
  const flag = /^(is|has|can|should)([A-Z]\w*)$/.exec(last);
  if (flag) {
    const what = humanize(flag[2]!);
    const verb = flag[1]!;
    return verb === 'is'
      ? { pos: `it is ${what}`, neg: `it is not ${what}` }
      : { pos: `it ${verb} ${what}`, neg: `it ${verb === 'has' ? 'does not have' : verb === 'can' ? 'cannot' : 'should not'} ${what}` };
  }
  const n = noun(path);
  if (ctx.isQuery(path.split('.')[0]!)) return { pos: `the ${n} ${have(n)} loaded`, neg: `the ${n} ${be(n)} still loading`, how: { neg: SLOW } };
  return { pos: `there is a ${n}`, neg: `there is no ${n}` };
}

/** Verb phrase for what a backend call does, from its function name (`create`, `remove`...). */
export function outcomeOfCall(name: string): string | undefined {
  const n = name.split('.').pop()!;
  // The verb must be the whole name or its first word (`create`, `createTag`, `create_tag`), not a prefix of `address`.
  const verb = (words: string) => new RegExp(`^(?:${words})(?:[A-Z_0-9]|$)`).test(n);
  if (verb('create|add|insert|new') || n === 'post') return 'The new item is created';
  if (verb('update|edit|rename|patch|set|save|put')) return 'The change is saved';
  if (verb('remove|delete|destroy|archive')) return 'The item is removed';
  if (verb('list|get|fetch|load|find|query|count')) return 'The data loads';
  return undefined;
}
