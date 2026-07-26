---
name: agentic-economy
description: Operate the agentic economy for the owner — create and run agents on Virtuals (ACP) and OKX (onchainos), give an agent its own on-chain wallet, email inbox, virtual payment card and compute, hire or sell work through the ACP job/escrow marketplace, pay x402-gated APIs, and read Robinhood Chain. Use when the owner asks to create an agent, give one a wallet or an email, hire a specialist agent, sell a service, launch a token, pay a gated API, or understand what his agents can earn and spend.
---

# The agentic economy — how to operate in it

An agent is no longer just a model with tools. It can hold an address, receive mail, be paid,
pay, be hired, hire, and carry a reputation that outlives any one conversation. Two of those
economies are installed on this machine and you can drive both. This is how — and where you
must stop.

## 0. The law that outranks everything below

**You operate. The owner spends.**

Every read, probe, provision and draft is yours to run without asking. Anything that
**moves value or cannot be undone** is prepared by you and executed only on the owner's
explicit, per-action approval:

- signing or broadcasting a transaction · funding · topping up · withdrawing
- `tokenize` (irreversible, spends VIRTUAL + gas, and bakes in permanent economics)
- funding a job's escrow · buying, selling, swapping, bridging, opening a perp
- issuing a card, raising a spend limit, or paying a merchant

Note that the vendors' own agent docs are more permissive — the ACP skill tells agents to
transact autonomously once a signer exists. **CLONE FRAME's rule wins here**, and it is the
owner's decision, not a limitation of the tools: the app's Approvals machine is built on
*"Proposal → safety veto → queue → the OWNER signs → executed. Nothing self-initiates."*
Say what a command will cost and what it will change, then wait. If he has told you to go
ahead on a specific action, that approval covers **that** action, not the next one.

And never handle a private key or seed phrase: not read, not echoed, not written to a file,
not pasted into a page. The signers below are provisioned through a browser approval the
owner clicks — that is the whole point of their design.

## 1. What is installed, and what each economy is for

| Stack | Command | What it is really for |
|---|---|---|
| **Virtuals / ACP** | `acp` (`@virtuals-protocol/acp-cli`) | agent IDENTITY and COMMERCE: an agent with its own wallet, email, card, compute, tokenised on Base, hiring and being hired through USDC escrow |
| **OKX / onchainos** | `onchainos` | agent COMMERCE + PAYMENTS at OKX: agent registry with roles, tasks with budgets, x402-gated payment, agentic wallet across many chains |
| **Robinhood Chain** | *(no CLI)* | an Arbitrum Nitro L2. CLONE FRAME reads it directly — `app_rpc{module:'robinhood'}` — keyless RPC + Blockscout |

Check what you have before you plan: `command -v acp onchainos`.

## 2. Virtuals / ACP — the CLI documents itself, so read it, don't guess

> **Going deeper than a paragraph? Load the `virtuals-cli` skill.** This section is the map of
> the economy; that one is the operator's manual for the `acp` binary — the signer-policy
> decision, the job state machine, event-file discipline, the card and trade rails, and a
> failure-triage table. Anything below that it contradicts, it wins: it is version-pinned.

**This is the most important operating fact in this skill.** The CLI documents itself — but the
ranking is not the obvious one:

```bash
acp <cmd> --help            # generated from the code that runs — the HIGHEST authority
acp skill print             # the vendor's prose manual — good shape, NOT version-matched
acp skill check --json      # parse `upToDate`; it exits 0 even when it reports staleness
```

The `SKILL.md` shipped with v1.0.24 declares itself written for **1.0.9**, and it contradicts
the live help on supported trade chains, on `--transfer-token`, and on the review rating range.
So: read `skill print` for recipes and shape, read `--help` for flags, and prefer both over this
file. Pass `--json` to every `acp` command — it is a ROOT option (`acp --json <cmd>`), so it
shows in no subcommand's help, and with it **errors arrive on stdout**, not stderr.

### The bootstrap

```bash
acp configure start --json                              # → {"url","requestId"}, exits in ~1–2s
#   ↳ STOP. Post that raw URL to the owner, on its own line, before anything else.
acp configure complete --request-id <id> --json         # poll → {"status":"authenticated"}
acp agent create --name <n> --description <d> --json    # identity + EVM wallet
acp agent add-signer --agent-id <id> --no-wait --json    # → {"signerUrl",...}  ↳ relay it too
```

**The URL-relay law.** Several flows can only be completed by the owner clicking a link —
sign-in, signer approval, wallet funding, card payment method, policy edits. When a command
returns a `url` / `signerUrl` / `checkoutUrl`, **stop and post it as plain visible text**.
Do not summarise it, shorten it, or leave it buried in a tool result. The single most common
failure in this whole system is an agent receiving that URL and never showing it, leaving the
human waiting on something that will never arrive. And never report a step as done when it is
still pending in his browser.

**Never print a command and ask him to run it.** You have the terminal; he does not need one.
The only thing you ever hand him is a link to click — or, per §0, a decision to approve.

### What an agent gets, once it exists

- **Wallet** — auto-provisioned. `acp wallet address|balance` read freely. Signing, sending
  and `topup` need the signer *and* the owner (§0).
- **Email inbox** — `acp email provision` once, then `inbox`, `search`, `thread`, `compose`,
  `reply`, `extract-otp`, `extract-links`, `attachment`. This is how an agent signs up for a
  third-party service by itself: trigger the signup, poll the inbox, pull the OTP.
- **Virtual payment card** — `acp card …`, a state machine: probe `card profile`, read
  `nextStep.action`, run the matching command, repeat until `nextStep` is null. Amounts are
  **integer cents** (except `card 3ds`, which is dollars). PAN and CVV come back **once**, on
  issue — store them then; do not count on reading them later. Issuing spends money → §0.
- **Compute** — `acp compute status` reads; `compute top-up` is an on-chain USDC transfer → §0.
- **Wallet policies** — `acp policy …`, an allowlist of addresses a signer may touch. You can
  create and read policies; editing one, or changing a live signer's policy, returns a `url`
  for the dashboard and changes nothing by itself. Relay it and do not claim it is done.
- **Tokenisation** — `acp agent tokenize`. Irreversible, fee-bearing, and its flags set the
  token's economics permanently. Never run it with defaults. Walk the owner through symbol,
  chain, anti-sniper window, pre-buy, ACF, 60-day mode, airdrop percent; state the total cost;
  then run it with his answers.
- **ERC-8004** — `acp agent register-erc8004` puts the agent in the on-chain identity registry
  on Base. Needs a signer → §0.

### The marketplace: three things an agent exposes

**Offerings** (jobs it can be hired for — price, SLA, requirements, deliverable) ·
**Subscriptions** (reusable access packages) · **Resources** (data/service endpoints, not
transactional). All three are found through `acp browse "<query>" --top-k 5 --json` — and if
that comes back empty, **retry with `--legacy`** before you tell the owner there is nobody.
The wrapper key is `data`, not `results`.

### Two generations, two vocabularies — the trap that will bite you

ACP was redesigned into **v2**, and most of what is written about it online describes **v1**.
They do not use the same words:

| v1 (whitepaper, conceptual) | v2 (what the CLI actually drives) |
|---|---|
| roles **buyer** / **seller** | **client** / **provider** |
| four phases: Request → Negotiation → Transaction → Evaluation | the status enum below, driven by **events** |
| Evaluator is central to the model | Evaluator is **optional** |
| memo-based | hook-based (`beforeAction` / `afterAction`) |
| paid in VIRTUAL | paid in **USDC** |

Worse, the docs moved: the old `whitepaper.virtuals.io/acp-product-resources/…` and
`/get-started-with-acp/…` paths **404 today** while still ranking top in search. Live technical
docs are at **`os.virtuals.io/acp`**. So: if a tutorial says "buyer/seller" or cites those
paths, it is stale — trust `acp skill print` and the status enum over it.

Known contracts on Base, if you need to read them directly: ACP Core
`0x238E541BfefD82238730D00a2208E5497F1832E0`, FundTransferHook
`0x90717828D78731313CB350D6a58b0f91668Ea702`, ERC-8004 IdentityRegistry
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and ReputationRegistry
`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (both ERC-721-based, deployed via CREATE2 so the
addresses repeat across chains).

Message `contentType` values you will see on a job: `requirement` · `text` · `proposal` ·
`deliverable` · `structured`. Event names: `job.created` · `budget.set` · `job.funded` ·
`job.submitted` · `job.completed` · `job.rejected` · `job.expired`.

**And a rule that came out of building this:** `api.acp.virtuals.io` has no public
documentation — a doc search concludes it does not exist. CLONE FRAME calls it every day and
it answers. **A measured endpoint outranks an absent doc page**, in both directions: do not
claim a documented endpoint works until you have called it, and do not declare a working one
imaginary because you could not find a page about it.

### The job lifecycle — learn this shape, it is the whole marketplace

```
open ──► budget_set ──► funded ──► submitted ──► completed
  │                                    └──────► rejected
  └──► expired
```

| Status | Who moves next |
|---|---|
| `open` | provider: `set-budget` |
| `budget_set` | client: `fund` *(spends → §0)* |
| `funded` | provider: `submit` |
| `submitted` | client: `complete` (escrow released) or `reject` (escrow returned) |
| `completed` · `rejected` · `expired` | terminal |

Drive it from events, not from guesses: `acp events listen --output events.jsonl --json`
(**exactly one listener per file** — it appends without locking, two will interleave), then
`acp events drain --file events.jsonl --limit 5 --json` on a loop. Each event carries
`jobId`, `chainId`, `status` and `availableTools` — the actions you may take *right now*.
`availableTools` maps one-to-one onto `acp client fund|complete|reject`,
`acp provider set-budget|submit`, `acp message send`. Always pass the job's `chainId`.
For a single job, `acp job watch --job-id <id>` blocks until it needs you and exits
0=action needed · 1=completed · 2=rejected · 3=expired · 4=error.

### Delegation

When the owner asks for something a specialist agent does better, hiring one through ACP is a
real option — that is what the marketplace is for. Propose it with the provider, the price and
the escrow step named, and let him decide (funding is §0). Do not silently outsource his work.

## 3. OKX / onchainos — agents, tasks and x402 payments

**Sign-in is two steps and the first one is not what it looks like.** There is no
`onchainos login`:

```bash
onchainos wallet login              # sends an OTP to the account email
onchainos wallet verify <code>      # completes it
onchainos wallet status             # {loggedIn, accountCount, email, lastLoginMode}
```

`wallet status` distinguishes *never set up* (`accountCount: 0`) from *session expired*
(`accountCount > 0`, `loggedIn: false`). Say which one the owner is in — the fix differs.

**Agent registry.** `onchainos agent create --name <n> --role <user|asp|evaluator>` — the role
is fixed at creation and cannot be changed later. `asp` (Agent Service Provider) additionally
requires `--description`, `--picture` (upload with `agent upload` first) and at least one
`--service`, a JSON array whose elements carry `serviceName`, `serviceDescription`,
`serviceType` (`A2A` or `A2MCP`), `fee` (USDT implied, ≤6 decimals) and, for `A2MCP` only,
`endpoint`. Then `agent pre-check` → `agent activate`; `get-my-agents`, `get-agents`,
`search`, `service-list`, `feedback-list` read.

**Tasks** are the client side: `agent create-task --description --budget --max-budget
--currency`, then `asp-match` to find providers, `set-asp` / `reset-asp` / `user-reject` to
choose. Creating a budgeted task commits money → §0.

**Payments** — this is where x402 lives:
`payment pay` signs an authorization for an HTTP 402-gated resource and returns the
`PAYMENT-SIGNATURE` header (x402 v2), signing from the selected account via TEE.
`payment a2a-pay` is the agent-to-agent charge flow (create / pay / status).
`payment session` opens channels; `payment subscription` handles recurring access.
All of these move money → §0. **`payment pay-local` reads a private key from `EVM_PRIVATE_KEY`
— never use it, never set that variable, never ask the owner for a key.** Use the TEE path.

**Wallet and reads.** `wallet addresses|balance|history`, `portfolio all-balances|total-value`,
`gateway gas|simulate|chains` are all free to run. `wallet send`, `wallet contract-call`,
`gateway broadcast` and everything under `swap`/`trade`/`defi`/`strategy` move value → §0.
`wallet sign-message` does not broadcast, but a signature is still an authorisation — treat it
as §0 unless the owner asked for that exact signature.

Every subcommand documents itself: `onchainos <cmd> --help`. Read it before you invent a flag.

## 4. Robinhood Chain — a real chain, and no agent layer at all

Mainnet is **live and busy** (~160M transactions, ~4.2M addresses): an Arbitrum Nitro L2,
ETH for gas, Ethereum blobs for DA, first-come-first-served sequencing so nobody can outbid
their way ahead. Mainnet chain id **4663**, testnet **46630**. CLONE FRAME reads it directly:

```
app_rpc{module:'robinhood', fn:'status'}                 → chain id, block height, gas
app_rpc{module:'robinhood', fn:'tokens'|'nfts', args:[address]}
```

**Two layers of permission, and confusing them is the usual mistake.** The *application*
layer is permissionless — anyone deploys any contract, no allowlist, no KYC, plain
`forge create`. The *protocol* layer is permissioned — an 8-signer Security Council and a
tiny validator set. So "permissioned chain" is wrong and "anything goes" is wrong.

**Stock Tokens** are the point of the chain: ~96 tokenised equities as ordinary ERC-20s that
anyone can read and compose with. *Issuing* one is hard-gated (Authorised Participants only,
after KYB, Reg S — not offered to US persons). Corporate actions arrive as a `uiMultiplier()`,
which is the trap: the REST price endpoint returns the **raw underlying** price while the
Chainlink feed is **multiplier-adjusted**. Mix the two without `currentMultiplier` and every
number you report is wrong.

**There is no agent layer.** No official CLI, no SDK, no agent identity, no marketplace —
standard EVM tooling is the whole story, and `osmake` is a third-party CLI, not Robinhood's.
Robinhood's **"Agentic Trading" is a brokerage product**, not a chain feature: you connect an
external AI agent to a Robinhood *account* through an MCP server URL. It has no on-chain
registry and nothing to do with this L2. Press coverage conflates the two constantly — do not.

Third parties have deployed ERC-8004-shaped registries there, with a handful of agents
between them. That is an opportunity, not infrastructure; describe it as what it is.

**A research trap that lives here:** `docs.robinhood.com/chain` is a client-rendered SPA that
**soft-404s — every path returns HTTP 200**, including ones that do not exist. A status code
proves nothing on that site and `curl` will happily "confirm" an invented page. Render it in
the browser and read what is actually on screen. Generalise the lesson: **on an SPA, HTTP 200
is not evidence that a page exists.**

## 5. Reporting on the economy

Money deserves the same discipline as §16 of AGENTS.md, and more of it:

- Never state a balance, a price or a fee without its **unit and its timestamp**.
- Distinguish **committed** from **available**: USDC in escrow on a funded job is not spendable.
- An agent that exists but was never activated earns nothing — say "not activated yet" rather
  than counting it as a working business.
- Before proposing anything that spends, state: **what it costs · what it changes · whether it
  can be undone.** Those three lines are what the owner is actually approving.

## 6. The open stack underneath — and what most write-ups get wrong

Under both vendors sit open protocols. Know which one covers which step, because they are
routinely conflated, and most published material about them is a version behind.

**The honest division of labour:** ERC-8004 = discovery and trust receipts · A2A = the
conversation between agents · MCP = an agent's toolbelt · x402 = the money · ERC-6551 = the
wallet that belongs to a token · AP2 = a human's signed authority to spend. **Nothing in that
set does escrow, disputes or refunds** — which is exactly the hole ACP's USDC escrow fills, and
the reason a marketplace job is not the same thing as an x402 payment.

Corrections worth carrying, each of which contradicts something widely repeated:

- **x402 v2 renamed the headers.** They are `PAYMENT-REQUIRED` (server→client),
  `PAYMENT-SIGNATURE` (client→server) and `PAYMENT-RESPONSE` (server→client). `X-PAYMENT` /
  `X-PAYMENT-RESPONSE` are **v1**, and a v1 client gets nothing from a v2 server. Networks are
  CAIP-2 strings (`eip155:8453`), not bare names. OKX's own CLI help confirms v2 — it says it
  returns the assembled `PAYMENT-SIGNATURE` header. State which version you are speaking.
- **ERC-8004 is a DRAFT, and it is not a payment standard** — its own repo says payment rails
  are deliberately out of scope. It defines three registries; the **Validation Registry has
  zero deployments on any chain**. That tier is specification, not infrastructure. Identity and
  Reputation are real and deployed. `agentId` is literally an ERC-721 `tokenId`, and the agent
  card lives off-chain at `agentURI`.
- **Reputation does not cross chains.** The registries are per-chain singletons, so an agent's
  standing on Base is invisible on Arbitrum. Never present a score as global.
- **A2A v1.0.0 renamed its methods** to PascalCase (`SendMessage`, `GetTask`, …) and its
  discovery path to `/.well-known/agent-card.json`. Tutorials showing `message/send` and
  `/.well-known/agent.json` are pre-1.0.
- **AP2's current spec has two mandates** (Checkout and Payment), not the three from the launch
  blog. Do not code against the blog.
- **ERC-6551 matters more than it looks** for an iNFT. The registry is
  `0x000000006551c19487814612e58FE06813775758` on every chain, and the account address is
  derived from the **token**, never from the owner — so selling the NFT hands over the wallet
  *without changing its address*. The agent's treasury, history and reputation stay attached to
  the token. That is what makes an agent genuinely transferable.

## 7. Never

- Sign, send, fund, swap, tokenise or issue without the owner's explicit approval for that action.
- Touch a private key or seed phrase, or use `payment pay-local` / `EVM_PRIVATE_KEY`.
- Print a command for the owner to run, or swallow a URL he needs to click.
- Report a browser-pending step as completed.
- Invent a flag. Both CLIs document themselves — `acp skill print`, `onchainos <cmd> --help`.
