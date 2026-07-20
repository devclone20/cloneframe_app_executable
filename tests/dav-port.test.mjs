// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — DAV Platform Port: contract tests
//
// Runs the SAME assertions against the real port (dav.mjs, backed by a local
// http.Server fixture — no external network) and the in-memory fake
// (fakeDav.mjs), so a caller migrating from either calendar.mjs's or
// contacts.mjs's hand-rolled DAV code to this port can trust the fake in its
// own unit tests exactly as much as the real transport.
//
// Run with: node --test dav.test.mjs   (Node 18+, zero deps)
// ─────────────────────────────────────────────────────────────────────────────
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import * as RealDav from '../bridge/platform/dav.mjs';
import { createFakeDav, CALDAV_MULTISTATUS_XML, CARDDAV_MULTISTATUS_XML } from '../bridge/platform/fakeDav.mjs';

// ── local fixture server (stands in for a real CalDAV/CardDAV host) ─────────
async function startFixtureServer() {
  const calls = [];
  const server = http.createServer((req, res) => {
    res.on('error', () => {}); // client-aborted (timeout test) writes must never crash the process
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('aborted', () => {});
    req.on('end', () => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      calls.push({ url: req.url, method: req.method, headers: { ...req.headers }, body });
      if (url.pathname === '/caldav') {
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(CALDAV_MULTISTATUS_XML);
      } else if (url.pathname === '/cardav') {
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(CARDDAV_MULTISTATUS_XML);
      } else if (url.pathname === '/normal') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      } else if (url.pathname === '/slow') {
        const t = setTimeout(() => {
          try { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('too-late'); } catch { /* client gone */ }
        }, 300);
        t.unref();
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  return { server, calls, baseUrl: `http://127.0.0.1:${port}` };
}

function getHeader(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

// ── suite ────────────────────────────────────────────────────────────────────
const fixture = await startFixtureServer();
after(() => { fixture.server.close(); });

const realCtx = {
  dav: RealDav,
  urls: {
    caldav: `${fixture.baseUrl}/caldav`,
    cardav: `${fixture.baseUrl}/cardav`,
    normal: `${fixture.baseUrl}/normal`,
    slow: `${fixture.baseUrl}/slow`,
  },
  calls: fixture.calls,
};

const fakeInstance = createFakeDav({
  routes: [
    { url: 'http://fake.test/caldav', method: 'REPORT', status: 207, body: CALDAV_MULTISTATUS_XML },
    { url: 'http://fake.test/cardav', method: 'REPORT', status: 207, body: CARDDAV_MULTISTATUS_XML },
    { url: 'http://fake.test/normal', status: 200, body: 'ok' },
    { url: 'http://fake.test/slow', delayMs: 300 },
  ],
});
const fakeCtx = {
  dav: fakeInstance,
  urls: {
    caldav: 'http://fake.test/caldav',
    cardav: 'http://fake.test/cardav',
    normal: 'http://fake.test/normal',
    slow: 'http://fake.test/slow',
  },
  calls: fakeInstance.calls,
};

function defineDavContractSuite(label, { dav, urls, calls }) {
  test(`[${label}] unfoldLines joins folded continuation lines (the single fold-marker char is removed, not content)`, () => {
    // RFC 5545/6350 folding inserts CRLF + exactly one whitespace char as a
    // pure wire artifact; unfolding must remove that whitespace char, not
    // preserve it as part of the value (so "Team" + " Sync" folded back
    // together is "TeamSync", not "Team Sync" — the space belongs to the
    // continuation's own content only if the encoder put a second one there).
    assert.deepEqual(
      dav.unfoldLines('SUMMARY:Team\r\n  Sync\r\nLOCATION:HQ\r\n\t Room 2'),
      ['SUMMARY:Team Sync', 'LOCATION:HQ Room 2'],
    );
    // a leading-space line with nothing before it has nothing to fold into
    assert.deepEqual(dav.unfoldLines(' orphan'), [' orphan']);
  });

  test(`[${label}] splitPropertyLine parses NAME;PARAM=x:value and uppercases the name`, () => {
    assert.deepEqual(
      dav.splitPropertyLine('dtstart;VALUE=DATE:20260715'),
      { name: 'DTSTART', params: ['VALUE=DATE'], value: '20260715' },
    );
    assert.equal(dav.splitPropertyLine('no-colon-here'), null);
  });

  test(`[${label}] decodeXMLEntities decodes named + decimal + hex refs, & last`, () => {
    assert.equal(dav.decodeXMLEntities('Q&amp;A'), 'Q&A');
    assert.equal(dav.decodeXMLEntities('&lt;tag&gt; &quot;q&quot; &apos;a&apos;'), '<tag> "q" \'a\'');
    assert.equal(dav.decodeXMLEntities('&#65;&#66;'), 'AB');       // decimal numeric refs
    assert.equal(dav.decodeXMLEntities('&#x41;&#x42;'), 'AB');    // hex numeric refs
    // decoding &amp; last must not re-interpret an entity's own output
    assert.equal(dav.decodeXMLEntities('&amp;lt;'), '&lt;');
  });

  test(`[${label}] authHeader builds a well-formed RFC 7617 Basic header`, () => {
    const expected = `Basic ${Buffer.from('alex:s3cr3t', 'utf8').toString('base64')}`;
    assert.equal(dav.authHeader({ user: 'alex', pass: 's3cr3t' }), expected);
    // missing creds still produce a well-formed (empty) header, never throw
    assert.equal(dav.authHeader(), `Basic ${Buffer.from(':', 'utf8').toString('base64')}`);
  });

  test(`[${label}] parseMultistatus extracts calendar-data, decodes entities, absolutizes href`, () => {
    const out = dav.parseMultistatus(CALDAV_MULTISTATUS_XML, {
      dataTag: 'calendar-data',
      baseUrl: 'https://dav.example.com/cal/personal/',
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].href, 'https://dav.example.com/cal/personal/team%20sync.ics');
    assert.match(out[0].data, /BEGIN:VEVENT/);
    assert.match(out[0].data, /SUMMARY:Team Sync & Review/);   // &amp; decoded
    assert.match(out[0].data, /LOCATION:HQ <Room 2>/);          // &lt;/&gt; decoded
  });

  test(`[${label}] parseMultistatus extracts address-data (same parser, different tag)`, () => {
    const out = dav.parseMultistatus(CARDDAV_MULTISTATUS_XML, { dataTag: 'address-data' });
    assert.equal(out.length, 1);
    assert.match(out[0].data, /BEGIN:VCARD/);
    assert.match(out[0].data, /ORG:Analytical Engines & Co/);   // &amp; decoded
    assert.equal(out[0].href, '/card/personal/contact-1.vcf');  // no baseUrl → left relative
  });

  test(`[${label}] davFetch requires a url`, async () => {
    await assert.rejects(() => dav.davFetch({}), TypeError);
    await assert.rejects(() => dav.davFetch({ method: 'GET' }), TypeError);
  });

  test(`[${label}] davFetch defaults to GET, sets Depth, and returns the 207 multistatus body`, async () => {
    const before = calls.length;
    const res = await dav.davFetch({ url: urls.caldav, method: 'REPORT', depth: 1 });
    assert.equal(res.status, 207);
    const text = await res.text();
    assert.match(text, /BEGIN:VEVENT/);

    const last = calls[calls.length - 1];
    assert.ok(calls.length > before, 'a call must have been recorded');
    assert.equal(getHeader(last.headers, 'Depth'), '1');
  });

  test(`[${label}] davFetch attaches Authorization only when creds are supplied`, async () => {
    await dav.davFetch({ url: urls.normal, creds: { user: 'alex', pass: 's3cr3t' } });
    const withCreds = calls[calls.length - 1];
    assert.equal(getHeader(withCreds.headers, 'Authorization'), dav.authHeader({ user: 'alex', pass: 's3cr3t' }));

    await dav.davFetch({ url: urls.normal });
    const withoutCreds = calls[calls.length - 1];
    assert.equal(getHeader(withoutCreds.headers, 'Authorization'), undefined);
  });

  test(`[${label}] davFetch ALWAYS applies a timeout — a dead/slow host does not hang the caller`, async () => {
    const start = Date.now();
    let caught = null;
    try {
      await dav.davFetch({ url: urls.slow, timeout: 30 });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    assert.ok(caught, 'davFetch must reject on a host that never answers within the timeout');
    assert.equal(dav.describeFetchError(caught), 'request timed out');
    assert.ok(elapsed < 250, `must reject close to the 30ms timeout, not wait for the full 300ms response (took ${elapsed}ms)`);
  });
}

defineDavContractSuite('real (local http fixture)', realCtx);
defineDavContractSuite('fake (fakeDav)', fakeCtx);
