---
name: robinhood-chain
description: Operate Robinhood Chain (the Arbitrum Nitro L2, chain id 4663) from the command line — read blocks, balances, contracts and events with Foundry's `cast`, query the Blockscout API, and read Stock Tokens correctly including the uiMultiplier that makes a raw balance wrong. Use whenever the owner mentions Robinhood Chain, RH chain, chain 4663, Stock Tokens or tokenised equities (AAPL/TSLA/SGOV on-chain), the Robinhood explorer, or asks what an address holds there — and before reporting any number from that chain.
---

# Robinhood Chain from the command line

Read **§17 of AGENTS.md** for the law. This is the procedure.
Every fact below was measured against live mainnet on **2026-07-26**; re-measure before you
quote a number as current.

---

## 0. There is no Robinhood CLI. `cast` is the CLI.

Robinhood publishes **no first-party CLI and no SDK** for this chain. That is not a gap in your
knowledge — it is the design. It is a standard EVM L2, so standard EVM tooling is the whole
story, and **Foundry's `cast`** (installed here at `~/.foundry/bin/cast`) is the tool.

This is not an assumption. Robinhood's own docs are 22 pages and **none** is a CLI or SDK page;
a full-text search of the docs' own search index returns **zero** hits for "CLI". Their
"Deploy a Contract" tutorial prescribes **Foundry and Hardhat** — third-party tools. Robinhood
engineers push chain metadata *upstream* into viem and chainlist rather than shipping anything
of their own. The only genuinely first-party developer surface is a **read-only REST API** at
`api.robinhood.com/rhj/` — not a CLI, not an SDK.

Two things people confuse, constantly, including the press:

- **Robinhood Chain** — the L2 described in this file. On-chain, permissionless to read.
- **Robinhood "Agentic Trading"** — a *brokerage* product: an OAuth-gated MCP server at
  `https://agent.robinhood.com/mcp/trading` that trades **equities and options** inside a
  segregated "Agentic account". There is a second, separate one for the credit card at
  `https://banking-agent.robinhood.com/mcp/banking`. Both are brokerage/banking, both are
  unrelated to this L2, and neither has an on-chain registry. If the owner says "Robinhood's AI
  agents", ask which he means before answering.

`osmake` is often cited as a Robinhood Chain CLI. **It could not be verified to exist at all** —
its own advertised `npm install -g osmake` 404s, and there is no repo and no docs behind it.
Do not recommend it, and do not repeat the claim that it is "a third-party CLI"; the honest
statement is that nobody has shown it shipping.

### The npm trap — "Official" is a word anyone can type

Search npm for this chain and you will find **`robinhood-chain-sdk`**, whose own description
reads *"Official TypeScript SDK for the Robinhood Chain (chain id 4663)"*. Checked 2026-07-26:

```
maintainers: madeonsol <…@gmail.com>      ← a personal account, not a company
repository:  none
homepage:    madeonsol.com/robinhood      ← not a robinhood.com domain
```

It is not Robinhood's. The same publisher also ships `robinhood-chain-x402`, whose description
calls it "the **MadeOnSol** Robinhood Chain" — the mask slips one package over.

**A package description is marketing copy written by whoever published it.** It is not a
credential, and "Official" in an npm blurb proves exactly nothing. Before you `npm install`
anything that will touch the owner's chain reads — let alone a wallet — check the **maintainer**,
the **repository** (no repo is a red flag on its own) and whether the **homepage is on the
vendor's real domain**. This is §16.5 "names are not identity" moved up a layer: the trap is no
longer a contract wearing a ticker, it is a package wearing a company's name.

You do not need any of them. `cast` is installed and it is the real tool.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
export RH=https://rpc.mainnet.chain.robinhood.com     # mainnet 4663
export RHT=https://rpc.testnet.chain.robinhood.com    # testnet 46630
export RHX=https://robinhoodchain.blockscout.com      # explorer + REST API
```

| | mainnet | testnet |
|---|---|---|
| chain id | **4663** (`0x1237`) | **46630** (`0xB626`) |
| gas token | ETH | ETH |
| stack | Arbitrum Nitro L2, Ethereum blobs for DA | same |

Always say which one a number came from.

---

## 1. First contact — four reads

```bash
cast chain-id     --rpc-url $RH     # → 4663   (if this is not 4663, stop; wrong endpoint)
cast client       --rpc-url $RH     # → nitro/v3.11.3-… — confirms it really is Nitro
cast block-number --rpc-url $RH     # → 19578019 and climbing fast
cast gas-price    --rpc-url $RH     # → 63316000 wei ≈ 0.063 gwei
```

`cast chain-id` first, always. It is one round trip and it is the difference between reporting
mainnet and reporting a testnet you wandered onto.

**Blocks are ~0.1 s apart.** Measure it rather than believing a field:

```bash
N=$(cast block-number --rpc-url $RH)
cast block $N        --rpc-url $RH --field timestamp
cast block $((N-100)) --rpc-url $RH --field timestamp    # 100 blocks ≈ 10 seconds
```

**The explorer's `average_block_time` is in MILLISECONDS.** `/api/v2/stats` returns `91.0`,
which is 0.091 s — not 91 seconds. Read as seconds it is wrong by a factor of 1000, and it
turns "ten blocks a second" into "a block and a half a minute". Same family of error as the
cents-vs-dollars trap in `virtuals-cli` §8: the number arrives without its unit, and the wrong
reading is plausible enough to survive.

---

## 2. The explorer API — keyless REST

```bash
curl -s "$RHX/api/v2/stats"                                   # chain-wide totals
curl -s "$RHX/api/v2/addresses/<addr>"                        # one address
curl -s "$RHX/api/v2/addresses/<addr>/token-balances"         # every token it holds
curl -s "$RHX/api/v2/tokens?type=ERC-20"                      # token list
curl -s "$RHX/api/v2/search?q=AAPL"                           # by name/symbol/address
curl -s "$RHX/api/v2/smart-contracts/<addr>"                  # verified source, ABI, proxy info
```

Measured 2026-07-26: **4,223,006 addresses**, **161,243,430 transactions**. Busy, not a ghost chain.

It is rate-limited and keyless — cache, do not hammer. And when a contract is a proxy,
`/smart-contracts/<addr>` gives you `proxy_type` and `implementations`; the *logic* lives at the
implementation address, so read the source there, not at the proxy.

---

## 3. Stock Tokens — where a raw balance is a wrong answer

Tokenised equities live here as ordinary ERC-20s. Issuing one is hard-gated (Authorised
Participants, KYB, Reg S — not offered to US persons); **reading** one is open to everyone.

### 3a. The ticker is not the identity

Search `TSLA` on this chain and you get **three different contracts** — the real one plus
look-alikes, alongside meme tokens (`AAPLCAT`, `TSLA CAT`, …). Resolving a ticker to the first
hit will hand the owner a number about the wrong asset.

Two tests, in order:

1. **The name carries a bullet**: the official ones are `Apple • Robinhood Token`,
   `Tesla • Robinhood Token`. A plain `Tesla` is not one.
2. **The contract answers `uiMultiplier()`** — and impostors revert. This is the real test,
   because it is on-chain rather than a string someone chose:

```bash
cast call <token> "uiMultiplier()(uint256)" --rpc-url $RH
#   official  → 1000000000000000000  (or a bit more)
#   impostor  → Error: execution reverted
```

Verified addresses (mainnet, 2026-07-26 — re-check before quoting):

| | | | |
|---|---|---|---|
| AAPL `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | TSLA `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | MSFT `0xe93237C50D904957Cf27E7B1133b510C669c2e74` |
| GOOGL `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | AMZN `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | SPY `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | GME `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` |
| COIN `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | AMD `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | MU `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` | SGOV `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` |

### 3b. `balanceOf` is not what the holder owns

Every Stock Token carries a **`uiMultiplier()`** that absorbs corporate actions and, for income
instruments, daily accrual. The contract's own logic (verified source, implementation `Stock`
at `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` behind an EIP-1967 beacon proxy) is:

```solidity
function balanceOfUI(address a) → Math.mulDiv(balanceOf(a), uiMultiplier(), 1 ether)
function totalSupplyUI()        → Math.mulDiv(totalSupply(),  uiMultiplier(), 1 ether)
```

**So do not do the arithmetic — ask the contract:**

```bash
cast call <token> "balanceOfUI(address)(uint256)" <holder> --rpc-url $RH   # the true balance
cast call <token> "totalSupplyUI()(uint256)"                --rpc-url $RH
```

Measured on SGOV's largest holder:

```
balanceOf   = 3354.940422680995371336
balanceOfUI = 3358.152844868801231394     ← 3.21 tokens more, +0.0957%
```

**Explorers report the raw value.** Blockscout's `token-balances` is `balanceOf`, so anything
built on it under-reports a Stock Token holder. CLONE FRAME's own `robinhood` module did exactly
that until 2026-07-26; it now reads `uiMultiplier()` per token, caches it for an hour, and
corrects — while leaving ordinary ERC-20s untouched.

**Why this trap survives review:** the multiplier is *exactly* 1.0 on almost every ticker — 12 of
14 sampled. Test on AAPL and the correction looks like dead code. It is not dead; it is
invisible until it matters. When you write a rule, test it on the case that is supposed to
*trigger* it (AGENTS.md §16.4b), which here means SGOV or MU, not AAPL.

`currentMultiplier()` and `multiplier()` **do not exist** — both revert. The function is
`uiMultiplier()` (selector `0xa60bf13d`).

---

## 4. Ask the app before you ask the chain

CLONE FRAME reads this chain itself, with caching and the multiplier correction already applied.
Its answer is the one on the owner's screen, so prefer it (AGENTS.md §16.10):

```
app_rpc{module:'robinhood', fn:'status'}                        → chain id, height, gas
app_rpc{module:'robinhood', fn:'tokens',  args:[address]}       → holdings, Stock Tokens corrected
app_rpc{module:'robinhood', fn:'nfts',    args:[address]}
app_rpc{module:'robinhood', fn:'balance', args:[address]}       → native ETH
app_rpc{module:'robinhood', fn:'txcount', args:[address]}
app_rpc{module:'robinhood', fn:'chains'}                        → both networks' constants
app_rpc{module:'robinhood', fn:'explorerUrl', args:['tx'|'address'|'token', value]}
```

A corrected token comes back with `stockToken:true`, `uiMultiplier`, and `balanceRaw` (what the
explorer said) beside the corrected `balance`. If your own number differs from the app's, that
is a bug worth reporting — not a reason to quietly prefer yours.

---

## 5. Two permission layers — get the sentence right

- **Application layer: permissionless.** Anyone deploys any contract. No allowlist, no KYC.
- **Protocol layer: permissioned.** A small validator set and an 8-signer Security Council.

So "Robinhood Chain is a permissioned chain" is wrong, and "anything goes" is wrong. Say which
layer you mean. Sequencing is first-come-first-served — nobody buys their way ahead of you.

---

## 6. Research trap: the docs site lies about 404s

`docs.robinhood.com/chain` is a client-rendered SPA that **soft-404s: every path returns HTTP
200**, including paths that do not exist. `curl -o /dev/null -w '%{http_code}'` will happily
"confirm" a page you invented.

**A status code proves nothing there.** Three ways to actually settle it, cheapest first:

1. **Compare the body size.** A real page is prerendered — tens of KB of prose. An invented path
   returns the bare app shell, a few dozen bytes. `curl -s <url> | wc -c` separates them instantly.
2. **Read the site's own search index.** A docs SPA ships one; searching that corpus answers
   "does this topic exist at all" far better than guessing URLs. It is how "Robinhood publishes
   no CLI" went from a hunch to zero hits across the whole documentation set.
3. **Render it** (`web_navigate` + `web_read_page`) and quote what is on screen.

Generalise it — AGENTS.md §16.4e: on any SPA, HTTP 200 is not evidence that a page exists. The
useful upgrade is that "I could not verify it" has a cheap, decisive test hiding behind it.

---

## 7. Triage

| Symptom | Almost always | Next |
|---|---|---|
| Numbers look right but are for the wrong asset | you resolved a ticker to an impostor | `uiMultiplier()` — impostors revert |
| A holder's balance is slightly low | you read `balanceOf`, not `balanceOfUI` | §3b |
| Block time looks absurd (91 s) | the stats field is milliseconds | measure two timestamps |
| `cast call` reverts with no reason | the function does not exist on that contract | check the ABI via `/api/v2/smart-contracts` |
| Verified contract has no logic in it | it is a proxy | read `implementations[].address_hash` |
| A doc page "exists" but says nothing | SPA soft-404 | render it, don't curl it |
| Explorer suddenly empty or slow | keyless rate limit | back off and cache; do not retry in a loop |
| Wrong chain entirely | you used a default RPC | `cast chain-id` before anything |

---

## 8. Drills — all read-only

1. `cast chain-id --rpc-url $RH` → 4663. Say mainnet out loud.
2. Measure the real block time from two timestamps; compare it with the stats field and explain
   the factor of 1000.
3. Search a ticker on the explorer, list every contract that shares it, and name which is real
   **and how you proved it**.
4. Read `balanceOf` and `balanceOfUI` for one SGOV holder and state the difference in tokens
   and in percent.
5. `app_rpc{module:'robinhood', fn:'tokens', args:[<owner address>]}` — does anything come back
   with `stockToken:true`? Report it the way §16.9 says.

---

## 9. Never

- **Never `cast send`, `forge create`, `cast wallet`, or anything that signs or broadcasts.**
  Reads are yours; signing is the owner's (AGENTS.md §16.11). Prepare the command, show it, stop.
- Never touch a private key or seed phrase — not to test, not "just once", not into a file.
- Never resolve a ticker to a contract without the `uiMultiplier()` check.
- **Never install a package because its description says "Official".** Check the maintainer, the
  repository and the homepage domain. `robinhood-chain-sdk` says official and is one person's
  Gmail account with no repo. You have `cast`; you do not need it.
- Never quote `balanceOf` for a Stock Token as the holder's balance.
- Never report a chain number without saying mainnet or testnet, and when you measured it.
- Never cite a `docs.robinhood.com` page you have only curl'd.
