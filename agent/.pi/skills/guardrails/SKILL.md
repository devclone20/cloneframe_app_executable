---
name: guardrails
description: Install, customize, or remove safety guardrails for the pi agent — ONLY on the owner's explicit request. CLONE FRAME ships YOLO (the anti-wipe limit is the only factory guard); this skill arms extra guardrails from three sources when the owner asks. Use when the owner says "install guardrails", "add a safety rule", "protect X", "make it confirm before Y", or "remove the guardrails".
---

# Guardrails — opt-in safety, on the owner's command

CLONE FRAME's pi is **YOLO by default**: no sandbox, no per-command approval, the anti-wipe guard
(`rm -rf /` · `mkfs` · `dd`-to-disk) the ONLY hard limit. **Never install a guardrail on your own.**
This skill exists for one situation: the owner explicitly asks for extra safety. Then you arm it,
customize it to their taste, and remove it just as readily when they say so.

Three sources, in order of preference:

## Source 1 — the built-in damage-control pack (ported, ready)

A production-grade declarative guard (ported from disler/pi-vs-claude-code, MIT) ships **dormant**
in `~/.clone-frame-hub/agent/.pi/dormant/damage-control.ts`, with a full example ruleset in
`~/.clone-frame-hub/agent/.pi/guardrails/damage-control-rules.EXAMPLE.yaml` (~90 patterns:
destructive git, chmod 777, cloud-CLI deletes, SQL DROP/TRUNCATE without WHERE, plus zero-access
paths like `.env`/`~/.ssh`/keys, read-only lockfiles, and no-delete `.git`/README/CI). To arm it:

```bash
# 1) drop a live rules file at the owner's opt-in path (edit to taste first)
mkdir -p ~/.clone-frame-hub/guardrails
cp ~/.clone-frame-hub/agent/.pi/guardrails/damage-control-rules.EXAMPLE.yaml \
   ~/.clone-frame-hub/guardrails/damage-control-rules.yaml
# 2) move the extension into the auto-loaded folder AND register it
cp ~/.clone-frame-hub/agent/.pi/dormant/damage-control.ts \
   ~/.clone-frame-hub/agent/.pi/extensions/damage-control.ts
# 3) it imports the `yaml` package — make sure it resolves for pi:
pi install npm:yaml        # (respect the §10 14-day quarantine before installing)
```
Then add `"extensions/damage-control.ts"` to `~/.clone-frame-hub/agent/.pi/settings.json` and
relaunch pi. The extension self-gates: with the rules file present it blocks/asks per rule and
logs to the session; remove the rules file (or the extension line) to disarm.

**Customize:** edit `~/.clone-frame-hub/guardrails/damage-control-rules.yaml` — each
`bashToolPatterns` entry is `{pattern: <regex>, reason: <text>, ask?: true}` (`ask:true` prompts
instead of hard-blocking; on a headless surface with no UI, `ask` rules block to be safe).
Add/remove `zeroAccessPaths`, `readOnlyPaths`, `noDeletePaths` to taste.

## Source 2 — a bespoke guardrail you write

For a rule the pack doesn't cover, forge a small extension (the workshop, §9): a default-export
`(pi) => {}` that wires `pi.on("tool_call")` / `pi.on("user_bash")` and returns
`{block:true, reason}` (or uses `ctx.ui.confirm` for an ask). Write it to
`~/.clone-frame-hub/agent/.pi/extensions/<name>.ts`, register it in `settings.json`, relaunch.
Examples the owner might ask for: confirm-before-delete, protected paths, a network-egress limit,
an email-send approval. Keep each guard tiny and single-purpose.

## Source 3 — the official pi.dev ecosystem

The owner may want a published guardrail, a security config, or even a **bypass** (loosening a
default). Install from the official ecosystem and obey:

```bash
pi install npm:<package>       # a pi extension/package from the registry
```
Respect the **§10 14-day quarantine** on every install — verify the package age first; the owner's
explicit request IS the override for that gate, but tell them the age. Whatever they ask —
tightening or loosening — install it and obey.

## Removing guardrails

Just as readily: delete the rules file, remove the extension from `settings.json` (and delete the
`.ts` if they want it gone), relaunch. Report what you removed. **Factory state is YOLO** — leaving
it that way is always a valid answer.

## The one line that never moves
The anti-wipe guard (`lib/anti-wipe-core.ts`, wired in `clone-frame.ts` and carried by every fleet
child) is NOT a guardrail you can remove — it is the machine's permanent seatbelt. Everything else
here is the owner's choice, on and off at their word.
