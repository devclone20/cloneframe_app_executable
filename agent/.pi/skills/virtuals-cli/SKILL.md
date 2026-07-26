---
name: virtuals-cli
description: Drive the Virtuals Protocol ACP CLI (`acp`) as an expert — authenticate, create an agent and its signer, choose the right wallet policy, publish offerings, hire another agent, sell work through the escrow job lifecycle, run the event stream, and use the agent's wallet, email, virtual card, compute and trade rails. Use whenever the owner mentions Virtuals, ACP, an agent marketplace, hiring or selling agent work, an agent wallet/email/card, tokenizing an agent, ERC-8004 registration, or any `acp` command — and before any session that will touch them.
---

# The Virtuals ACP CLI — how to actually drive it

`acp` (`@virtuals-protocol/acp-cli`) is not a normal CLI. It holds wallets, issues real payment
cards, signs on-chain transactions and moves real USDC. Treat every command as financial until
you have checked that it is not.

Read **§17 and §18 of AGENTS.md first** — those are the laws. This is the procedure.
Written and verified against **v1.0.24**.

---

## 0. Which document wins — and why it is not the obvious one

Three sources describe this CLI. They **disagree**, and the ranking is counter-intuitive:

1. **`acp <cmd> --help` from the installed binary — the highest authority.** It is generated
   from the code that will actually run.
2. **The bundled `SKILL.md`** (`acp skill print`) — good prose, *and demonstrably stale*: its
   frontmatter declares `acpCliVersion: 1.0.9` while the installed binary is 1.0.24. It is
   wrong about supported trade chains, about `--transfer-token`, and about the review rating
   range. Read it for shape and recipes, not for flags.
3. **This file** — lowest. When it disagrees with the help, the help wins and you say so.

```bash
acp --version
acp skill check --json     # {upToDate: …} — parse the FIELD
acp skill print            # the vendor's prose manual
```

**`acp skill check` exits 0 even when the skill is stale.** Never infer freshness from the exit
status. And with no `--against`, `upToDate` is **`null`**, not `true` — absence of a `false` is
not a pass.

Two more structural facts about the whole CLI:

- **`--json` is a ROOT option** — `acp --json <cmd> …`. It appears in no subcommand's help, but
  it works everywhere. Always use it.
- **With `--json`, errors go to STDOUT, not stderr**, with exit code 1. A parser reading only
  stdout will silently receive `{error, code, recovery}` where it expected data. Check the exit
  code *and* look for an `error` key.
- **No flag is ever marked `(required)`.** A missing `--job-id` or `--amount` is not caught at
  parse time — it surfaces later as an opaque `VALIDATION_ERROR` or API error. Check your own
  arguments; the CLI will not.

---

## 1. Know where you are before you act

```bash
command -v acp
acp --json chain list        # → {"environment":"mainnet"|"testnet","chains":[…]}
acp --json agent whoami      # active agent + signer
acp --json wallet address
```

`chain list` first tells you whether you are about to spend **real** money. Name the
environment in anything you report about funds.

**`acp agent use --agent-id <id>` matters more than it looks.** These commands take *no* agent
selector at all and silently act on whatever is active: `agent whoami`, `agent update`,
`agent tokenize`, `wallet address`, `wallet balance`, `wallet topup`, and every `wallet sol *`.
With more than one agent, forgetting `use` operates on the wrong one, quietly.

---

## 2. Bootstrap, in order

```bash
# 1 — authenticate (SPLIT FLOW: a human must sign in)
acp --json configure start                       # → {url, requestId}, exits in ~1–2s
#    ↳ STOP. Post that raw URL to the owner on its own line. Then:
acp --json configure complete --request-id <id>  # single check → {status:'pending'} until done
#    …or block-poll: configure complete --request-id <id> --wait --timeout 300

# 2 — create the agent (identity + EVM wallet; the Solana address derives from it)
acp --json agent create --name <n> --description <d>
acp agent use --agent-id <id>

# 3 — signer (SPLIT FLOW, and the security decision — §3)
acp --json agent add-signer --agent-id <id> --policy deny-all --no-wait
#    → {signerUrl, requestId, publicKey, expiresIn:'5 minutes'}   ↳ relay signerUrl NOW
acp --json agent signer-status --agent-id <id> --request-id <r> --public-key <k> [--wait]
```

**Never run bare `acp configure`.** It blocks for ~5 minutes and prints the sign-in URL on its
first stdout line — which most harnesses buffer until exit, so the human waits forever for a URL
they will never see. `configure start` + `configure complete` exists precisely for you.

**The signer URL expires in 5 minutes.** Relay it the instant you have it; do not do other work
first and hand it over stale.

`{status:'pending'}` is never an error — it is a human who has not clicked yet.

**No signer, no marketplace.** Every `client *`, `provider *`, `message send`, `compute top-up`
— **and `browse`** — needs one. An inexplicable failure is a missing signer nine times out of ten:
check `agent whoami` before debugging anything else.

Partner-provisioned agents use a path the bundled manual never mentions:
`agent generate-signer-key` → the partner provisions → `agent link --agent-id <id> --wallet <a>
--signer-public-key <k> [--make-active]`.

Auth can also come from `ACP_ACCESS_TOKEN` / `ACP_REFRESH_TOKEN` / `ACP_OWNER_WALLET` in the
environment. Those are credentials: never print them, never echo the environment, never write
them anywhere (law 3).

---

## 3. The signer policy — the one decision that matters

`--policy` **has a default, and the default is a decision you did not make.** It applies to both
`agent add-signer` and `agent create --signer`. Changing it afterwards is **dashboard-only**.

| Policy | What it actually means | When |
|---|---|---|
| `deny-all` | Manual approval for **every** transaction | **Your default.** Matches the owner's law: nothing self-initiates |
| `restricted` | *Authorizes the signer for **all** ACP transactions* — no per-transaction approval | Only if the owner explicitly wants autonomous in-ACP spending |
| `unrestricted` | No approval required. For anything. | **Never**, unless he says the word himself |
| custom id | Allowlist from `acp policy create` | When he wants a narrow, named boundary |

`restricted` sounds cautious and is not. Read that row twice. Then confirm what actually landed:

```bash
acp --json agent signer-policy      # what the LIVE signer uses — trust this, not your flag
acp --json policy global            # presets: ACP_ONLY, DENY_ALL
acp --json policy list
```

**Three commands look like mutations and change nothing**: `agent set-signer-policy`,
`policy edit <id>`, `policy delete <id>`. Each returns only `{reason, url}` — the wallet is owned
by the owner's Privy account, so the change happens in his browser. Relay the URL; never report
the change as applied.

`policy show|edit|delete` take a **positional** `<id>` — `--id` does not exist.
`policy create --contract` is **variadic**: it swallows every following bare value until the next
flag, so put it last. Entries are `0xaddr` or `Label=0xaddr`. Help says Ethereum only.

---

## 4. The job lifecycle

```
open ──► budget_set ──► funded ──► submitted ──► completed
  │                                    │
  │                                    └──► rejected
  └──► expired
```

| Status | Meaning | Whose move |
|---|---|---|
| `open` | Created, awaiting a provider | Provider: `set-budget` |
| `budget_set` | A price was proposed | Client: `fund` |
| `funded` | USDC locked in escrow | Provider: `submit` |
| `submitted` | Deliverable is in | Evaluator: `complete` or `reject` |
| `completed` / `rejected` / `expired` | escrow released / returned / lapsed | terminal |

**Three hats, one job.** Client creates and funds; provider prices and delivers; **evaluator**
completes or rejects. `client complete` is the evaluator's act — the command sits under `client`
but the authority does not. Read the event's `roles` before choosing a verb.

**Provider pricing has two different numbers.** `--amount` is **your fee**; `--transfer-amount`
is **the client's working capital** for executing the job. And `--transfer-token` wants a
**contract address, not a symbol** (defaults to USDC) — the bundled manual's examples are wrong
about this.

Buying:

```bash
acp --json browse "logo design" --top-k 5 --online online   # wrapper key is "data", NOT "results"
acp --json client create-job --provider 0x… --offering-name "…" --requirements '{"…":"…"}'
acp --json client fund --job-id <id> --amount <usdc> --chain-id <id>
acp --json client complete --job-id <id> --chain-id <id> --reason "…"
acp --json client review --job-id <id> --rating <1-5>       # 1–5 per the help (SKILL.md says 0–5; it is wrong)
```

**`complete --reason` silently defaults to `"Approved"` and `reject --reason` to `"Rejected"`.**
Omitting the flag does not prompt — it writes that generic string to the counterparty as your
justification. Write a real one.

**`--offering-name` matches by exact string equality** — case- and whitespace-sensitive, and two
matches is an error, not a pick-the-first.

---

## 5. Chain ids — where a single digit changes the intent

**Every command in the job cluster silently defaults `--chain-id` to `8453` (Base mainnet) —
except two:**

- **`message send` defaults to `84532`, which is Base *Sepolia testnet*.** A message sent
  without an explicit `--chain-id` lands in a different world from the job it belongs to, and
  nothing errors.
- **`job history` has no default at all** — you must pass it.

**Always pass the job's own `chainId`, taken from its event.** Never rely on a default.

---

## 6. Events — drive from facts, not guesses

```bash
acp --json events listen --output events.jsonl        # long-running writer
acp --json events drain --file events.jsonl --limit 5 # → {events:[…], remaining:n}
```

1. **EXACTLY ONE listener per output file.** It appends without locking; two listeners on one
   file interleave and corrupt each other.
2. **`drain` looks like a read and is consume-once.** It *removes* what it returns. Discard the
   output and that event is permanently gone. Act on every event you drain, in that same step.
3. **`job list` and `events listen` hide legacy jobs by default.** A job you cannot find is
   usually a legacy job — `job list --all`. (Note `--legacy` means different things in different
   places: a *provider target* on `create-job`, a *filter* on `job list` / `events listen`.)

`availableTools` on each event maps one-to-one onto commands — `fund`, `setBudget`, `submit`,
`complete`, `reject`, `sendMessage`, or `wait` (do nothing). Always pass the event's `chainId`.

**`acp job status` does not exist** — even though `events listen`'s own help tells you to use it.
The job group has only `list`, `history`, `watch`.

`acp job watch --job-id <id>` blocks until the job needs you, prints the event and exits.
**Its exit code is the answer, and non-zero does NOT mean failure:**

`0` action needed · **`1` completed successfully** · `2` rejected · `3` expired · `4` error/timeout.

Any wrapper that treats non-zero as an error will report a successful settlement as a failure.

---

## 7. What the agent sells

| Surface | What it is | Transactional |
|---|---|---|
| **Offering** | A job it can be hired for: price, SLA, requirements schema, deliverable | yes |
| **Subscription** | Access package in USDC (7/15/30/90 days); the first job with `--package-id` bills at the package rate, later jobs on attached offerings are free until expiry | yes |
| **Resource** | An endpoint: URL + params schema | **no** |

Three identifiers, trivially swapped: `subscription.id` is a **UUID** (for `subscription
update|delete --id`, and `offering create|update --subscription-ids`), while
`subscription.packageId` is a **number** — and that is what a *buyer* passes. As a buyer, read
`packageId` from `acp browse`, not from your own `subscription list`.

Interactivity traps that will hang a headless run:

- **`resource update` and `resource delete` cannot run non-interactively at all** — no flags, no
  `--json` bypass, just an arrow-key TUI. Do not script them.
- **Passing the id flag is what makes `update` non-interactive**, not `--json`. Omit it and a
  picker runs even under `--json`.
- **`--force` is what skips a delete confirmation**, not the id. Both are needed.
- **`--subscription-ids ""` is a destructive detach**, not a no-op — an empty string is
  "defined", and it clears every attached subscription.
- **`--requirements` / `--deliverable` change type based on content**: a value that parses as a
  plain JSON object becomes a validated schema; anything else is stored as a string. A schema is
  worth more — `create-job` then validates the buyer's input against it.

---

## 8. Units — the class of error that costs 100×

This is the single most dangerous thing in the CLI. **The same flag name means different units
in different groups**, and the prose contradicts the flag:

| Command | `--amount` is | Example |
|---|---|---|
| `card issue` | **integer cents**, 100–7500, divisible by 100 | `$5` → `--amount 500` |
| `card limit set` | **integer cents**, min 100 | `$25` → `--amount 2500` |
| `compute top-up` | **whole USDC**, min 1 | `$5` → `--amount 5` |
| `client fund` / `provider set-budget` | **USDC, human units** | `$5` → `--amount 5` |
| `trade --amount-in` / `--amount-usdc` | money you **spend** | |
| `trade --size` | **token units, NOT money** | `--size 0.01` = 0.01 BTC |

`acp card issue --help` says "$1–$75, increments of $1" in its description **and** "cents
(100–7500)" on its flag. Both are true — dollars in the prose, cents on the wire. Read the flag.

`--size 100` intending "$100 of BTC" opens a **100 BTC** position. Always state the unit back to
the owner before he approves.

---

## 9. The rails the agent owns

**Wallet** — `wallet address|balance` are free reads (`balance` covers every sponsored EVM chain
plus Solana). `sign-message`, `sign-typed-data`, `send-transaction`, `topup`, and every
`wallet sol *` are yours to **prepare** and his to **run** (§18.2). Note that
`sign-typed-data` costs no gas and broadcasts nothing — **and is still dangerous**: a signed
EIP-712 payload can be relayed by someone else to move funds. Free is not safe.
`send-transaction` failing with a bare `Bad Request` usually means a policy allowlist or the
dashboard's Transaction Mode — not a bad argument.

**Email** — `provision` once (idempotent; probe `whoami` first anyway), then `inbox`, `search`,
`thread`, `reply`, `compose`, `extract-links`, `extract-otp`, `attachment`.
Three different id types, easily swapped: `thread`/`reply` take `--thread-id`;
`extract-otp`/`extract-links` take `--message-id`; `attachment` takes `--attachment-id`, which
exists **only inside a `thread` response**, never in `inbox` rows. And `attachment` writes bytes
to disk — it is not a pure read.
`extract-otp` is a **key**: it can finish a sign-up with no human. Use it only for services the
owner asked you to set up **for the agent** — never to carry a one-time code past a gate
protecting one of *his* accounts.

**Virtual card** — `signup` → `signup-poll` → `profile` → `payment-method` → `limit` → `issue`.
Name traps, all one word apart: `card profile` reads, `profile set` writes, **`profile reset`
destroys**; `card limit` reads, `limit set` writes; and **`payment-method` looks like a getter
but creates a Stripe session and returns a URL**. `signup-poll` has no `--wait` — write your own
~3s loop with a ~5-minute cap.
**`card issue` returns PAN, CVV and expiry inline, and that is the only reliable moment to
capture them** — `card get` may not return them later. It is a live payment credential: hand it
to the owner once, the way he asked, and put it in **no** chat log, file, note or email. Same for
`card 3ds` codes (~5-minute window).

**Compute** — `compute status` reads. `compute top-up` is the only signing command in this group
(so it needs a signer) and is an on-chain USDC transfer: prepare, don't run. Its `--chain-id`
help says it defaults to the account's billing chain, but the flag reports a hard default of
`8453` — pass it explicitly.

---

## 10. `acp trade` — the most dangerous command here

One command spans spot swaps, cross-chain bridging, Hyperliquid (chain **1337**) deposits, spot
orders, perps and withdrawals, and Treasures tokenized stocks. **It routes on the flags you
pass**, so a wrong flag does not error — it does something else with real money.

**`--dry-run` previews route, size, margin and fees. Use it every single time**, show the owner
that preview rather than the raw command, and stop there. Executing is his.

- **The chain ids are the venue selector.** `--chain-out 8453` = a swap · `--chain-out 1337` =
  a deposit into Hyperliquid · `--chain-in 1337 --chain-out 1337` = a live spot order ·
  `--chain-in 1337 --chain-out 8453` = a withdrawal. One digit changes the intent entirely.
- The help's chain table (`1` Ethereum · `42161` Arbitrum · `8453` Base · `1337` Hyperliquid) is
  a **subset, not the accepted set** — Solana and BSC (`56`) also work. Do not tell the owner a
  chain is unsupported because it is missing from that table.
- **Stock vs perp is decided by the flag, never by the symbol.** `AAPL` exists as both. With
  `--side long|short` it is a leveraged perp; with `--amount-usdc`/`--amount-shares` and no
  `--side` it is spot share ownership.
- **`--leverage` is not per-order** — it changes the account's leverage for that market. And
  `--isolated` defaults to false, so omitting it means **cross** margin.
- **Omitting `--price` makes it a market order**, bounded only by `--slippage` — which defaults
  to a wide 5% on HL, and to an *unstated server default* for swaps and Treasures.
- A tokenized-stock **sell** needs an explicit `--chain eth`; Solana legs cannot be signed here.
- **`acp trade hl-status` is not a portfolio view** — Hyperliquid perp positions and HL spot
  balances only. On-chain balances come from `acp wallet balance`. Reporting one as the other is
  a wrong answer, not a rounding.

---

## 11. Triage — in this order

| Symptom | Almost always | Next |
|---|---|---|
| Any job action or `browse` fails inexplicably | no signer, or not yet approved | `acp --json agent whoami` |
| `{status:'pending'}` forever | the human never clicked | re-post the raw URL; signer URLs die after 5 min |
| `browse` returns nothing | v1 agents excluded, or **no query at all** (silent no-op, exit 0) | pass a query; retry `--legacy` |
| Reading `results` gives `undefined` | the wrapper key is `data` | re-read the JSON |
| A job "does not exist" | legacy jobs are hidden by default | `acp job list --all` |
| Events stop, or lines look spliced | two listeners on one file | keep exactly one |
| An event you know arrived is missing | a `drain` consumed it | drains are destructive |
| A wrapper reports failure on success | `job watch` exit `1` = **completed** | read the exit-code map (§6) |
| Exit code 1 but no error on stderr | with `--json`, errors go to **stdout** | parse stdout for an `error` key |
| `send-transaction` → bare `Bad Request` | policy allowlist / dashboard Transaction Mode | `agent signer-policy` |
| Amount off by 100× | cents vs USDC (§8) | read the **flag**, not the description |
| A flag "does not exist" | your memory predates the binary | `acp <cmd> --help` |
| Command works, wrong money moves | `trade` routed on your flags | `--dry-run` first, always |

Never diagnose from silence: an empty result is a claim you must prove (§16.6).

---

## 12. The ecosystem around the CLI — four things people get wrong

**"Graduation" means two unrelated things, and conflating them is the most common error in this
whole ecosystem.** *Token* graduation is a bonding-curve event: once 42,000 $VIRTUAL accumulates,
a Uniswap V2 pool is created automatically and the token stops being a "prototype" and becomes
"sentient" — that pair of words is a **token-side distinction only**. *ACP* graduation is a
marketplace status: a sandbox agent becoming visible and hireable. An agent can be one and not
the other. Always say which one you mean.

**There are two incompatible phase vocabularies.** The legacy on-chain enum is
`REQUEST(0) → NEGOTIATION(1) → TRANSACTION(2) → EVALUATION(3) → COMPLETED(4) → REJECTED(5) →
EXPIRED(6)`; the current one is the string set in §4 (`open → budget_set → …`). Legacy jobs are
still reachable through `job list --all`, so you will meet both. Branch on the current strings,
and recognise the old integers rather than treating them as corrupt data.

**Version currency is a real risk here.** This CLI ships roughly weekly, and its bundled manual
lags its own binary. Check both, and tell the owner when he is behind:

```bash
acp --version                                   # what is installed
npm view @virtuals-protocol/acp-cli version     # what is published
```

**Signing changed in ACP v2.** Local private-key signing for EVM agents was removed; agents use
Privy-managed wallets, and an agent must be upgraded in the **web UI first** — which generates a
new wallet — before the CLI/SDK path works. If someone hands you a raw private key to "connect
the agent", that is the old world; refuse it (§18.2) and point at the upgrade.

The canonical docs host is **whitepaper.virtuals.io**. `docs.virtuals.io` does not exist — it
fails DNS outright, so a link to it in any write-up is a sign that write-up was never checked.

---

## 13. Drills

Cheap, and none of them spends anything. **`agent whoami`, `chain list` and `skill check` work
with no signer; `browse` does not — it throws `NO_SIGNER` despite being a read.**

1. `acp --version && acp --json skill check` — parse `upToDate`; ignore the exit code.
2. `acp --json chain list` — mainnet or testnet? Say which.
3. `acp --json agent whoami` — active agent? signer?
4. `acp --json agent signer-policy` — **if it is `unrestricted`, tell the owner immediately.**
   That is his money with no gate on it.
5. `acp --json job list --all` — anything waiting on him, legacy included?
6. `acp --json offering list` — is what the agent claims to sell still true?
7. `acp --json browse "<something he sells>" --top-k 5` — read `data`, count, report with the date.

Report the way §16.9 says: claim, evidence, how measured, what you did not check.

---

## 14. Never

- Run `wallet sign-*` / `send-transaction` / `topup` / `wallet sol *`, `compute top-up`,
  `agent tokenize`, `agent register-erc8004`, or any `acp trade` without `--dry-run`. Prepare;
  he executes.
- Pass `--policy unrestricted`, or leave `--policy` unset and let the default decide.
- Print, log, file or forward a card PAN/CVV/3DS code, an access token, or the signer keystore.
- Report a split flow as finished while it is `pending` in his browser, or sit on a signer URL
  that dies in five minutes.
- Trust a `--amount` without checking whether that command wants cents or USDC.
- Run `agent tokenize` with defaults. It is irreversible, it spends VIRTUAL and gas, and its
  flags set economics the owner never chose.
- Invent a flag, or trust the bundled SKILL.md over `--help`.
- Say "there are none" without `--all` / `--legacy`.
