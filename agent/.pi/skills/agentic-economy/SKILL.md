---
name: agentic-economy
description: The map of the owner's agent economies and the law that governs all of them — Virtuals/ACP, OKX/onchainos and Robinhood Chain. Use when the owner asks what his agents can earn or spend, which stack to use for something, or anything spanning more than one of them; and load it FIRST when a request touches agent commerce, an agent wallet/email/card, hiring or selling agent work, x402 payments, ERC-8004 identity, or tokenising an agent. It routes to the per-CLI skill that carries the commands.
---

# The agentic economy — the map, and the law

An agent is no longer just a model with tools. It can hold an address, receive mail, be paid,
pay, be hired, hire, and carry a reputation that outlives any one conversation.

**This skill is the map, not the manual.** It carries the law that governs every economy, which
stack does what, and the open protocols underneath. **The commands live in one skill each** —
never in two places, so there is nothing to keep in sync and nothing to contradict:

| Economy | Command | Load this skill |
|---|---|---|
| **Virtuals / ACP** | `acp` | **`virtuals-cli`** |
| **OKX / onchainos** | `onchainos` | **`okx-cli`** |
| **Robinhood Chain** | *(no CLI — it is `cast`)* | **`robinhood-chain`** |

Check what you actually have before you plan: `command -v acp onchainos cast`.

---

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

---

## 1. Which one is he actually asking about?

Picking the wrong stack wastes a session; worse, answering from the wrong one produces a
confident number about the wrong thing.

| He says… | He means | Load |
|---|---|---|
| "my agent", "hire an agent", "sell a service", "the marketplace", "escrow", "tokenise" | Virtuals / ACP — identity + commerce, USDC escrow on Base | `virtuals-cli` |
| "my wallet", "swap", "bridge", "portfolio", "x402", "a task with a budget", "smart money" | OKX / onchainos — agentic wallet + payments + task market | `okx-cli` |
| "Robinhood", "chain 4663", "Stock Tokens", "AAPL/TSLA on-chain" | Robinhood Chain — an L2 you **read** | `robinhood-chain` |
| "what do I own", "scan my wallet", "is this real" | a research question, not an economy | `web3-research` |

Two name collisions that catch people:

- **Robinhood Chain ≠ Robinhood "Agentic Trading".** The first is an L2. The second is a
  brokerage product over MCP that trades equities and options in a segregated account. No
  relationship. Ask which he means.
- **"Agent" means something different in each stack.** An ACP agent has a wallet, offerings and
  jobs. An OKX agent has a role (User / ASP / Evaluator) and tasks. They are not the same object
  and their IDs are not interchangeable.

---

## 2. Reporting on the economy

Money deserves the same discipline as §16 of AGENTS.md, and more of it:

- Never state a balance, a price or a fee without its **unit and its timestamp**.

**Units are where agent money bugs actually live, and all three stacks have one.** This is not a
coincidence to note in passing — it is the single highest-frequency way to be confidently wrong
about someone's money, so check the flag every time:

| Stack | The trap | The damage |
|---|---|---|
| Virtuals | `acp card issue --amount` is **cents** (its own description says "$1–$75"), while `acp compute top-up --amount` is **whole USDC** | 100× |
| OKX | `onchainos swap execute --amount` is **minimal units (wei/lamports)**; human numbers go in the separate, mutually exclusive `--readable-amount` | up to 10¹⁸× |
| Robinhood | `balanceOf` is the raw value; the holder's real balance is `balanceOfUI` (scaled by `uiMultiplier`) | silent under-report |

Two habits that defuse all three: **read the flag, never the prose description**, and **say the
unit out loud** when you report or propose. "5" is not an amount; "5 USDC" is.

- Distinguish **committed** from **available**: USDC in escrow on a funded job is not spendable.
- An agent that exists but was never activated earns nothing — say "not activated yet" rather
  than counting it as a working business.
- Before proposing anything that spends, state: **what it costs · what it changes · whether it
  can be undone.** Those three lines are what the owner is actually approving.

---

## 3. The open stack underneath — and what most write-ups get wrong

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

---

## 4. Never

- Sign, send, fund, swap, tokenise or issue without the owner's explicit approval for that action.
- Touch a private key or seed phrase, or use `payment pay-local` / `EVM_PRIVATE_KEY`.
- Print a command for the owner to run, or swallow a URL he needs to click.
- Report a browser-pending step as completed.
- Quote an amount without checking which unit that specific flag wants.
- Invent a flag. Every one of these tools documents itself — and the **installed binary's
  `--help` outranks any prose about it**, including the vendor's own bundled manual and these
  skills.
