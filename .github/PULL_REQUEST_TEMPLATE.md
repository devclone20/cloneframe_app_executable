<!-- Keep this short. What the user would have hit beats what you changed. -->

## First — what this repository can take

This repository publishes the **built** app. `index.html` is generated from sources that
are not here, so a patch against it cannot be merged: the next release would overwrite
it. If you found something wrong in the interface, an **issue** is worth far more than a
diff — say what you did and what happened.

What IS reviewable here:

- **`bridge/`** — the local daemon, every line of it. The half that touches your machine.
- **`docs/`, `README.md`, `KNOWN-ISSUES.md`, `SECURITY.md`** — if something published here
  is wrong, misleading or out of date, that is a bug and this is its fix.
- **`install.command`, `uninstall.command`, `Dockerfile`** — how people get it running.

One caveat, up front rather than after you have done the work: this repository is
downstream of the maintainer's tree. A merged change to `bridge/` is replayed upstream and
returns on the next release. Not lost — but not merged in place.

## What this fixes

<!-- One or two sentences, in terms of consequence. Link the issue if there is one. -->

## How you know it works

<!--
The house rule, unchanged: watch it fail FIRST. The daemon runs on its own —
`cd bridge && npm install && node hub-bridge.mjs` — so paste what you actually saw,
before and after. That is the whole review for most PRs.
-->

```
```

- [ ] I ran it, rather than reasoning about it
- [ ] I saw the old behaviour before the fix

## Anything else

<!--
Screenshots for anything visual. If this adds a dependency, say why here — the daemon's
core is Node built-ins and every add-on sits behind a guarded import, on purpose.
-->
