// Fork-consolidation test for calendar.mjs AFTER its CalDAV network fork
// (davFetch + PROPFIND/REPORT + multistatus parsing) was migrated onto the
// shared platform/dav.mjs port. The JSON-store surface is already covered by
// calendar-context.test.mjs; this file targets the DAV transport+parse path the
// migration actually moved, and proves it BEHAVIOR-PRESERVING for RPC clients.
//
// OFFLINE only: global `fetch` is stubbed to serve the canned CalDAV
// multistatus fixture from fakeDav.mjs (the same body the port's contract test
// uses) — no real network is ever touched. Isolated to a throwaway dir via the
// CLONE_FRAME_HUB_ROOT hub-root seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CALDAV_MULTISTATUS_XML } from '../bridge/platform/fakeDav.mjs';

const COLLECTION = 'https://dav.example.com/cal/personal/';

async function freshCalendar() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-calendar-fork-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/calendar.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, Cal: mod.Calendar, file: path.join(root, 'calendar.json') };
}

function seed(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function connected(root) {
  seed(path.join(root, 'calendar.json'), {
    version: 1,
    connection: { url: COLLECTION, connectedAt: 1_700_000_000_000 },
    events: [],
  });
  seed(path.join(root, 'calendar.secret.json'), {
    version: 1, url: COLLECTION, user: 'alice', pass: 'topsecretpass',
  });
}

// Records every outgoing request and returns a canned response, so tests assert
// both the wire shape (unchanged by the migration) and the parsed result.
function stubFetch({ status = 207, body = '', throwErr } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (throwErr) throw throwErr;
    return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('events() runs the migrated REPORT and parses multistatus via the port (fields decoded, href absolutized)', async () => {
  const { Cal, root, file } = await freshCalendar();
  connected(root);
  const { calls, restore } = stubFetch({ status: 207, body: CALDAV_MULTISTATUS_XML });
  try {
    const evs = await Cal.events({ from: '2026-07-01', to: '2026-08-01' });
    assert.equal(evs.length, 1);
    const ev = evs[0];
    assert.equal(ev.uid, 'evt-1@example.com');
    assert.equal(ev.summary, 'Team Sync & Review');        // &amp; decoded by the port
    assert.equal(ev.location, 'HQ <Room 2>');               // &lt;/&gt; decoded by the port
    assert.equal(ev.start, '2026-07-15T14:00:00Z');
    assert.equal(ev.end, '2026-07-15T15:00:00Z');
    // href from the fixture (/cal/personal/team%20sync.ics) absolutized against the collection
    assert.equal(ev.href, 'https://dav.example.com/cal/personal/team%20sync.ics');

    // parsed events were upserted into the on-disk cache
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.events.length, 1);
    assert.equal(onDisk.events[0].uid, 'evt-1@example.com');
  } finally {
    restore();
  }
});

test('the REPORT request SHAPE is byte-identical to the pre-migration fork', async () => {
  const { Cal, root } = await freshCalendar();
  connected(root);
  const { calls, restore } = stubFetch({ status: 207, body: CALDAV_MULTISTATUS_XML });
  try {
    await Cal.events({ from: '2026-07-01', to: '2026-08-01' });
    assert.equal(calls.length, 1);
    const req = calls[0];
    assert.equal(req.url, COLLECTION);
    assert.equal(req.method, 'REPORT');
    assert.equal(req.headers.Depth, '1');
    assert.equal(req.headers['Content-Type'], 'application/xml; charset=utf-8');
    // Basic auth from the migrated davFetch (RFC 7617)
    assert.equal(req.headers.Authorization, `Basic ${Buffer.from('alice:topsecretpass', 'utf8').toString('base64')}`);
    // the calendar-query body / time-range window must be unchanged
    assert.match(req.body, /<c:calendar-query/);
    assert.match(req.body, /<c:comp-filter name="VEVENT">/);
    assert.match(req.body, /time-range start="20260701T000000Z" end="20260801T000000Z"/);
    // always aborts on a timeout (the port applies AbortSignal.timeout, same as the fork)
    assert.ok(req.signal, 'davFetch must attach an abort signal');
  } finally {
    restore();
  }
});

test('deleteEvent() issues DELETE and maps a transport failure through the port describeFetchError', async () => {
  const { Cal, root } = await freshCalendar();
  connected(root);
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const { calls, restore } = stubFetch({ throwErr: timeout });
  try {
    const res = await Cal.deleteEvent('evt-1@example.com');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'request timed out'); // proves the imported describeFetchError is wired
    const req = calls[0];
    assert.equal(req.method, 'DELETE');
    assert.equal(req.url, 'https://dav.example.com/cal/personal/evt-1@example.com.ics');
    assert.equal(req.headers.Authorization, `Basic ${Buffer.from('alice:topsecretpass', 'utf8').toString('base64')}`);
  } finally {
    restore();
  }
});

test('a 404-less network error during events() degrades to the in-range cache (never throws)', async () => {
  const { Cal, root } = await freshCalendar();
  seed(path.join(root, 'calendar.json'), {
    version: 1,
    connection: { url: COLLECTION, connectedAt: 1 },
    events: [{ uid: 'cached-1', summary: 'Cached', start: '2026-07-15T09:00:00Z', end: '2026-07-15T10:00:00Z', location: '', href: '' }],
  });
  seed(path.join(root, 'calendar.secret.json'), { version: 1, url: COLLECTION, user: 'alice', pass: 'x' });
  const { restore } = stubFetch({ throwErr: new Error('ECONNREFUSED') });
  try {
    const evs = await Cal.events({ from: '2026-07-01', to: '2026-08-01' });
    assert.equal(evs.length, 1);
    assert.equal(evs[0].uid, 'cached-1');
  } finally {
    restore();
  }
});
