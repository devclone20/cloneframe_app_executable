# CLONE FRAME pi themes

Color schemes for CLONE FRAME's pi coding agent TUI (the CODE / iT surfaces).
Ported from disler/pi-vs-claude-code (`.pi/themes/`), MIT © 2026 IndyDevDan — the JSON is data,
carried over as-is.

## Shipped themes
| file | vibe |
|---|---|
| `tokyo-night.json` | deep indigo night, blue accent |
| `everforest.json`  | muted forest greens, green accent |
| `dracula.json`     | classic purple/pink dark, purple accent |
| `synthwave.json`   | neon cyan/pink retro-wave, cyan accent |

## Format (semantic conventions)
A theme is a single JSON file with three top-level keys:

```jsonc
{
  "$schema": "…theme-schema.json",   // editor validation
  "name": "tokyo-night",              // must match the intended /settings selection
  "vars":   { … },                    // your palette, defined once
  "colors": { … }                     // the 51 semantic tokens, each → a var name or a raw value
}
```

- **`vars`** — a reusable palette (`"blue": "#7eaaff"`). Define each color once here.
- **`colors`** — the 51 required semantic tokens. Each value is either a `vars` key (`"accent": "blue"`),
  a raw hex (`"#4a9e6a"`), a 256-color index (`"0"`–`"255"`), or `""` for the terminal default.

### The 51 tokens, by group
- **Core UI (11)** — accent, border, borderAccent, borderMuted, success, error, warning, muted, dim, text, thinkingText
- **Backgrounds & content (11)** — selectedBg, userMessageBg, userMessageText, customMessageBg, customMessageText, customMessageLabel, toolPendingBg, toolSuccessBg, toolErrorBg, toolTitle, toolOutput
- **Markdown (10)** — mdHeading, mdLink, mdLinkUrl, mdCode, mdCodeBlock, mdCodeBlockBorder, mdQuote, mdQuoteBorder, mdHr, mdListBullet
- **Tool diffs (3)** — toolDiffAdded, toolDiffRemoved, toolDiffContext
- **Syntax highlighting (9)** — syntaxComment, syntaxKeyword, syntaxFunction, syntaxVariable, syntaxString, syntaxNumber, syntaxType, syntaxOperator, syntaxPunctuation
- **Thinking borders (6)** — thinkingOff, thinkingMinimal, thinkingLow, thinkingMedium, thinkingHigh, thinkingXhigh
- **Bash mode (1)** — bashMode

Every one of the 51 must be present — pi does not fall back for missing tokens.

## Locations & selection
- Project: `agent/.pi/themes/*.json` (here). Global: `~/.pi/agent/themes/*.json`.
- Select via `/settings` in the TUI, or set `"theme": "tokyo-night"` in `.pi/settings.json`.
- **Hot reload**: editing the *active* custom theme reloads live — good for tuning `vars`.

## Dormant by default
These themes are just files in the workspace; none is auto-selected. The owner (or the theme-expert,
on request) picks one. Adding one to `settings.json` is the only thing that makes a theme active.
