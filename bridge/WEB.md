# web.mjs — fetch + lightweight search

Zero-dependency ESM module. Node built-ins only (global `fetch`, `node:dns/promises`).
Stateless, read-only, no persistence. Powers Deep Research and the agent's
`web.fetch` tool.

## Import

```js
import Web from './web.mjs';
// or
import { fetchUrl, search, research } from './web.mjs';
```

## Contract

### `Web.fetchUrl(url) -> Promise<{ok, url, title?, text?, error?}>`

Fetches a single page with a browser-like User-Agent, 15s timeout, follows
redirects (manually, re-validating the SSRF guard on every hop). Raw body is
capped at ~2 MB while streaming (never buffers more); returned `text` is
capped at ~20 KB. Extracts `<title>` and a readable-text version of the page
(script/style/noscript stripped, tags stripped, block elements become
newlines, HTML entities decoded, whitespace collapsed).

Non-`http(s)` URLs and obvious SSRF targets are rejected before any network
call: `localhost`/`*.localhost`, IPv4 loopback/private/link-local
(`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`169.254.0.0/16`, `0.0.0.0/8`), IPv6 loopback/unique-local/link-local
(`::1`, `fc00::/7`, `fe80::/10`), and IPv4-mapped IPv6 equivalents of the
above. Hostnames are also DNS-resolved and checked against the same ranges
before connecting (blocks DNS pointing a public-looking domain at an
internal IP), and the same check is re-applied to every redirect target.
Blocked / disallowed → `{ok:false, error:'blocked'}`. Never throws — network,
timeout (`error:'timeout'`), HTTP, and content-type errors are all caught and
returned as `{ok:false, error}`. Non-text content types (image/audio/video/
octet-stream/pdf/zip) are rejected early.

### `Web.search(query, {limit=6}={}) -> Promise<{ok, results:[{title,url,snippet}], error?}>`

Keyless web search. Primary backend: DuckDuckGo HTML endpoint
(`https://html.duckduckgo.com/html/?q=...`), parsed with regex (no HTML
parser dependency) — extracts `result__a` anchors (title + href, unwrapping
DDG's `/l/?uddg=` redirect wrapper) paired with `result__snippet` blocks.
Falls back to the DuckDuckGo Instant Answer JSON API
(`https://api.duckduckgo.com/?q=...&format=json&no_html=1`) — using
`AbstractURL`/`AbstractText` and `RelatedTopics` — when HTML parsing yields
zero results (DDG occasionally serves a lite/blocked page to non-browser
clients). Returns up to `limit` (clamped 1–20) results. Never throws;
`{ok:false, results:[], error}` on total failure (both backends empty/down).

### `Web.research(question, {maxSources=4}={}) -> Promise<{ok, sources:[{title,url,text}], error?}>`

Convenience wrapper: `search(question, {limit: maxSources*2})`, then
sequentially `fetchUrl`s results (skipping ones that fail/are blocked) until
`maxSources` (clamped 1–10) succeed. Returns each source's title, resolved
URL, and extracted text for a caller (e.g. an LLM) to synthesize. Never
throws; `{ok:false, sources:[], error}` if search or every fetch fails.

## Search backend & caveats

- **Backend**: DuckDuckGo HTML scrape (primary) → DuckDuckGo Instant Answer
  JSON API (fallback). No API key, no billing, no deps.
- **Rate limits**: DuckDuckGo has no published keyless-use quota but will
  throttle/soft-block IPs that hammer `html.duckduckgo.com` — this module
  makes one request per `search()` call with a real browser UA and no
  retries/backoff. `research()` amplifies this: one search call + up to
  `maxSources` page fetches per invocation. Keep call volume low in a tight
  loop; consider caching results at the caller if Deep Research fans out
  across many questions in one run.
- **Fragility**: the HTML parser is regex-based against DuckDuckGo's current
  markup (`result__a` / `result__snippet` class names). If DuckDuckGo changes
  its HTML, `search()` degrades gracefully to the Instant Answer fallback
  (which is coarser — abstracts/related-topics, not full SERP results) rather
  than throwing.

## Self-test

```sh
node --check web.mjs
node -e 'import("./web.mjs").then(async ({default:Web})=>{
  console.log(await Web.fetchUrl("http://127.0.0.1/"));   // {ok:false, error:"blocked"}
  console.log(await Web.fetchUrl("https://example.com"));  // {ok:true, text:...}
  console.log(await Web.search("node.js"));                // {ok:true, results:[...]}
})'
```
