// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — DAV Platform Port: in-memory fake
//
// A drop-in stand-in for dav.mjs's `davFetch` that serves canned multistatus
// XML instead of hitting the network — for unit-testing calendar.mjs /
// contacts.mjs (once migrated) and for the contract tests in dav.test.mjs.
//
// Only the transport (`davFetch`) is faked. The parsing primitives
// (`parseMultistatus`, `unfoldLines`, `splitPropertyLine`, `decodeXMLEntities`,
// `authHeader`) are re-exported straight from the real module — a fake that
// re-implemented parsing too could drift from the real behavior it's meant to
// stand in for, defeating the point of a contract test.
// ─────────────────────────────────────────────────────────────────────────────
import { parseMultistatus, unfoldLines, splitPropertyLine, decodeXMLEntities, authHeader, describeFetchError } from './dav.mjs';

function makeResponse({ status = 207, statusText = '', body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

/**
 * @param {object} [opts]
 * @param {Array<{url?:string, method?:string, status?:number, statusText?:string, body?:string, delayMs?:number}>} [opts.routes]
 *   Canned responses, matched in order by exact `url` and/or `method` (either
 *   may be omitted to match any). `delayMs`, if set, is compared against the
 *   effective timeout of each call — same as a real slow host, davFetch here
 *   rejects with a TimeoutError when `delayMs` exceeds the timeout, without
 *   an actual wall-clock wait (keeps tests fast and deterministic).
 * @param {{status?:number, statusText?:string, body?:string}} [opts.fallback]
 *   Response used when no route matches (default: 404 empty body).
 */
export function createFakeDav({ routes = [], fallback = { status: 404, statusText: 'Not Found', body: '' } } = {}) {
  const calls = [];

  async function davFetch({ url, method = 'GET', creds, timeout, body, depth, headers = {} } = {}) {
    if (!url || typeof url !== 'string') throw new TypeError('davFetch: url is required');

    const h = { ...headers };
    if (depth !== undefined && depth !== null) h.Depth = String(depth);
    if (creds && (creds.user || creds.pass)) h.Authorization = authHeader(creds);

    const ms = Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000;
    calls.push({ url, method, creds, timeout: ms, body, depth, headers: h });

    const match = routes.find((r) => (!r.url || r.url === url) && (!r.method || r.method === method));
    const cfg = match || fallback;

    if (cfg.delayMs != null && cfg.delayMs > ms) {
      const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      throw err;
    }
    return makeResponse(cfg);
  }

  return {
    davFetch,
    parseMultistatus,
    unfoldLines,
    splitPropertyLine,
    decodeXMLEntities,
    authHeader,
    describeFetchError,
    calls,
  };
}

// ── canned fixtures ──────────────────────────────────────────────────────────
// A minimal, realistic CalDAV REPORT (calendar-query) multistatus body: one
// VEVENT, one namespace style (D:/C:), href with URL-encoded space.
export const CALDAV_MULTISTATUS_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/cal/personal/team%20sync.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"etag-1"</D:getetag>
        <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//EN
BEGIN:VEVENT
UID:evt-1@example.com
DTSTAMP:20260101T000000Z
DTSTART:20260715T140000Z
DTEND:20260715T150000Z
SUMMARY:Team Sync &amp; Review
LOCATION:HQ &lt;Room 2&gt;
END:VEVENT
END:VCALENDAR
</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

// A minimal CardDAV REPORT (addressbook-query) multistatus body: one VCARD.
export const CARDDAV_MULTISTATUS_XML = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:response>
    <d:href>/card/personal/contact-1.vcf</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-2"</d:getetag>
        <c:address-data>BEGIN:VCARD
VERSION:3.0
FN:Ada Lovelace
EMAIL:ada@example.com
ORG:Analytical Engines &amp; Co
END:VCARD
</c:address-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

export default createFakeDav;
