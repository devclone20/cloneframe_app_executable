# Browser Runtime — Chrome for Testing

CLONE FRAME bundles **Chrome for Testing**, a Chromium-family browser build published by
Google (via Google Chrome Labs) specifically for automation and testing. It is used here
as the runtime CLONE FRAME launches in, because — unlike branded Google Chrome 142+ — it
still honors `--load-extension`, which is required to load the bundled **Framer** extension
(`integrations/framer`) that powers the in-app browser.

- **Source (official):** https://googlechromelabs.github.io/chrome-for-testing/
- **Binaries:** downloaded on demand by `install.sh` from
  `https://storage.googleapis.com/chrome-for-testing-public/…` (Google's official storage).
- **Not redistributed in this repo** — `install.sh` fetches it at install time; the binary
  is git-ignored. Chrome for Testing is governed by the **Google Chrome for Testing Terms of
  Service**; Chromium's source is BSD-3-Clause. Use of the bundled browser is subject to
  Google's terms.

Chrome for Testing is intended for automated environments; it does not auto-update and is
not a general daily-driver browser. CLONE FRAME uses it solely as its own embedded runtime.
