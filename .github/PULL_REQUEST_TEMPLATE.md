<!-- Keep this short. What the user would have hit beats what you changed. -->

## What this fixes

<!-- One or two sentences, in terms of consequence. Link the issue if there is one. -->

## The test

<!--
The house rule: watch it fail against the old code FIRST.
Paste the red run — that line is the whole review for most PRs.
-->

```
```

- [ ] I saw this test fail against the old code before the fix
- [ ] It pins the **contract**, not the exact call I happened to write

## Gates

- [ ] `npm test`
- [ ] `npm run build:check`
- [ ] `npm run smoke`

## The two rules

- [ ] I did not edit `dist/index.html` or the root `index.html` — both are generated
- [ ] If the golden hash moved, I re-froze it **in this PR**, because of this change

## Anything else

<!--
Screenshots for anything visual. If this adds a dependency, or a new tab / button /
panel, say why here — both need a conversation, and it is cheaper to have it now.
-->
