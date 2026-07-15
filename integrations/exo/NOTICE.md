# EXO — third-party engine (vendored as git submodule)

- **Origin:** https://github.com/exo-explore/exo
- **License:** Apache-2.0
- **Role in CLONE FRAME HUB:** distributed local-inference cluster, surfaced in the
  **LAB** frame.
- **Integration boundary:** used **unmodified** via its HTTP server / CLI. The bridge
  adapter (`bridge/exo.mjs`) talks to the exo process over loopback
  (`http://127.0.0.1:52415`) and manages its lifecycle (install / launch / stop). No
  exo source is copied into this app and no exo code is linked in-process.
- **Version pin:** recorded by the submodule gitlink at ship time (see
  `THIRD-PARTY-NOTICES.md` for the `git submodule add` step). Informational reference
  commit at authoring time (2026-07-14): `b5375f8c`; latest tag `v0.0.10-alpha`.

## Attribution / license obligations

This directory is populated at ship time by `git submodule add`, which brings in the
upstream `LICENSE` and `NOTICE` files verbatim. Apache-2.0 §4(d) requires propagating
the upstream `NOTICE` — keep `apps/exo/LICENSE` and `apps/exo/NOTICE` (the upstream
one) intact. This file documents *our* use of exo; it does not replace the upstream
notice.

Copyright © the exo-explore authors. Licensed under the Apache License, Version 2.0.
