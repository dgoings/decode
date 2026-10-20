import { describe, expect, test } from 'bun:test';
import { areaName, conditionPhrase, humanize, outcomeOfCall } from './phrase.ts';

const q = { isQuery: (n: string) => n === 'tags' || n === 'usage' };

describe('humanize', () => {
  test('identifiers become lowercase words, without handler/hook prefixes', () => {
    expect(humanize('TagsSettingsSection')).toBe('tags settings section');
    expect(humanize('handleAddTag')).toBe('add tag');
    expect(humanize('onRename')).toBe('rename');
    expect(humanize('useQuery')).toBe('query');
    expect(humanize('api.taskTags.create')).toBe('create');
    expect(humanize('HTMLParser')).toBe('html parser');
    expect(humanize('on_delete_item')).toBe('delete item');
    expect(areaName('TagsSettingsSection')).toBe('Tags settings section');
  });
});

describe('conditionPhrase', () => {
  test('undefined on a query result means still loading', () => {
    const p = conditionPhrase('tags === undefined', q);
    expect(p.pos).toBe('the tags are still loading');
    expect(p.neg).toBe('the tags have loaded');
    expect(p.how?.pos).toContain('slow the network');
    expect(conditionPhrase('tags !== undefined', q).pos).toBe('the tags have loaded');
  });

  test('a loose == null on a query result also means still loading; strict === null does not', () => {
    expect(conditionPhrase('data == null', { isQuery: (n) => n === 'data' }).pos).toBe('the data is still loading');
    expect(conditionPhrase('data === null', { isQuery: (n) => n === 'data' }).pos).toBe('there is no data');
  });

  test('undefined on something else means not set', () => {
    expect(conditionPhrase('pending === null').pos).toBe('there is no pending');
    expect(conditionPhrase('pending !== null').pos).toBe('there is a pending');
  });

  test('emptiness', () => {
    expect(conditionPhrase('items.length === 0').pos).toBe('the items are empty');
    expect(conditionPhrase('!items.length').pos).toBe('the items are empty');
    expect(conditionPhrase('items.length > 0').pos).toBe('the items have at least one item');
    expect(conditionPhrase('items.length').pos).toBe('the items have at least one item');
    expect(conditionPhrase('items.length === 0').how?.pos).toBe('Use an account or project that has no items.');
    expect(conditionPhrase('items.length >= 1').pos).toBe('the items have at least one item');
    expect(conditionPhrase('items.length < 1').pos).toBe('the items are empty');
    // Other thresholds are not "empty" or "non-empty": they fall back to the code.
    expect(conditionPhrase('items.length > 1').pos).toBe('this holds: `items.length > 1`');
    expect(conditionPhrase('items.length <= 1').pos).toBe('this holds: `items.length <= 1`');
  });

  test('loading, error and boolean flags', () => {
    expect(conditionPhrase('isLoading').pos).toBe('the page is still loading');
    expect(conditionPhrase('!isLoading').pos).toBe('the page has finished loading');
    expect(conditionPhrase('error').pos).toBe('something goes wrong');
    expect(conditionPhrase('error').how?.pos).toContain('going offline');
    expect(conditionPhrase('isOpen').pos).toBe('it is open');
    expect(conditionPhrase('!isOpen').pos).toBe('it is not open');
    expect(conditionPhrase('hasChanges').neg).toBe('it does not have changes');
  });

  test('plain identifiers and string comparisons', () => {
    expect(conditionPhrase('usage', q).pos).toBe('the usage has loaded');
    expect(conditionPhrase('user').pos).toBe('there is a user');
    expect(conditionPhrase('!user').pos).toBe('there is no user');
    expect(conditionPhrase("status === 'done'").pos).toBe('the status is "done"');
    expect(conditionPhrase("status !== 'done'").pos).toBe('the status is not "done"');
  });

  test('parentheses are only stripped when they wrap the whole expression', () => {
    expect(conditionPhrase('(items.length > 0) && (user)').pos).toBe('this holds: `(items.length > 0) && (user)`');
    expect(conditionPhrase('((isOpen))').pos).toBe('it is open');
  });

  test('anything else falls back to the code, marked', () => {
    expect(conditionPhrase('a && b').pos).toBe('this holds: `a && b`');
    expect(conditionPhrase('(a && b)').neg).toBe('this does not hold: `a && b`');
  });
});

test('outcomeOfCall needs the verb as a whole word, not a prefix of another word', () => {
  for (const n of ['address', 'setupFoo', 'listen', 'newsletter', 'postMessage', 'getter']) expect(outcomeOfCall(n)).toBeUndefined();
  expect(outcomeOfCall('createTag')).toBe('The new item is created');
  expect(outcomeOfCall('remove_item')).toBe('The item is removed');
  expect(outcomeOfCall('getUser')).toBe('The data loads');
});

test('outcomeOfCall reads the verb', () => {
  expect(outcomeOfCall('api.taskTags.create')).toBe('The new item is created');
  expect(outcomeOfCall('update')).toBe('The change is saved');
  expect(outcomeOfCall('removeTag')).toBe('The item is removed');
  expect(outcomeOfCall('countUsage')).toBe('The data loads');
  expect(outcomeOfCall('frobnicate')).toBeUndefined();
});
