// Contract tests for text.mjs — run the identical assertion set against the
// real port and the fake, proving they behave identically, and separately
// prove parseInstant() reproduces reminders.mjs / scheduled.mjs verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Real from '../bridge/platform/text.mjs';
import { createFakeText } from '../bridge/platform/text.fake.mjs';

function contract(name, impl) {
  test(`${name}: snippet() returns '' for nullish/empty`, () => {
    assert.equal(impl.snippet(''), '');
    assert.equal(impl.snippet(null), '');
    assert.equal(impl.snippet(undefined), '');
  });

  test(`${name}: snippet() leaves short text untouched`, () => {
    assert.equal(impl.snippet('hello world'), 'hello world');
  });

  test(`${name}: snippet() collapses whitespace runs (incl. newlines) to a single space`, () => {
    assert.equal(impl.snippet('a   b\n\n\tc'), 'a b c');
  });

  test(`${name}: snippet() truncates at default 200 chars with a trailing ellipsis`, () => {
    const long = 'x'.repeat(250);
    const s = impl.snippet(long);
    assert.equal(s, `${'x'.repeat(200)}…`);
  });

  test(`${name}: snippet() honors a custom length`, () => {
    assert.equal(impl.snippet('abcdefghij', 5), 'abcde…');
  });

  test(`${name}: normalizeTags() splits a comma string, trims, dedupes case-insensitively (keeps first casing)`, () => {
    assert.deepEqual(impl.normalizeTags('a, b ,A,C'), ['a', 'b', 'C']);
  });

  test(`${name}: normalizeTags() accepts an array, drops empties, caps tag length`, () => {
    assert.deepEqual(impl.normalizeTags(['  x  ', '', null, undefined]), ['x']);
    assert.deepEqual(impl.normalizeTags(['a'.repeat(100)], { maxLen: 5 }), ['aaaaa']);
  });

  test(`${name}: normalizeTags() returns [] for any non-array/non-string input`, () => {
    assert.deepEqual(impl.normalizeTags(42), []);
    assert.deepEqual(impl.normalizeTags(null), []);
    assert.deepEqual(impl.normalizeTags({ a: 1 }), []);
  });

  test(`${name}: normalizeTags() caps result length at maxTags`, () => {
    const many = Array.from({ length: 60 }, (_, i) => `t${i}`);
    assert.equal(impl.normalizeTags(many).length, 50);
    assert.equal(impl.normalizeTags(many, { maxTags: 3 }).length, 3);
  });

  test(`${name}: parseInstant() accepts an ISO string`, () => {
    const r = impl.parseInstant('2026-07-20T10:00:00.000Z');
    assert.deepEqual(r, { ok: true, iso: '2026-07-20T10:00:00.000Z' });
  });

  test(`${name}: parseInstant() accepts an epoch-ms number`, () => {
    const r = impl.parseInstant(0);
    assert.deepEqual(r, { ok: true, iso: new Date(0).toISOString() });
  });

  test(`${name}: parseInstant() treats a bare YYYY-MM-DD as UTC midnight`, () => {
    const r = impl.parseInstant('2026-07-20');
    assert.equal(r.ok, true);
    assert.equal(r.iso, new Date('2026-07-20').toISOString());
    assert.ok(r.iso.startsWith('2026-07-20T00:00:00'));
  });

  test(`${name}: parseInstant() rejects null/empty/NaN/Infinity/booleans/objects`, () => {
    for (const bad of [null, undefined, '', NaN, Infinity, -Infinity, true, {}, []]) {
      const r = impl.parseInstant(bad);
      assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
      assert.equal(typeof r.error, 'string');
    }
  });

  test(`${name}: parseInstant() rejects an unparseable string`, () => {
    const r = impl.parseInstant('not-a-date');
    assert.equal(r.ok, false);
    assert.match(r.error, /not a parseable date\/time/);
  });

  test(`${name}: parseInstant() default field name is 'value'`, () => {
    assert.equal(impl.parseInstant(null).error, 'value is required');
  });

  test(`${name}: parseInstant({field:'remindAt'}) matches reminders.mjs error wording verbatim`, () => {
    assert.equal(impl.parseInstant(null, { field: 'remindAt' }).error, 'remindAt is required');
    assert.equal(impl.parseInstant(NaN, { field: 'remindAt' }).error, 'remindAt is not a finite timestamp');
    assert.equal(impl.parseInstant('nope', { field: 'remindAt' }).error, 'remindAt is not a parseable date/time');
    assert.equal(impl.parseInstant(true, { field: 'remindAt' }).error, 'remindAt must be an ISO string or epoch-ms number');
  });

  test(`${name}: parseInstant({field:'sendAt'}) matches scheduled.mjs error wording verbatim`, () => {
    assert.equal(impl.parseInstant(null, { field: 'sendAt' }).error, 'sendAt is required');
    assert.equal(impl.parseInstant(NaN, { field: 'sendAt' }).error, 'sendAt is not a finite timestamp');
    assert.equal(impl.parseInstant('nope', { field: 'sendAt' }).error, 'sendAt is not a parseable date/time');
    assert.equal(impl.parseInstant(true, { field: 'sendAt' }).error, 'sendAt must be an ISO string or epoch-ms number');
  });

  test(`${name}: toMillis() is tolerant — bad input falls back (default NaN)`, () => {
    assert.ok(Number.isNaN(impl.toMillis('garbage')));
    assert.equal(impl.toMillis('garbage', 42), 42);
    assert.equal(impl.toMillis(null, 7), 7);
    assert.equal(impl.toMillis(1000), 1000);
    assert.equal(impl.toMillis('2026-07-20T00:00:00.000Z'), Date.parse('2026-07-20T00:00:00.000Z'));
  });
}

contract('real', Real);
contract('fake', createFakeText());

// ── proof that text.mjs's parseInstant reproduces reminders.mjs AND
// scheduled.mjs byte-for-byte (both modules' own parseInstant source is
// identical to each other save for the field name baked into the message) ──
test('parseInstant is a verbatim drop-in for reminders.mjs (field="remindAt")', () => {
  function reminders_parseInstant(v) {
    if (v == null || v === '') return { ok: false, error: 'remindAt is required' };
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return { ok: false, error: 'remindAt is not a finite timestamp' };
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? { ok: false, error: 'remindAt is not a valid timestamp' } : { ok: true, iso: d.toISOString() };
    }
    if (typeof v === 'string') {
      const t = Date.parse(v.trim());
      return Number.isNaN(t) ? { ok: false, error: 'remindAt is not a parseable date/time' } : { ok: true, iso: new Date(t).toISOString() };
    }
    return { ok: false, error: 'remindAt must be an ISO string or epoch-ms number' };
  }
  const samples = [null, undefined, '', 0, 1721000000000, NaN, Infinity, '2026-07-20', '2026-07-20T00:00:00Z', 'garbage', true, {}, [1, 2]];
  for (const s of samples) {
    assert.deepEqual(Real.parseInstant(s, { field: 'remindAt' }), reminders_parseInstant(s), `mismatch for ${JSON.stringify(s)}`);
  }
});

test('parseInstant is a verbatim drop-in for scheduled.mjs (field="sendAt")', () => {
  function scheduled_parseInstant(v) {
    if (v == null || v === '') return { ok: false, error: 'sendAt is required' };
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return { ok: false, error: 'sendAt is not a finite timestamp' };
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? { ok: false, error: 'sendAt is not a valid timestamp' } : { ok: true, iso: d.toISOString() };
    }
    if (typeof v === 'string') {
      const t = Date.parse(v.trim());
      return Number.isNaN(t) ? { ok: false, error: 'sendAt is not a parseable date/time' } : { ok: true, iso: new Date(t).toISOString() };
    }
    return { ok: false, error: 'sendAt must be an ISO string or epoch-ms number' };
  }
  const samples = [null, undefined, '', 0, 1721000000000, NaN, Infinity, '2026-07-20', '2026-07-20T00:00:00Z', 'garbage', true, {}, [1, 2]];
  for (const s of samples) {
    assert.deepEqual(Real.parseInstant(s, { field: 'sendAt' }), scheduled_parseInstant(s), `mismatch for ${JSON.stringify(s)}`);
  }
});

test('toMillis is byte-identical to reminders.mjs / scheduled.mjs toMillis', () => {
  function toMillis(v, fallback = NaN) {
    if (v == null || v === '') return fallback;
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
    const t = Date.parse(String(v ?? '').trim());
    return Number.isNaN(t) ? fallback : t;
  }
  const samples = [null, undefined, '', 0, 42, NaN, Infinity, '2026-07-20', 'garbage', [1, 2], {}];
  for (const s of samples) {
    const expected = toMillis(s, -1);
    const actual = Real.toMillis(s, -1);
    if (Number.isNaN(expected)) assert.ok(Number.isNaN(actual));
    else assert.equal(actual, expected);
  }
});
