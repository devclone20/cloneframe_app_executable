# Contributing

Thank you for looking. This file is short on ceremony and specific about the two
things that will actually trip you up: **the build is a splice, and `dist/` is
generated.**

## Run it

You do not need to build anything to run the app. A fresh clone ships the built
artifact.

```bash
cd bridge && npm install     # 5 small add-ons; everything else is Node built-ins
```

Those five are `ws` and `node-pty` (the live terminal) and `imapflow`, `mailparser`,
`nodemailer` (email). Every one is behind a guarded import — the daemon boots without
any of them and simply reports the feature as unavailable, which is why a machine that
cannot build `node-pty` still gets a working app.

Then launch the app the way the README describes. That is the whole setup for
running.

## Build it

Only needed if you are changing the app.

```bash
npm install        # repo root — esbuild, for the build step
npm run build      # web/index.html + web/panels/*.js  →  dist/index.html
```

Then, so the double-click artifact matches what you built:

```bash
cp dist/index.html index.html
shasum -a 256 dist/index.html | awk '{print $1}' > tools/golden/index.sha256
```

Re-freezing the golden hash is a **deliberate act**. A test fails if `dist/` drifts
from it, on purpose — that test is what makes the published app reproducible from
source, so re-freeze it in the same commit as the change that caused it, never as a
tidy-up.

## The gates

All four must be green before anything ships.

```bash
npm test              # runs the build first (pretest), then the whole suite
npm run build:check   # the build is deterministic and the splice is intact
npm run smoke         # a real bridge boots on a dev port and dispatches
```

Plus: every inline script in `dist/index.html` must parse. `npm test` covers it.

## The two rules that are not style

**1 · Never edit `dist/index.html` or the root `index.html`.** Both are generated.
`tools/build.mjs` regenerates them from `web/`, so an edit there is erased by the
next build — silently, and usually after you have stopped looking. Source lives in:

```
web/index.html          the shell, the CSS, the DEFS panel table
web/panels/*.js         one file per panel
web/scripts/core/*.js   the kernel
bridge/*.mjs            the daemon, one module per concern
```

**2 · One writer per file.** `web/index.html` is a single file into which every
panel is spliced *as raw text, into one shared scope*. Two people editing it at once
corrupts panels neither of them was looking at — this has happened and it was
expensive. If you are working with an agent or a team, agents propose patches and
one person applies them.

A consequence worth knowing before it bites: `web/panels/harness.js` **closes the
`Panels` IIFE partway through itself.** Code after that point sees only the public
API (`Panels.openPanel`, `.has`, `.catalog`, `.layer`, `.top`). A bare `DEFS` or
`REG` there is silently `undefined`, not an error.

## Tests

The house rule, and the one thing we will ask about in review:

> **Watch your test fail against the old code first.**

A test written after the fix, that has never been red, proves only that you can
describe what you just did. Several tests in this suite exist because the fix was
right and the test was not.

Pin the **contract**, not the implementation. A test that asserts the exact call you
happened to write goes red the moment someone routes it correctly through a shared
helper — that is a false alarm with a maintenance cost, and we have written two of
them by accident.

Behavioural tests beat static ones where they are possible: several here run against
a real `zsh`, real files, the real cron engine, and the real modules on a scratch
`HOME`.

```bash
node --test tests/one-thing.test.mjs      # a single file, while you iterate
```

## Commits

- One concern per commit, and say what the user would have hit — not what you
  changed. `git log` here reads as a record of consequences.
- Use `git commit -F <file>` when the message has backticks or `$`. Inside
  `-m "…"` your shell will run them.
- No secrets, ever: no API keys, no pairing tokens, no machine paths with a username
  in them. There is a sterilisation gate and it will catch you, but do not make it.

## Security

Do not open a public issue with a working exploit. `SECURITY.md` has the reporting
path and what to expect.

## What we will say no to

- A dependency added for something Node already does. This app is deliberately close
  to zero-dependency; every one you add is one every user has to trust.
- A change that makes the app phone home, or that ships a key of ours.
- A visual addition — a new tab, a new button, a new panel — without a conversation
  first. The surface is deliberate and small.
