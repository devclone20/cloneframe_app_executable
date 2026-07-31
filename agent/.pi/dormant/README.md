# Dormant extensions — opt-in only

These extensions are NOT auto-loaded (they live outside `.pi/extensions/`, which pi
auto-discovers). The owner arms them via the L9 `guardrails` skill / on request:
the skill copies the file into `.pi/extensions/` and (if needed) registers it in
`.pi/settings.json`, then a relaunch loads it.

- `pi-pi.ts` — the pi-pi meta-agent (`query_experts` parallel fan-out over the
  `agents/experts/` personas). Advanced tooling: it adds session hooks and needs
  `@earendil-works/pi-tui`, so it stays off until the owner enables the workshop.

Ported from disler/pi-vs-claude-code (MIT · IndyDevDan). `damage-control.ts` stays in
`.pi/extensions/` on purpose: it self-gates (a true no-op unless the owner drops a
rules file at `~/.clone-frame-hub/guardrails/damage-control-rules.yaml`).
