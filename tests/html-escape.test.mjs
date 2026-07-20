// ─────────────────────────────────────────────────────────────────────────────
// HTML escaping — post-unification guard (T-041, supersedes the T-006 characterization).
//
// Wave-5 replaced the 13 inconsistent local escapers (esc/esc2/esc3/escA/escAttr, whose
// char-sets silently differed per IIFE scope) with ONE pair sourced from web/core kernel:
//   escHtml — TEXT node context, escapes & < >
//   escAttr — ATTRIBUTE context (safe anywhere), escapes & < > " '
// The kernel's behaviour is unit-tested in kernel.test.mjs. THIS file guards the shipped
// artifact (dist/index.html) so the latent attribute-injection class the old esc2/text-only
// escapers left open can never silently reopen: no [&<>]-only escaper may sit inside a
// double-quoted attribute. Reads the BUILT document (what the bridge serves).
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIST = new URL('../dist/index.html', import.meta.url);
const html = fs.readFileSync(DIST, 'utf8');
const lines = html.split('\n');

test('the unified escaper pair is present in the shipped document', () => {
  // The kernel is inlined by the build; esbuild emits `var escHtml`/`var escAttr` and a
  // window-exposure line. Assert both exist and are published as globals.
  assert.match(html, /\bescHtml\b/, 'escHtml missing from dist');
  assert.match(html, /\bescAttr\b/, 'escAttr missing from dist');
  assert.match(html, /Object\.assign\(window,\s*\{[^}]*\bescHtml\b[^}]*\bescAttr\b/, 'kernel does not publish escHtml/escAttr as globals');
});

test('the 13 legacy per-scope escapers are gone (no [&<>]-only text escaper redefined)', () => {
  // The exact bodies of the old text-only escapers must not survive anywhere in the shipped
  // file (they were the source of the attribute-injection holes).
  assert.doesNotMatch(html, /const esc2\s*=\s*t\s*=>\s*String\([^)]*\)\.replace\(\/\[&<>\]/, 'a legacy esc2 [&<>]-only definition survived');
  assert.doesNotMatch(html, /const escA\s*=/, 'legacy escA definition survived');
  assert.doesNotMatch(html, /const esc3\s*=/, 'legacy esc3 definition survived');
});

test('SECURITY — no [&<>]-only escaper (escHtml) sits inside a double-quoted attribute', () => {
  // Per line (attribute values never span lines in this file): a `="…${escHtml(` with no
  // intervening `"` means escHtml is escaping an attribute value — it does NOT escape quotes,
  // so a value bearing `"` could break out. Every attribute site must use escAttr instead.
  const offenders = [];
  lines.forEach((ln, i) => {
    if (/="[^"]*\$\{escHtml\(/.test(ln) || /='[^']*\$\{escHtml\(/.test(ln)) offenders.push(i + 1);
  });
  assert.deepEqual(offenders, [], `escHtml found in attribute context at dist line(s): ${offenders.join(', ')} — must be escAttr`);
});

test('SECURITY — the two must-be-escAttr sinks (srcdoc iframe, onerror handler) use escAttr', () => {
  // srcdoc carries HTML-in-attribute; onerror carries a JS string — escHtml (no quote escaping)
  // would be insufficient in both. Pin them explicitly.
  assert.match(html, /srcdoc="\$\{escAttr\(/, 'iframe srcdoc must interpolate via escAttr');
  assert.match(html, /onerror="[^"]*escAttr\(/, 'the inline onerror handler must interpolate via escAttr');
});

test('the separate markdown escapeHtml() renderer is untouched (out of the esc* family)', () => {
  assert.match(html, /function escapeHtml\(/, 'escapeHtml() (markdown/code renderer) should remain');
});
