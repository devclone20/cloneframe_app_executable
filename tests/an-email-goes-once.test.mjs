// The same email could leave twice, from four different directions.
//
// bridge/approvals.mjs approve() was one read-modify-write wrapped around the SMTP send:
//
//     const store = loadStore();          // snapshot
//     …
//     await Email.send(…)                 // fresh transport: connect + TLS + AUTH + DATA, 1-3s
//     item.status = 'sent'; saveStore(store);   // …and the snapshot is now seconds old
//
// Nothing serialised that window, so:
//   · two approvals of the same item — a second click, a second window, the scheduler — both
//     read status 'pending', both passed the check, and BOTH SENT.
//   · every other write to the store during the send (a reject, an agent's approvals.add, a
//     prune) was silently overwritten when the stale snapshot was finally saved.
//
// And in the UI, three buttons announced work without preventing it:
//
//     b.textContent = 'sending…';        // a label, not a lock
//
// The button stayed enabled for the whole round trip and was only replaced when the list
// re-rendered afterwards. APPROVAL's approve, its twin inside EMAIL's synthetic Approval
// folder, and the compose SEND (reachable from the button AND the ⌄ menu) all had it.
//
// The daemon fix is the load-bearing one: it holds even if a future UI forgets. The status
// 'approved' already existed in STATUSES, unused, and is exactly the right word — the owner
// said yes and it is on its way. The panel renders it as a badge with no buttons, and count()
// ignores it, so the APPROVAL badge clears the moment you click.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const approvals = read('bridge/approvals.mjs');
// Positions are compared below, so the COMMENTS have to go first. The comment explaining this
// very fix quotes `await Email.send()`, and the first draft of this test found that quotation
// at index 629 — inside the prose — instead of the call at 1900, and reported the fix as
// broken. Third time this exact trap has been sprung in this suite; it is written down here
// because a test that measures source positions must measure CODE.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const approve = decomment(approvals.match(/export async function approve\(id\) \{[\s\S]*?\n\}/)[0]);

test('the item is claimed on disk BEFORE the socket opens', () => {
  const claim = approve.indexOf("item.status = 'approved'");
  const save = approve.indexOf('saveStore(store);');
  const send = approve.indexOf('await Email.send(');
  assert.ok(claim > 0, 'the item must be moved out of pending before sending');
  assert.ok(save > claim && save < send,
    'and that claim must be WRITTEN before the send — an in-memory claim does not stop a second process');
  assert.match(approve, /if \(item\.status !== 'pending'\)/,
    'and a second approval must be refused by the status check it just failed');
});

test("'approved' is a status the store and the panel already understand", () => {
  assert.match(approvals, /const STATUSES = new Set\(\[[^\]]*'approved'/,
    'the claim status must be in the validated set');
  assert.match(approvals, /it\.status === 'pending'\)\.length/,
    'count() must still count only pending, so the badge clears on click');
  const panel = read('web/panels/approval.js');
  assert.match(panel, /a\.status==='pending'\?`<div class="compose-actions"/,
    'a claimed item must render without buttons — the panel keys off pending, which is right');
});

test('the outcome is applied to a FRESH read, not to the stale snapshot', () => {
  const fresh = approve.indexOf('const fresh = loadStore();');
  const send = approve.indexOf('await Email.send(');
  assert.ok(fresh > send, 're-read after the await, or every concurrent write is lost');
  assert.match(approve, /saveStore\(fresh\);/, 'and save the fresh one');
  assert.doesNotMatch(approve.slice(send), /saveStore\(store\);/,
    'saving the pre-send snapshot after the send is the lost-write itself');
});

test('a failed send returns the draft to the owner instead of consuming it', () => {
  assert.match(approve, /row\.status = 'pending';/,
    'a send that failed must leave something the owner can retry');
  assert.match(approve, /row\.error = \(result && result\.error\) \|\| 'send failed';/);
});

test('every send button is disabled while it sends, not merely relabelled', () => {
  for (const [file, marker] of [
    ['web/panels/approval.js', "data-ap"],
    ['web/panels/email.js', "data-ap"],
  ]) {
    const src = read(file);
    const handler = src.match(new RegExp("\\[" + marker + "\\]'\\)\\.forEach\\(b=>b\\.addEventListener\\('click',async\\(\\)=>\\{[^\\n]*"))[0];
    assert.match(handler, /if\(b\.disabled\)return;b\.disabled=true/,
      file + ': the approve button must lock, not just say "sending…"');
    assert.match(handler, /finally\{b\.disabled=false\}/,
      file + ': and it must come back even when the send throws');
  }
});

test('compose SEND locks both of its entry points, not just the button', () => {
  const em = read('web/panels/email.js');
  assert.match(em, /let sending=false;/, 'a flag, because the ⌄ menu reaches doSend too');
  assert.match(em, /if\(sending\)return;/);
  assert.match(em, /finally\{sending=false;const b2=g\('csend'\);if\(b2\)b2\.disabled=false\}/,
    'and it must unlock on failure as well as success');
});
