// Typing must never be a command. The owner typed into a web page inside the BROWSER panel and
// windows opened that he never asked for.
//
// Three conduits, all ours:
//   1. The BROWSER paints its page on a focusable <canvas>. The global "g then letter" chord
//      only stood down for INPUT/TEXTAREA/SELECT/contenteditable, so a <canvas> was fair game;
//      and the canvas handler called preventDefault WITHOUT stopPropagation, so every keystroke
//      typed into a page ALSO ran every window-level shortcut. Portuguese is full of "ga"/"gu"
//      ("obrigado", "segunda", "guardar") — g→a opens CODE, g→u opens AUTOMATIONS.
//   2. "?" toggled the shortcuts overlay under the same weak guard.
//   3. The command palette accepted ⌃K. On macOS ⌃K is "delete to end of line" in every text
//      field, so it opened mid-sentence — and the Enter that followed RAN the selected entry.
//
// This drives the REAL built artifact in a REAL Chrome over CDP: keystrokes arrive as
// Input.dispatchKeyEvent, not as synthetic DOM events, so what is proven here is what happens
// on the owner's machine. The stand-in for the BROWSER's page surface is a focusable <canvas>
// the test adds itself — the panel's own canvas needs a live engine, and this proves the same
// invariant hermetically: with a page surface focused, letters are text and nothing else.
//
// State travels through document.title, which the app itself never writes (grep: zero hits) and
// which Webengine.read() returns straight off a Runtime.evaluate. The accessibility tree was
// tried first and is the wrong instrument: readPage stops after 400 nodes, so the observer fell
// out of range as soon as a panel opened, and one full getFullAXTree of this app costs seconds.
//
// Two tests, not one, and both short. Input.dispatchKeyEvent is answered only once the renderer
// has handled the event, and under CDP those acks pile up until nothing answers at all — measured
// on a page carrying no app code, the twentieth keyDown was still unanswered after 10s. Each test
// therefore boots its own engine and spends well under a dozen keystrokes. The app itself is not
// implicated: the BROWSER panel fires its keystrokes down a WebSocket without waiting for an ack.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'dist', 'index.html');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keys-'));
process.env.CLONE_FRAME_HUB_ROOT = root; // throwaway engine profile — never the owner's
const { Webengine } = await import('../bridge/webengine.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

const SINK = { x: 400, y: 300, w: 220, h: 160 };
// Reports on EVENTS, never on a timer: headless Chrome throttles the timers of a page nobody is
// painting, which starved every earlier version of this observer. A page handling an input event
// is awake by definition, and mousemove is the nudge the reader uses to force a fresh write — so
// no reading can be a snapshot taken before the app finished reacting.
const PROBE = `<canvas id="cfsink" tabindex="0" style="position:fixed;left:${SINK.x}px;top:${SINK.y}px;width:${SINK.w}px;height:${SINK.h}px;z-index:2147483647"></canvas>
<script>(function(){
  var errs=0;
  function upd(tag){
    var pal=document.getElementById('pal'),keys=document.getElementById('keys'),a=document.activeElement;
    document.title='cfstate '+tag
      +' p='+document.querySelectorAll('.panel').length
      +' pal='+((pal&&pal.style.display==='block')?1:0)
      +' keys='+((keys&&keys.style.display==='block')?1:0)
      +' ae='+((a&&(a.id||a.tagName))||'none')
      +' err='+errs;
  }
  addEventListener('keyup',function(e){upd('k:'+e.key)});
  addEventListener('mouseup',function(){upd('m')});
  addEventListener('mousemove',function(){upd('mm')});
  // Counted, not logged: the engine's console buffer keeps only the newest 60 lines and this app
  // logs continuously, so an early throw would be evicted before the assertion ever ran.
  addEventListener('error',function(){errs++});
  upd('boot');
})();<\/script>`;

// alt=1 ctrl=2 meta=4 shift=8 — the engine's own modifier bitmask (see _dispatchEvent)
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const press = (key, code, keyCode, modifiers = 0) => {
  const printable = key.length === 1 && !(modifiers & (MOD.ctrl | MOD.meta));
  return [
    { kind: 'key', type: 'down', key, code, keyCode, text: printable ? key : '', modifiers },
    { kind: 'key', type: 'up', key, code, keyCode, modifiers },
  ];
};
// "gado" — the tail of "obrigado". Short on purpose; "ga" is the whole reproduction.
const WORD = [['g', 'KeyG', 71], ['a', 'KeyA', 65], ['d', 'KeyD', 68], ['o', 'KeyO', 79]];

// Boots the real artifact in a real Chrome, hands the body a driver, and always tears down.
// Returns false when there is genuinely no browser to drive; a present-but-broken Chrome fails.
async function drive(t, body) {
  if (!fs.existsSync(APP)) { t.skip('dist/index.html not built'); return; }
  // The probe goes at the START of body so it is never pushed out of anything that reads the
  // document in order.
  const html = fs.readFileSync(APP, 'utf8').replace(/(<body[^>]*>)/i, '$1' + PROBE);
  assert.ok(html.includes('id="cfsink"'), 'the observer was not injected');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const started = await Webengine.start();
  if (!started.ok) {
    server.close();
    if (!Webengine.status().bin) { t.skip('no Chrome on this machine'); return; }
    assert.fail('engine would not start: ' + started.error);
  }

  let tab = null;
  // Nudge, then read. The nudge is a bare mousemove over an inert corner: it opens nothing and
  // clicks nothing, but it makes the observer rewrite the title AFTER the app has finished
  // reacting. Without it a negative assertion ("no panel opened") could pass on a title written
  // before the panel appeared. Each read is raced so a stuck renderer costs seconds, not minutes.
  const state = async () => {
    for (let i = 0; i < 12; i++) {
      await race(Webengine.input({ id: tab.id, events: [{ kind: 'mouse', type: 'move', x: 4, y: 4 }] }), 4000);
      await sleep(90);
      const r = await race(Webengine.read({ id: tab.id, maxChars: 1 }), 4000);
      const m = /^cfstate (\S+) p=(\d+) pal=(\d) keys=(\d) ae=(\S*) err=(\d+)/.exec(String((r && r.title) || ''));
      if (m) return { tag: m[1], panels: +m[2], pal: +m[3], keys: +m[4], focus: m[5], errors: +m[6], raw: m[0] };
    }
    assert.fail('the observer never reported');
  };

  try {
    tab = await Webengine.open({ url: `http://127.0.0.1:${server.address().port}/` });
    assert.ok(tab.ok, 'the app would not load');
    await Webengine.setViewport({ id: tab.id, width: 1280, height: 800 });
    await sleep(2500);
    await body({
      state,
      click: async (x, y) => { await Webengine.click({ id: tab.id, x, y }); await sleep(250); return state(); },
      send: async (...events) => {
        for (const ev of events) { await race(Webengine.input({ id: tab.id, events: ev }), 4000); await sleep(60); }
        await sleep(250);
        return state();
      },
      sink: [SINK.x + SINK.w / 2, SINK.y + SINK.h / 2],
    });
  } finally {
    await Webengine.stop().catch(() => {});
    server.close();
    await sleep(300);
  }
}

test('a key typed into a page surface is text, never a command', async (t) => {
  await drive(t, async ({ state, click, send, sink }) => {
    const base = await click(900, 700); // empty grid — nothing focused
    assert.equal(base.errors, 0, 'the app threw while booting — ' + base.raw);
    assert.equal(base.focus, 'BODY', 'the grid click should leave focus on the body — ' + base.raw);

    // Clicking into a web page is exactly this: a focusable page surface takes focus.
    const onSink = await click(...sink);
    assert.equal(onSink.focus, 'cfsink', 'the click did not focus the page surface — ' + onSink.raw);

    // The bug as the owner hit it: a Portuguese word carrying "ga" used to open CODE mid-word.
    const typed = await send(...WORD.map((c) => press(c[0], c[1], c[2])));
    assert.equal(typed.panels, onSink.panels, 'typing "gado" into a page must not open a panel — ' + typed.raw);
    assert.equal(typed.keys, 0, 'typing "gado" into a page must not open the shortcuts overlay — ' + typed.raw);

    const q = await send(press('?', 'Slash', 0));
    assert.equal(q.keys, 0, '"?" typed into a page must not open the shortcuts overlay — ' + q.raw);

    // ⌥2 is how "@" is typed on this Portuguese keyboard.
    const at = await send(press('@', 'Digit2', 0, MOD.alt));
    assert.equal(at.panels, onSink.panels, 'typing "@" must not open a panel — ' + at.raw);
    assert.equal(at.pal, 0, 'typing "@" must not open the palette — ' + at.raw);
    assert.equal(at.keys, 0, 'typing "@" must not open the shortcuts overlay — ' + at.raw);
    assert.equal(at.errors, 0, 'the app threw during the run — ' + at.raw);
  });
});

test('the command palette answers ⌘K only, and only its own box', async (t) => {
  await drive(t, async ({ click, send, sink }) => {
    const onSink = await click(...sink);
    assert.equal(onSink.focus, 'cfsink', 'the click did not focus the page surface — ' + onSink.raw);

    // ⌃K is "delete to end of line" on macOS — a text-editing key, never a palette.
    const ctrlK = await send(press('k', 'KeyK', 75, MOD.ctrl));
    assert.equal(ctrlK.pal, 0, '⌃K must not open the command palette on macOS — ' + ctrlK.raw);

    const cmdK = await send(press('k', 'KeyK', 75, MOD.meta));
    assert.equal(cmdK.pal, 1, '⌘K must still open the command palette — ' + cmdK.raw);
    assert.equal(cmdK.focus, 'palinput', 'the palette must take focus when it opens — ' + cmdK.raw);

    // The sink sits above the palette (max z-index), so this click lands on a page surface with
    // the palette still open — the exact state that used to run whichever entry was selected.
    const armed = await click(...sink);
    assert.equal(armed.pal, 1, 'the palette should still be open for this check — ' + armed.raw);
    const entered = await send(press('Enter', 'Enter', 13));
    assert.equal(entered.panels, armed.panels, 'Enter outside the palette box must not run an entry — ' + entered.raw);
    assert.equal(entered.errors, 0, 'the app threw during the run — ' + entered.raw);
  });
});

test('the g-chord still opens a panel from the app\'s own surface', async (t) => {
  await drive(t, async ({ click, send }) => {
    const base = await click(900, 700);
    assert.equal(base.focus, 'BODY', 'the grid click should leave focus on the body — ' + base.raw);
    const chorded = await send(press('g', 'KeyG', 71), press('a', 'KeyA', 65));
    assert.equal(chorded.panels, base.panels + 1, 'g→a must still open CODE from the grid — ' + chorded.raw);
    assert.equal(chorded.errors, 0, 'the app threw during the run — ' + chorded.raw);
  });
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
