// Hermetic E2E for the two things that made the in-app browser feel broken
// (owner report + measurement, 2026-07-25):
//
//   1. A target="_blank" link opened a page NOBODY COULD SEE. Adoption was gated on the
//      new target's url, but a popup is born with an EMPTY url and learns it a tick later
//      — so the gate never opened, the click looked like it did nothing, and the invisible
//      page kept rendering. Thirteen of them wedged the engine (Target.createTarget went
//      from 64ms to a 15s timeout).
//   2. Screencast frames came out at 1× and the retina canvas upscaled them.
//   3. Text could not leave a page: the engine renders in its own process, so a ⌘C inside
//      it reached nobody, and a synthetic ⌘A selected nothing.
//   4. Downloads were denied outright — the click produced no file and no message.
//   5. A file input did nothing at all: headless Chrome has no chooser to show, so the
//      page's request for a file fell into silence.
//
// No network: a throwaway http server provides the page, its link target and the file, so
// this proves the real CDP path end to end. Skips (does not fail) where Chrome is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-webengine-'));
process.env.CLONE_FRAME_HUB_ROOT = root; // throwaway engine profile — never the owner's
const { Webengine } = await import('../bridge/webengine.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A socket the module can talk to: attachWs registers handlers on it, we replay
// messages into them and collect everything it pushes back.
function fakeSocket() {
  const handlers = new Map();
  const sent = [];
  return {
    readyState: 1, bufferedAmount: 0,
    on(ev, fn) { handlers.set(ev, fn); },
    send(d) { sent.push(typeof d === 'string' ? JSON.parse(d) : { t: 'binary', bytes: d.length }); },
    recv(obj) { const h = handlers.get('message'); if (h) h(JSON.stringify(obj)); },
    sent,
  };
}

// JPEG SOF → the frame's REAL pixel dimensions (metadata would only report intent).
function jpegSize(b) {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

test('the browser behaves like a browser: popups, retina, selection, downloads, uploads', async (t) => {
  // Skip ONLY where there is genuinely no browser to drive. Anywhere a binary exists,
  // a failed start is a real failure — a skip that swallows it reports green for a
  // browser that cannot start at all.
  if (!Webengine.status().bin) { t.skip('no Chromium installed on this machine'); return; }
  // The suite runs dozens of files in parallel, so a browser launch can lose the CPU
  // race once. Three tries; failing all three is a real "the engine cannot start".
  let started = null;
  for (let i = 0; i < 3 && !(started && started.ok); i++) {
    if (i) await sleep(2000);
    started = await Webengine.start();
  }
  assert.equal(started.ok, true, 'the engine started: ' + (started.error || ''));

  const dlName = 'cfhub-test-download-' + process.pid + '.bin';
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/dl')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${dlName}"` });
      res.end('CLONE FRAME test payload');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url.startsWith('/dest')) { res.end('<title>DEST</title><h1>destination</h1>'); return; }
    // rel="noopener" on purpose: that is what the owner's own site uses, and it is the
    // shape the old code could never adopt.
    res.end('<title>SRC</title><a id="go" href="/dest" target="_blank" rel="noopener" style="font-size:40px">go to dest</a>'
      + '<p style="font-size:40px"><a id="get" href="/dl">fetch the file</a></p>'
      + '<p style="font-size:40px"><a id="plain" href="/dest">a plain link</a></p>'
      + '<p style="font-size:40px">needle-alpha-marker lives here</p>'
      // the page announces what it received, so the test can read the result off the title
      + '<p><input id="up" type="file" style="font-size:40px" onchange="document.title=\'GOT:\'+this.files[0].name"></p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';

  try {
    const ws = fakeSocket();
    Webengine.attachWs(ws);

    const opened = await Webengine.open({ url: base });
    assert.equal(opened.ok, true, 'engine opened the source page');
    ws.recv({ t: 'watch', id: opened.id });
    await sleep(1200);

    // ── retina: ask for 2× and check the JPEG really carries 2× pixels
    await Webengine.setViewport({ id: opened.id, width: 600, height: 400, scale: 2 });
    await Webengine.castStart({ id: opened.id, maxWidth: 1200, maxHeight: 800, quality: 64 });
    // Generous waits: a loaded machine (another engine casting, a full build running)
    // stretches every step, and a timing flake here would read as a real regression.
    let frame = null;
    for (let i = 0; i < 100 && !frame; i++) { await sleep(100); const f = Webengine.frame({ id: opened.id, since: 0 }); if (f.data) frame = f; }
    await Webengine.castStop({ id: opened.id });
    assert.ok(frame, 'the tab produced a screencast frame');
    assert.deepEqual(jpegSize(Buffer.from(frame.data, 'base64')), { w: 1200, h: 800 },
      'a 600×400 CSS viewport must cast at 1200×800 real pixels (engine device scale 2)');

    // ── the click the owner makes: a real trusted mouse event on a _blank link
    const found = await Webengine.find({ id: opened.id, query: 'go to dest' });
    const ref = (found.hits || []).find((h) => /go to dest/i.test(h.name || ''));
    assert.ok(ref, 'the link was found in the page');
    const before = ws.sent.length;
    let popup = null;
    // Two attempts: a click that lands while the page is still settling opens nothing,
    // and that is a property of the PAGE, not of the popup plumbing under test.
    for (let attempt = 0; attempt < 2 && !popup; attempt++) {
      await Webengine.clickRef({ id: opened.id, ref: ref.ref });
      for (let i = 0; i < 60 && !popup; i++) { await sleep(100); popup = ws.sent.slice(before).find((m) => m.t === 'popup'); }
    }
    assert.ok(popup, 'the click announced a popup to the window that caused it');
    assert.match(popup.url, /\/dest$/, 'the popup carries the url the link pointed at');
    assert.equal(popup.openerId, opened.id, 'and it is attributed to the tab that was clicked');

    // The popup is a live tab the panel can now show — not a page nobody can see.
    assert.ok(Webengine.tabs().some((x) => x.id === popup.id), 'the popup is a real tab on the engine');

    // ── text can leave a page: select it, read it back (the ⌘A / ⌘C path)
    const sel0 = await Webengine.selection({ id: opened.id });
    assert.equal(sel0.ok, true, 'the selection can be read');
    await Webengine.selectAll({ id: opened.id });
    const sel1 = await Webengine.selection({ id: opened.id });
    assert.match(sel1.text, /go to dest/, 'Select All really selects the page (a synthetic ⌘A does not)');

    // ── find on page really finds AND selects (that is what makes it visible)
    const hit = await Webengine.findText({ id: opened.id, query: 'needle-alpha-marker' });
    assert.equal(hit.found, true, 'find-on-page located the needle');
    const afterFind = await Webengine.selection({ id: opened.id });
    assert.match(afterFind.text, /needle-alpha-marker/, 'and left it selected, where the owner can see it');
    assert.equal((await Webengine.findText({ id: opened.id, query: 'zzz-absent-zzz' })).found, false, 'a miss is reported as a miss');

    // The primitive the page context menu and ⌘-click both stand on: what IS this thing?
    // Headless Chrome does not honour ⌘-click itself, so the panel hit-tests the link and
    // opens the tab — which only works if the hit-test knows the href.
    const plain = (await Webengine.readPage({ id: opened.id })).nodes.find((n) => /a plain link/i.test(n.name || ''));
    assert.ok(plain, 'the plain link is in the page');
    const over = await Webengine.hitTest({ id: opened.id, ref: plain.ref });
    assert.match(over.link, /\/dest$/, 'a hit-test over a link reports its href');
    const nowhere = await Webengine.hitTest({ id: opened.id, x: 5, y: 5 });
    assert.equal(nowhere.link, '', 'and over empty space it claims nothing');

    // ── a download link produces a file, not silence
    const dlBefore = ws.sent.length;
    const got = await Webengine.find({ id: opened.id, query: 'fetch the file' });
    const dref = (got.hits || []).find((h) => /fetch the file/i.test(h.name || ''));
    assert.ok(dref, 'the download link was found');
    await Webengine.clickRef({ id: opened.id, ref: dref.ref });
    let done = null;
    for (let i = 0; i < 80 && !done; i++) { await sleep(100); done = ws.sent.slice(dlBefore).find((m) => m.t === 'dl' && m.state === 'completed'); }
    assert.ok(done, 'the download was announced and completed (headless Chrome denies downloads unless told otherwise)');
    assert.equal(done.name, dlName, 'it kept the name the server gave it');
    if (done.path) { assert.equal(fs.existsSync(done.path), true, 'and the file is really on disk'); fs.rmSync(done.path, { force: true }); }
    // ── uploads: the page asks, the engine waits, a staged file answers it
    const upBefore = ws.sent.length;
    const chooser = (await Webengine.readPage({ id: opened.id })).nodes.find((n) => /choose file|escolher ficheiro|browse/i.test(n.name || ''));
    assert.ok(chooser, 'the file input is reachable');
    await Webengine.clickRef({ id: opened.id, ref: chooser.ref });
    let ask = null;
    for (let i = 0; i < 60 && !ask; i++) { await sleep(100); ask = ws.sent.slice(upBefore).find((m) => m.t === 'file'); }
    assert.ok(ask, 'clicking a file input asks the window for a file (headless Chrome shows no dialog of its own)');

    // a path we never staged must not be sendable, whatever the caller claims
    const refused = await Webengine.setFiles({ id: opened.id, node: ask.node, files: ['/etc/passwd'] });
    assert.equal(refused.ok, false, 'only staged files can be handed to a page');

    const staged = Webengine.stageUpload({ name: '../../escape/attempt.txt', data: Buffer.from('payload').toString('base64') });
    assert.equal(staged.ok, true, 'the picked bytes are staged');
    assert.equal(path.basename(staged.path), 'attempt.txt', 'and a traversal in the name is reduced to a filename');
    const sent = await Webengine.setFiles({ id: opened.id, node: ask.node, files: [staged.path] });
    assert.equal(sent.ok, true, 'the staged file was handed to the page');
    let received = null;
    for (let i = 0; i < 40 && !received; i++) { await sleep(100); const r = await Webengine.read({ id: opened.id }); if (/^GOT:/.test(r.title || '')) received = r.title; }
    assert.equal(received, 'GOT:attempt.txt', 'and the page really received it');
  } finally {
    await Webengine.stop().catch(() => {});
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
