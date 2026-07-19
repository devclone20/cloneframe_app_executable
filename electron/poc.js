// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — Electron browser PROOF-OF-CONCEPT (throwaway, decisive test)
//
// The one load-bearing assumption behind the whole "real in-app browser + Google
// login" plan: that a top-level Electron WebContentsView (NOT an iframe) with a
// normal branded-Chrome UA is accepted by Google's 2026 sign-in — i.e. it does NOT
// return the "this browser or app may not be secure" / disallowed_useragent block
// that kills iframes and webviews. This script proves it before any real integration:
//   • loads the CLONE FRAME app shell on the left (proving the app runs under Electron)
//   • mounts a real WebContentsView on the right, pointed at Google sign-in
//   • inspects the page to decide blocked-vs-interactive, writes a verdict file
//   • stays open so a human can actually complete a sign-in
// Run: npm run poc   (bridge must be up on 127.0.0.1:8765)
// ─────────────────────────────────────────────────────────────────────────────
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('fs');
const path = require('path');

// A genuine, current branded-Chrome UA — no "Electron"/"HeadlessChrome" token, which
// is what Google's automation/embedded gate keys off of.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const VERDICT = path.join(app.getPath('temp'), 'cfhub-electron-verdict.json');
const APP_URL = process.env.CFHUB_URL || 'http://127.0.0.1:8765';
const GOOGLE = 'https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&hl=en';

// Never advertise automation — the whole point is to look like a normal user's Chrome.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.userAgentFallback = CHROME_UA; // global baseline UA, no "Electron" token anywhere

// Client-hints spoof: Electron leaks its brand in Sec-CH-UA, which is how Google's
// server-side gate still fingerprints an embedded browser even when the UA STRING is
// clean. Rewrite the hint headers to a plain Google-Chrome 150 brand list.
function cleanHints(ses) {
  const CH_UA = '"Google Chrome";v="150", "Chromium";v="150", "Not?A_Brand";v="99"';
  const CH_FULL = '"Google Chrome";v="150.0.7871.128", "Chromium";v="150.0.7871.128", "Not?A_Brand";v="99.0.0.0"';
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    h['User-Agent'] = CHROME_UA;
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === 'sec-ch-ua') h[k] = CH_UA;
      else if (lk === 'sec-ch-ua-full-version-list') h[k] = CH_FULL;
      else if (lk === 'sec-ch-ua-full-version') h[k] = '"150.0.7871.128"';
      else if (lk === 'sec-ch-ua-mobile') h[k] = '?0';
      else if (lk === 'sec-ch-ua-platform') h[k] = '"macOS"';
    }
    cb({ requestHeaders: h });
  });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1480, height: 920, title: 'CLONE FRAME — Electron browser POC',
    backgroundColor: '#0d1117',
  });

  // Left: the CLONE FRAME app shell itself, running under Electron (renderer).
  win.loadURL(APP_URL);

  // Right: a REAL top-level web-contents (not an iframe) in an isolated, persistent
  // session partition — its own cookie jar that a Google sign-in can actually write to.
  const ses = session.fromPartition('persist:cfhub-web');
  ses.setUserAgent(CHROME_UA);
  cleanHints(ses);
  const view = new WebContentsView({ webPreferences: { session: ses } });
  win.contentView.addChildView(view);
  view.webContents.setUserAgent(CHROME_UA);

  const layout = () => {
    const b = win.getContentBounds();
    const half = Math.round(b.width / 2);
    view.setBounds({ x: half, y: 0, width: b.width - half, height: b.height });
  };
  layout();
  win.on('resize', layout);

  try {
    await view.webContents.loadURL(GOOGLE);
  } catch (e) {
    fs.writeFileSync(VERDICT, JSON.stringify({ error: 'loadURL failed: ' + e.message }, null, 2));
  }

  const wc = view.webContents;
  const body = () => wc.executeJavaScript('document.body ? document.body.innerText.slice(0,3000) : ""').catch((e) => 'ERR ' + e.message);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // DECISIVE test — the identifier page loads fine even when blocked; the real gate
  // fires on the AUTH step. Submit a throwaway email and read the outcome:
  //   • "browser may not be secure"            → still BLOCKED  ❌
  //   • "couldn't find your account" / password → browser ACCEPTED ✅ (no creds needed)
  setTimeout(async () => {
    const before = (await body()).toLowerCase();
    let advanced = '';
    try {
      advanced = await wc.executeJavaScript(`(function(){
        var i=document.querySelector('input[type="email"],#identifierId');
        if(!i) return 'no-email-input';
        i.focus(); i.value='cfhub.probe.'+Date.now()+'@example.com';
        i.dispatchEvent(new Event('input',{bubbles:true}));
        var btns=[].slice.call(document.querySelectorAll('button'));
        var next=document.querySelector('#identifierNext button')||btns.find(function(b){return /next|seguinte|próximo/i.test(b.innerText)})||btns[btns.length-1];
        if(next){next.click(); return 'clicked-next'} return 'no-next-button';
      })()`);
    } catch (e) { advanced = 'submit-err ' + e.message; }
    await wait(5000);
    const after = (await body());
    const alo = after.toLowerCase();
    const blocked = /may not be secure|couldn.t sign you in|disallowed_useragent|browser or app may|try using a different|use a supported browser/i.test(alo + '\n' + before);
    const acceptedSignals = /couldn.t find your (google )?account|enter a valid email|wrong password|enter your password|hi\b|welcome/i.test(alo);
    const verdict = {
      when: new Date().toISOString(),
      finalUrl: wc.getURL(),
      title: wc.getTitle(),
      probe: advanced,
      googleAcceptedBrowser: !blocked && (acceptedSignals || /password/i.test(alo)),
      blocked,
      acceptedSignals,
      uaSent: CHROME_UA,
      afterSample: after.replace(/\s+/g, ' ').slice(0, 600),
    };
    fs.writeFileSync(VERDICT, JSON.stringify(verdict, null, 2));
    console.log('CFHUB_VERDICT ' + JSON.stringify(verdict));
  }, 6500);

  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
