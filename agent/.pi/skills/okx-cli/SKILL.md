---
name: okx-cli
version: 1.0.0
description: Drive the OKX `onchainos` CLI (Onchain OS / Agentic Wallet) as an expert — wallet login and accounts, balances and portfolio, DEX swaps and cross-chain bridges, limit-order strategies, DeFi, the ERC-8004 agent registry and its task marketplace, x402 payments, and the security scanners. Use whenever the owner mentions OKX, onchainos, Onchain OS, the agentic wallet, an OKX agent or ASP, a task with a budget, x402 or a 402-gated API, a swap or bridge on OKX, or any `onchainos` command.
---

# The OKX `onchainos` CLI — how to actually drive it

Read **§17 of AGENTS.md** for the law and the `agentic-economy` skill for the map. This is the
procedure. Verified against **onchainos 4.2.0**.

`onchainos` is wired to the owner's **real wallet with real funds across many chains**. It has
24 command groups and no undo. Treat every command as financial until you have checked it isn't.

---

## 0. The tool documents itself — and it has a session-start ritual

```bash
onchainos --version
onchainos preflight --skill-version 1.0.0     # update + verify + drift check, emits JSON
onchainos <group> --help                      # generated from the code that runs — highest authority
```

**`preflight` is this CLI's equivalent of a version check, and it takes _this skill's_ version.**
The `version:` in the frontmatter above is not decoration — pass it verbatim; the CLI uses it for
drift detection and beta routing. Run preflight at the start of any session that will touch OKX,
and if it reports drift, believe it over this file.

Two structural facts:

- **There is no global output-format flag at all** — no `--json`, `--format`, `--output`,
  `--quiet` or `--verbose`, checked across all **218** leaf commands. Unlike `acp`, you cannot
  ask for JSON; output shape varies per command and you read each one's help. A handful state a
  format in their own text — `preflight` ("emit JSON"), `mcp` (JSON-RPC 2.0), `wallet geoblock`,
  `agent asp-match`, `agent prepare-create` — and those are the ones you can parse confidently.
- **The only globals are `--base-url` and `--chain`** (`ethereum`, `solana`, `base`, `bsc`,
  `polygon`, `arbitrum`, `sui`, …), uniform across every leaf. **Never pass `--base-url`** — it
  repoints the CLI at a different backend.

---

## 1. First contact — one command answers everything

```bash
onchainos agent gate-check       # wallet login + agent identity + comms channel
```

Its own help says: *"Pure read-only diagnostic — does not modify any state."* That makes it the
right opening move every time: it tells you whether you are logged in, whether an agent identity
exists, and whether the channel works — before you build a plan on assumptions.

Then, as needed: `onchainos wallet status` · `wallet addresses` · `portfolio total-value`.

---

## 2. Authentication — and the command that does not exist

**There is no `onchainos login`.** It errors with *unrecognized subcommand*. The real flow is
two steps, with a human in the middle:

```bash
onchainos wallet login <email>   # mails a one-time password
#   ↳ STOP. Only the owner can read his inbox. Ask him for the code.
onchainos wallet verify <OTP>    # the code he gives you
```

The app told the owner otherwise for weeks. A wrong command inside a helpful sentence is still a
wrong command — if you catch yourself about to type `onchainos login`, that is this trap.

**The email argument is an optional positional that forks the entire auth model.** With an
email you get the OTP flow above. **Without** one it silently does "AK login" (API key), and the
help does not say whether `verify` is needed on that path. Pass the email explicitly so you know
which flow you are in.

`wallet verify` is a **hard human gate**: the OTP arrives in his inbox and you cannot obtain it.
Stop and ask. Do not loop, do not guess, do not look for it anywhere.

**Account commands that bite:**

- **`wallet add` takes zero arguments and creates an account immediately** — no confirmation, no
  label, no dry-run. A bare, innocent-looking command that permanently changes the account set.
- **`wallet switch <id>` is a silent global state change.** It redefines the `selectedAccountId`
  that `wallet send --from`, `wallet contract-call --from`, `wallet history` and
  `security token-scan` (no-flag mode) all fall back to. **After a switch, every read you took
  before it is stale, and a later send may pay from a different account than you reasoned about.**
- **`wallet logout` clears *all* stored credentials**, not just the active account. Recovery is a
  full human round trip. Never run it "to reset".
- **`wallet qrcode --address` encodes whatever you give it, verbatim, with no validation** — it
  accepts "an address (or any string)". A human scanning a QR you built from a wrong or
  attacker-supplied string sends funds there. Only ever feed it a value that came out of
  `wallet addresses`.

`wallet chains` lists supported chains, cached with a 10-minute refresh — so a chain added in the
last ten minutes may be missing.

---

## 3. Units — read this section before you type a number

This CLI has **no single convention**. The same flag name means different things in adjacent
groups, and nothing warns you. This is where the owner's money actually gets lost.

### 3a. `--slippage` — four conventions, and one of them is 100× the others

| Command | Convention | `0.5` means |
|---|---|---|
| `swap swap` · `swap execute` | **percent** | 0.5 % |
| `cross-chain *` | **decimal, range (0,1]** — help: "0.01 = 1%, **0.5 = 50%**" | **50 %** |
| `defi deposit/redeem/invest/withdraw` | decimal, default `0.01` (= 1 %) | 50 % |
| `strategy create-limit` | percent (`20` or `20%`), **default 15** | 0.5 % |

**`--slippage 0.5` is half a percent on a swap and fifty percent on a bridge.** Verbatim from
the binary, 2026-07-26. Get it backwards on a bridge and you authorise handing over half the
trade. And `strategy create-limit` applies **15 % silently** when you omit the flag — far wider
than every other default here. Always pass it explicitly, and always say the number back as a
percentage in words.

`--max-auto-slippage` (swap group) is percent — "0.5" there is half a percent, next to a
`cross-chain --slippage 0.5` that is fifty. Same file, same session, 100× apart.

### 3b. Amounts — the flag NAME changes between groups

```
wallet send        --amt <minimal units, whole number>  |  --readable-amount <human>   (exclusive)
wallet contract-call --amt <minimal units>              |  NO --readable-amount exists
swap execute       --amount <minimal units>             |  --readable-amount <human>   (exclusive)
defi invest        --amount <minimal units>
defi withdraw      --amount <HUMAN>          ← inverted inside the same group
payment session open/topup  <ATOMIC units>   ← "1000000 for $1 with 6 decimals"
```

`wallet send` uses **`--amt`**; `swap execute` uses **`--amount`**. `wallet contract-call` has
**no** human-units option at all, so the habit you learned on `wallet send` is a bug there. And
`defi` inverts within itself: `invest` is minimal, `withdraw` is human.

### 3c. Everything else that carries an implicit unit

- **Timestamps are milliseconds**, everywhere, including flags named like second-precision ones
  (`--begin`, `--end`, `--since`). A Unix-seconds value silently means 1970.
- **Percentages are 0–100**, never basis points, across the intel groups.
- **Monetary filters are human USD**, not wei and not cents (`--min-amount-usd`, `--min-market-cap-usd`, …).
- **`security tx-scan --value` is WEI as a HEX STRING**, while `wallet send --amt` is a decimal
  string. The same amount is written two different ways when you scan a tx and then send it.
- **`--range-filter` on `token cluster-top-holders` is an ordinal**: 1 = top 10, 2 = top 50,
  3 = top 100. Passing `10` is wrong, and it is required, so nothing catches it.
- **Boolean filters take a value, not presence** — `--has-x true`, not `--has-x`.
- **`token search --chains` defaults to `1,501`** (Ethereum + Solana only). A Base or BSC token
  simply is not found, with **no error**. Absence here is not evidence.

See `agentic-economy` §2 for how this compares with the other two stacks. All three have a units
trap; this one has the most.

---

## 4. The wallet — what reads, what signs

**Free reads:** `wallet status` · `wallet addresses` · `wallet balance` · `wallet history` ·
`wallet chains` · `wallet qrcode` · everything under `portfolio` (`total-value`,
`all-balances`, `token-balances`, `chains`).

**Signs or spends — prepare, never run (§17 law):**
`wallet send` · `wallet sign-message` (personalSign on EVM & Solana, EIP-712 EVM-only) ·
`wallet contract-call` · everything under `swap` except `quote`/`check-approvals`/`chains`/
`liquidity` · `cross-chain` · `gateway` · `strategy create-limit` · `defi` invest/redeem ·
`payment` · `competition join`/`claim`.

**`wallet geoblock`** prints `{"blocked":true|false}` and **exits non-zero on any failure** —
its own help says a skill must treat that as **fail-closed**. A failed check is "blocked", never
"probably fine".

**`wallet send`'s usage line requires only `--recipient` and `--chain`** — *neither* amount flag
is marked required, and the help does not say what happens if you omit both. And `--from`
defaults to whatever `wallet switch` last selected, so the account that pays is ambient state
set somewhere else. State the account and the amount back to the owner before he approves.

**`--force` means two opposite things.** On `wallet balance` it bypasses caches — harmless. On
**`wallet send`, `wallet contract-call` and `wallet sign-message` it skips the backend's risk
warnings**. Never pass it on those three. If a risk warning fired, that is information the owner
is entitled to, not friction to suppress.

**`security sig-scan` vs `wallet sign-message`** — one word apart, opposite consequences.
`sig-scan` *inspects* a message for phishing and touches no key; `sign-message` *signs* it.

**Gas Station** lets the account pay gas in stablecoins: `wallet contract-call` accepts
`--gas-token-address` + `--relayer-id`, plus `--enable-gas-station` the first time. Managed
under `wallet gas-station`. Two things to get right there:

- **`gas-station enable` ≠ `gas-station setup`.** `setup` is the real first-time activation;
  `enable` is a database flag that *requires an existing on-chain 7702 delegation* and fails
  softly without one. `gas-station status` is the only certified read-only one.
- **`gas-station disable` is NOT a revocation.** The 7702 delegation stays on-chain. Never tell
  the owner that disabling it removed the delegation or closed a security exposure — it did not.

---

## 5. Swaps — three commands, one of them moves money

**There are three categories here, not two, and the middle one is where people get careless:**

| Category | Commands | Why it matters |
|---|---|---|
| **Read** | `swap quote` · `check-approvals` · `chains` · `liquidity` | safe; run freely |
| **Loaded gun** — emits *unsigned calldata*, spends nothing by itself | `swap approve` · `swap swap` · `cross-chain approve` | nothing moves when you run it, but the bytes it hands back **spend the moment they are signed**. `approve` calldata grants a router an allowance — an open-ended one if you do not bound it |
| **Fires** — signs and broadcasts | **`swap execute`** · `cross-chain` execute paths · `wallet send` · `wallet contract-call` · `strategy create-limit` | money moves, no undo |

The help text is genuinely ambiguous on the middle row — `swap swap` is described as
"quote → sign → broadcast" yet returns calldata and does neither. **Resolved by testing rather
than by reading:** it does not broadcast. Treat its output as dangerous anyway; a signature is
the only thing standing between that blob and the owner's balance.

`swap execute` is the whole pipeline in one line, with no confirmation step of its own. It is
the single easiest way to spend the owner's money by accident in this entire CLI. Quote first,
show him the quote **and the unit**, and let him say go.

Cross-chain bridging lives in `cross-chain`; limit orders in `strategy` (`create-limit`,
`cancel`, `list`, `resume`).

---

## 6. Agent identity and the task marketplace

Identity: `agent pre-check` (consent + per-wallet uniqueness verdict, role required) →
`agent create` → `agent activate`. Also `update`, `deactivate`, `upload` (avatar), `search`,
`profile`, `get-my-agents` / `my-agents`, `service-list`, `feedback-submit` / `feedback-list`.

**Task status enum — branch on these numbers:**

```
0 created · 1 accepted · 2 submitted · 3 refused · 4 disputed      ← default filter
5–9 terminal states                                                ← --include-terminal
```

**Client side:** `prepare-create` → `create-task` → `asp-match` → `set-asp` →
**`set-payment-mode`** → `confirm-accept` → `complete` (releases payment) or `reject`.
`close` is only valid while the task is Open. Others: `reset-asp`, `user-reject`, `mark-failed`,
`set-public`.

**`set-payment-mode` must run before `confirm-accept`** — the CLI says so outright. Out of order,
the accept fails in a way that will not obviously point at the cause.

**`prepare-create` is your best friend under the owner's law**: it validates fields, runs
gate-check and designated-route, returns structured JSON for a confirmation form — and
**explicitly does NOT create the task**. That is exactly "prepare, he approves, then act".

**Provider side:** `recommend-task` / `find-jobs` → `apply` → `payment` (invoice after
provider_applied) → `asp-claimable` → `asp-claim-rewards`.

**A trap the CLI documents about itself:** `agent tasks` lists tasks you already have —
*"**Do not** use this to find new jobs"*. New work comes from `recommend-task` / `find-jobs`.
Using the wrong one returns an empty list and looks like "no work available".

`agent active-tasks` aggregates non-terminal tasks across **every agent under the active
account**, annotated with `myRole` and `counterpartyAgentId` — the right command when the owner
asks "what is in flight?".

---

## 7. x402 payments — and the one command you must never run

`payment pay` signs a payment authorization for an HTTP 402-gated resource **via TEE**, from the
selected wallet, and returns the assembled `PAYMENT-SIGNATURE` header. That is **x402 v2** — the
header names are `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`; `X-PAYMENT` is v1
and a v1 client gets nothing from a v2 server.

> **`payment pay-local` reads a hex private key from `EVM_PRIVATE_KEY`. Never run it. Never set
> that variable. Never ask the owner for a key to put in it.** Key handling is forbidden outright
> (AGENTS.md §16.11), and the TEE path exists precisely so nobody has to.

Also here: `charge` (one-shot EIP-3009 via TEE; `--tx-hash` required when
`challenge.methodDetails.feePayer == false`), `session` (channel `open` / `voucher` / `topup` /
`close`), `subscription` (x402 `period` scheme), `a2a-pay` (buyer↔seller charge flow), and
`default` (which asset to use when the server offers several).

Useful before paying anything: `agent x402-check` validates an endpoint and extracts pricing, and
`agent x402-validate` does endpoint + price-match + budget check in one call.

---

## 8. Reading the market — free intelligence

`market` (prices, charts, wallet PnL) · `signal` (smart money / whale / KOL) · `social` (news,
sentiment) · `memepump` (pump.fun scanning) · `leaderboard` · `token` · `tracker` (address
activity) · `ws` (real-time subscriptions) · `defi` (product discovery).

These are reads, but **some surfaces are metered** — watch for quota or payment language in a
command's help and in its errors, and report a quota error as a quota error rather than as
"no data".

---

## 9. Scan before you act

`security` is not optional decoration; it is the cheapest risk reduction available:

```bash
onchainos security token-scan --tokens "8453:0x…"   # honeypots, high tax, mint risk (≤50 tokens)
onchainos security token-scan --address <wallet>    # or every token a wallet holds
onchainos security tx-scan                          # pre-execution scan, EVM & Solana
onchainos security sig-scan                         # phishing signature detection (EIP-712, personal_sign)
onchainos security dapp-scan                        # phishing / blacklisted domains
onchainos security approvals                        # existing approvals & permit2 grants
```

Before proposing any swap of an unfamiliar token, run `token-scan`. Before proposing any
signature, run `sig-scan`. If a scan says risky and the owner still wants it, that is his call —
but he must be told first.

---

## 10. Triage

| Symptom | Almost always | Next |
|---|---|---|
| `unrecognized subcommand 'login'` | there is no top-level login | `wallet login` → `wallet verify` |
| Everything says not authenticated | OTP never verified | `agent gate-check` |
| Amount off by a huge factor | `--amount` is wei, `--readable-amount` is human | §3 |
| `confirm-accept` fails oddly | `set-payment-mode` was not run first | §6 |
| "No jobs available" | you used `agent tasks` instead of `recommend-task` | §6 |
| Task missing from a list | terminal states are hidden by default | `--include-terminal` |
| A read returns nothing | metered surface / quota | read the error text; report it as quota |
| `geoblock` errored | fail-closed | treat as blocked |
| Command behaves unexpectedly after an update | version drift | `onchainos preflight --skill-version 1.0.0` |

---

## 11. Drills — read-only

1. `onchainos --version` and `preflight --skill-version 1.0.0` — current? any drift?
2. `agent gate-check` — logged in? identity? channel? Report all three.
3. `wallet addresses` — which chains does he actually have addresses on?
4. `portfolio total-value` — state the number **with its unit and the time**.
5. `agent active-tasks` — anything in flight, and in which role?
6. `security approvals` — any open approval he has forgotten? That is a standing risk worth naming.

Report as §16.9 says: claim, evidence, how measured, what you did not check.

---

## 12. Never

- Run `payment pay-local`, or set `EVM_PRIVATE_KEY`. Ever.
- Run `swap execute`, `swap swap`, `cross-chain`, `gateway`, `wallet send`, `wallet contract-call`,
  `strategy create-limit`, `defi` invest/redeem, or any `payment` verb without his explicit
  approval for that specific action.
- Pass an amount without checking whether that flag wants wei or human units.
- Pass `--base-url`.
- Treat a failed `geoblock` as "probably fine".
- Report a task as accepted while `set-payment-mode` / `confirm-accept` is still pending.
- Invent a flag — `onchainos <cmd> --help` is generated from the code and outranks this file.
