// ─────────────────────────────────────────────────────────────────────────────
// T-006 · Characterization tests — HTML escaping in index.html
// Target (READ, never modified):
//   /Users/you/Desktop/iFRAME/apps/clone-frame-hub/index.html
//
// index.html is a single monolithic <script> — not an ES module, so its
// escape helpers cannot be `import`ed. The ticket explicitly asks to "extract
// their logic into a test", so this file transcribes the THREE distinct
// escaper bodies verbatim as they exist on disk today (grep-located, one
// definition site cited per function) and pins their exact character sets
// and output. A source-existence check at the bottom catches wholesale
// removal/renaming of any of the three names.
//
// The three escapers found in index.html are NOT identical — that
// inconsistency is itself part of what Wave-2 needs to see before unifying
// them into one shared escaper:
//
//   esc     (index.html:4301) — escapes & < > " '   (full text+attr safe set)
//   esc2    (index.html:4718) — escapes & < >        (NO quote escaping at all)
//   escAttr (index.html:9286) — escapes & " < >      (double quote, NOT single quote)
//
// `esc` is the only one of the three safe to drop into either a text node or
// a double- or single-quoted attribute. `esc2` is only text-node safe (never
// put its output inside an attribute — quotes pass through raw). `escAttr` is
// only DOUBLE-quoted-attribute safe — a single-quoted attribute built with
// escAttr() is still breakable by a `'` in the input. Every attribute site in
// index.html that calls escAttr()/esc2() double-quotes the attribute, so this
// is not (yet) an exploitable bug — but it is exactly the kind of implicit
// contract a refactor could silently break, hence pinning it here.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const INDEX_HTML_PATH = new URL('../index.html', import.meta.url);

// verbatim from index.html:4301
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// verbatim from index.html:4718 (also redefined identically at 5530, 5603, and 2962-with-no-quotes-either)
const esc2 = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// verbatim from index.html:9286
const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DOUBLE_QUOTE_XSS_PAYLOAD = `"><img src=x onerror=alert(1)>`;
const SINGLE_QUOTE_PAYLOAD = `'><img src=x onerror=alert(1)>`;
const AMPERSAND_FIRST_PAYLOAD = `&lt;script&gt;`; // must not be double-escaped (& must go first)

test('esc — escapes the full & < > " \' set (text-node AND either-quote-style attribute safe)', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(DOUBLE_QUOTE_XSS_PAYLOAD), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc(SINGLE_QUOTE_PAYLOAD), '&#39;&gt;&lt;img src=x onerror=alert(1)&gt;');
  // & is replaced first, so a pre-escaped entity is not mangled into &amp;amp;lt;...
  assert.equal(esc(AMPERSAND_FIRST_PAYLOAD), '&amp;lt;script&amp;gt;');
});

test('esc — a double-quote payload dropped into a double-quoted attribute cannot break out', () => {
  const html = `<div title="${esc(DOUBLE_QUOTE_XSS_PAYLOAD)}"></div>`;
  assert.equal(html, '<div title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"></div>');
  // exactly one literal `"` character survives in the whole string: the two
  // attribute-delimiter quotes hard-coded in the template itself.
  assert.equal((html.match(/"/g) || []).length, 2);
});

test('esc2 — escapes only & < > ; quote characters pass through completely unescaped', () => {
  assert.equal(esc2(`&<>`), '&amp;&lt;&gt;');
  assert.equal(esc2(`"'`), `"'`); // NOT text-attribute safe by itself — quotes untouched
  assert.equal(esc2('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('esc2 — neutralizes a tag-injection payload for a text node (its only safe context)', () => {
  const textNodeHtml = `<span>${esc2('<img src=x onerror=alert(1)>')}</span>`;
  assert.equal(textNodeHtml, '<span>&lt;img src=x onerror=alert(1)&gt;</span>');
  assert.ok(!textNodeHtml.includes('<img'), 'no live <img> tag must survive in the text node');
});

test('escAttr — escapes & " < > but leaves a bare single quote untouched', () => {
  assert.equal(escAttr(`&"<>`), '&amp;&quot;&lt;&gt;');
  assert.equal(escAttr(`'`), `'`); // documented gap: NOT single-quoted-attribute safe
  assert.equal(escAttr(null), '');
  assert.equal(escAttr(undefined), '');
});

test('escAttr — a double-quote payload dropped into a double-quoted attribute cannot break out', () => {
  const html = `<span data-id="${escAttr(DOUBLE_QUOTE_XSS_PAYLOAD)}"></span>`;
  assert.equal(html, '<span data-id="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"></span>');
  assert.equal((html.match(/"/g) || []).length, 2);
});

test('escAttr — (documented gap) a raw single quote survives, so it is NOT single-quoted-attribute safe', () => {
  // This is not a live bug today because every escAttr() call site in
  // index.html uses double-quoted attributes — but it means escAttr() and
  // esc() are NOT interchangeable, which Wave-2's unification must preserve
  // or deliberately fix (not silently regress). The proof: a raw `'` from
  // the input reaches the output unescaped, which would terminate a
  // single-quoted attribute value early — unlike esc(), which turns every
  // `'` into `&#39;` and can never do this.
  const out = escAttr(SINGLE_QUOTE_PAYLOAD);
  assert.ok(out.includes(`'`), 'a raw quote character survives escAttr() unescaped');
  assert.equal(out.startsWith(`'`), true);
  // esc(), by contrast, closes this exact gap:
  assert.equal(esc(SINGLE_QUOTE_PAYLOAD).includes(`'`), false);
});

// ── source existence pin ─────────────────────────────────────────────────────
// Cheap tripwire: fails if any of the three escaper names disappear from
// index.html entirely (e.g. renamed during the Wave-2 extraction without a
// forwarding alias), independent of exact formatting/whitespace.
test('index.html still defines esc, esc2, and escAttr', () => {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.match(src, /\bconst esc=/, 'esc(...) definition not found');
  assert.match(src, /\bconst esc2=/, 'esc2(...) definition not found');
  assert.match(src, /\bconst escAttr=/, 'escAttr(...) definition not found');
});
