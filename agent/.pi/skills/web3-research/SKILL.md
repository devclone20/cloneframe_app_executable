---
name: web3-research
description: Investigate anything on-chain or in a web3 economy — what a wallet owns, whether an agent is real and activated, what trades it has done, whether a contract or collection is what it claims to be. Use when the owner asks "do I own X", "scan my wallet", "find my agents", "is this NFT/collection/contract real", "why does it show nothing", or when a chain/marketplace/protocol lookup errored. Read-only always: never signs, never sends.
---

# Web3 research — scan it, prove it, explain it

The owner is a founder with agents, tokens and iNFTs spread across chains, marketplaces and
protocol APIs. He does not need a summary of what a blockchain is. He needs a **specific,
checkable answer** — and when there isn't one, the exact reason there isn't.

Read §16 of AGENTS.md for the method. This is the procedure.

## 0. Never cross this line

Every surface below is **public, keyless and read-only**. You never sign a transaction, never
send/approve/swap anything, and never touch a private key or seed phrase — not into a tool, not
into a file, not typed into a page, not "just to test". If a task needs a signature, prepare
everything and hand it to the owner. **Research is reading. He does the signing.**

## 1. Ask the app before you ask the world

CLONE FRAME already scans. Its answer is the one the owner sees on screen, so start there:

```
app_rpc{module:'nft',       fn:'scanWallet', args:[address,{}]}   → every token, each tagged isAgent
app_rpc{module:'virtuals',  fn:'profile',    args:[address]}      → the person + every linked wallet
app_rpc{module:'virtuals',  fn:'holdings',   args:[address,{}]}   → agents across ALL those wallets:
                                catalog + ACP (incl. created-but-never-activated) + ERC-8004,
                                each with its source wallet, activation, and real ACP job counts
app_rpc{module:'robinhood', fn:'tokens'|'nfts', args:[address]}
app_rpc{module:'okxai',     fn:'status'|'agents'}
```

If your own lookup disagrees with the app's, **that difference is a bug — report it**, don't
quietly prefer your own number.

## 2. Expand the wallet before you scan it

A wallet is a graph, never one address. On Virtuals every agent gets its OWN wallet, and that
wallet — not the one the owner logs in with — is what owns the agent. Proven here: login wallet →
0 registrations; agent wallet → agentId 55101. **Always run `virtuals.profile` first** and scan
every wallet it returns. Say how many you scanned.

## 3. Climb to the right rung

| Rung | Source | Good for |
|---|---|---|
| 1 | contract call (`eth_call`) | ownership, `tokenURI`, balances — final word |
| 2 | node RPC | the chain via someone's node; a second node is a real check |
| 3 | indexer (Blockscout) | fast and broad, minutes behind, misses fresh mints |
| 4 | protocol API (Virtuals, ACP) | off-chain truth: activation, jobs, profiles — never ownership |
| 5 | marketplace (OpenSea) | listings and names. Not ownership truth |
| 6 | aggregator / social | a lead, never a finding |

Report the rung you used. "Blockscout lists 2 tokens" ≠ "the wallet holds 2 tokens".

Public, keyless surfaces that work (measured 2026-07-25):
- `api.virtuals.io/api/profile/<wallet>` — wallet → person → linked wallets
- `api.virtuals.io/api/virtuals?filters[walletAddress][$eq]=<wallet>` — tokenised agents
- `api.acp.virtuals.io/agents/wallet/<wallet>` — the ACP agent that wallet belongs to
- `api.acp.virtuals.io/agents/<uuid>/jobs` — its real trades (COMPLETED vs OPEN)
- ERC-8004 Identity Registry, Base `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- `base.blockscout.com/api/v2/addresses/<wallet>/nft` — every NFT an address holds

## 4. Two traps that have already bitten this app

**The ignored filter.** An API that doesn't understand a parameter usually *ignores* it instead of
failing, so a wrong filter returns *everything*, dressed as precision. `filters[creator][…]` on the
Virtuals catalog is silently dropped and answers with ~70,000 agents. **Before trusting a filtered
query, run it once unfiltered and compare counts.** Same count = the filter did nothing.

**The borrowed name.** Anyone can deploy a contract, call it "iCLONE", and airdrop it. The owner's
dev wallet holds exactly that — a "Future iCLONE" contract with an empty `tokenURI`, which the app
used to display as one of his agents. **Identity is the address, never the name.** When all you
have is a name, say "a collection *calling itself* iCLONE".

**And the mirror of it: a filter that hides something real.** Letting junk through gets noticed;
hiding a genuine holding does not — the owner just sees an empty box and believes it. The owner's
real iNFTs are collection **ATLAS**, symbol **INFT**, and a rule that looked for "inft" only in the
collection made both disappear. **If he says he owns something and your scan says he doesn't, your
scan is the suspect** — go to rung 1 before you tell him it isn't there.

## 5. "Nothing found" needs the most evidence

Before reporting empty, rule these out by name: not held · a linked wallet you didn't scan · wrong
network · fresh mint not yet indexed (go to rung 1) · endpoint wanted auth and answered `[]` ·
rate-limited (`429` and a throttled `[]` look identical) · pagination stopped at page 1.

Then say it so it can be checked: *"no agents on this wallet — login wallet plus the 4 linked ones,
on Base, via the contract and the indexer; ACP reachable."*

## 6. When a call fails — triage, don't guess

| Symptom | Meaning | Do |
|---|---|---|
| `400` / `422` | parameter shape changed | strip filters one at a time until it answers; the one that breaks it is the finding |
| `401` / `403` | wants auth | find the public sibling before asking for a key |
| `404` | wrong path or truly absent | confirm the path with a known-good id |
| `429` | rate-limited | exponential back-off; never read the throttled `[]` as "nothing" |
| `200` + `[]` | maybe nothing | run §5 first |
| CORS / blocked in page | browser restriction | route through `app_rpc`, not the page |
| `tokenURI` → `0x` | the token genuinely has no metadata | say so; never invent art or a name |
| timeout | maybe that node | try a second RPC endpoint before concluding |

## 7. Report it

**Claim** (one sentence, no hedging) → **evidence** (the call and the answer, with numbers) →
**how measured** (which rung, which endpoint, when) → **what is still unknown** (named).

Numbers carry units and a date. Say what you capped — "the first 60 tokens", "the 5 wallets on his
profile", "cached, up to 10 minutes old". A truncated answer presented as complete is the same lie
as an invented one.

## 8. When the owner hits an error

Lead with what you observed, then the single most likely cause, then **one** next action — not six
things to try. If the cause is on his side (wrong network in the wallet, not logged into a CLI, an
agent never activated), say it plainly and tell him the one thing to change.
