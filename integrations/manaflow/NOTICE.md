# Manaflow — third-party engine (vendored as git submodule)

- **Origin:** https://github.com/manaflow-ai/manaflow
- **License:** MIT
- **Role in CLONE FRAME HUB:** parallel coding agents / workspaces, surfaced in the
  **CODE** frame.
- **Integration boundary:** used **unmodified** via its CLI / local servers. The
  bridge adapter talks to it over its local transport and manages its lifecycle; no
  Manaflow source is copied into this app and no code is linked in-process.
- **Version pin:** recorded by the submodule gitlink at ship time (see
  `THIRD-PARTY-NOTICES.md` for the `git submodule add` step). Informational reference
  commit at authoring time (2026-07-14): `23e83e46`.

> Note: Manaflow (MIT) is a different project from `manaflow-ai/cmux` (the GPL-licensed
> Ghostty-based terminal). This integration uses **Manaflow (MIT)** — do not substitute
> the cmux repo here.

## Attribution / license obligations

This directory is populated at ship time by `git submodule add`, which brings in the
upstream `LICENSE` verbatim. Keep `apps/manaflow/LICENSE` intact. This file documents
*our* use of Manaflow; it does not replace the upstream license.

Copyright © the Manaflow authors (manaflow-ai). Licensed under the MIT License.
