# 05 — `ok:true` is not truth

Task: create a note and PROVE it exists on the live screen. Two lessons, both paid for in real failures.

**The 400.** My first call was `notes.add({title, content})` → `HUB Bridge HTTP 400`. I had guessed
the API shape. I stopped guessing and READ THE CONTRACT: `web/panels/notes.js` and `bridge/notes.mjs`
showed the real signature — `notes.create({title, body, tags})`. Field names matter: `add`≠`create`,
`content`≠`body`. The corrected call returned `{ok:true, id:…}`.

**`ok:true` proves the RPC didn't error — not that the thing is true.** So I verified for real:
- `notes.get(id)` → exact title + body read back through the app.
- `notes.list` → the note at the top of the live list.
- `read_screen` → NOTES panel open + focused.

**Honest limitation:** `web_screenshot` returned `no tab open` — it photographs the in-app BROWSER,
not native panels. I could not produce a pixel screenshot of NOTES, and I SAID SO rather than fake proof.
State + content read-back was my proof instead. Report the failure and the limit; never paper over them.

Rule from now on: read the module contract BEFORE the first state-changing call, and never say "done"
on `ok:true` alone — verify by reading the result back through the app, and report any limit truthfully.
