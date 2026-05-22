# hy4-predict — On-Chain Prediction Markets on Vara Network

**Deployed Program ID (v2 — with FastMarket):** `0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271`

**Previous Program ID (v1):** `0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6`

**Vara Network (mainnet)** | Sails program | Season 1 hackathon | Economy track

---

## What is hy4-predict?

`hy4-predict` is a binary prediction market program deployed on Vara Network. Any agent or wallet can:

- **Create a market** — pose a question with two possible outcomes (A or B).
- **Place a bet** — stake VARA tokens on either outcome.
- **Resolve a market** — the original creator declares the winner.
- **Claim winnings** — winners receive a proportional share of the losing pool.
- **Create a FastMarket** — price-based market that auto-resolves by comparing open vs close price (NEW in v2).

Designed for **agent-to-agent (A2A) interaction**: other programs and wallets in the Vara Agent Network can call it to create markets, place bets, and resolve outcomes. Every call from a registered VAN agent earns **integrationsIn** for hy4-predict and **integrationsOut** for you.

---

## Why hy4-predict vs PolyBaskets

[PolyBaskets](https://polybaskets.vara.network) is a great human-facing UI for on-chain prediction markets. hy4-predict is something different: **infrastructure for the agent economy**.

| | hy4-predict | PolyBaskets |
|---|---|---|
| **Caller** | Any Sails program or wallet via IDL | Human via web UI |
| **Market creation** | `CreateMarket` call from any agent | Manual human action |
| **Resolution** | On-chain oracle agent calls `ResolveMarket` | Manual or admin |
| **Betting** | Programmatic — agents bet autonomously | Human clicks |
| **FastMarket** | Price-based auto-resolution (v2) | None |
| **Integration** | Drop-in IDL, one function call | N/A |
| **Agent interop** | Earns integrationsIn/Out for both caller and target | No VAN scoring |

### The agent-native difference

**Any Vara program can become a market creator in one call:**

```bash
# zeeast-casino creates a market about its own jackpot — entirely on-chain, zero humans
vara-wallet call $PREDICT_PID PredictionMarket/CreateMarket \
  --args '["Will our jackpot exceed 100 VARA this week?", "Yes", "No"]' \
  --idl hy4_predict.idl
```

**An oracle agent resolves markets automatically** when price feeds cross thresholds:

```bash
# oracle-prime monitors varabridge prices and resolves when BTC crosses $85k
vara-wallet call $PREDICT_PID PredictionMarket/ResolveMarket \
  --args '[1078, {"A": null}]' \
  --idl hy4_predict.idl
```

**The result:** a composable, programmable prediction layer where agents create markets about each other, bet on ecosystem outcomes, and resolve via on-chain data — no human in the loop at any step.

---

## FastMarket — Automatic Price-Based Resolution (v2)

FastMarkets eliminate the need for a trusted resolver. Anyone can create a market specifying an opening price, and anyone can resolve it after `duration_blocks` by supplying the closing price from varabridge.

**Resolution rule:** `close_price > open_price → Outcome A ("Higher") wins`, otherwise `Outcome B ("Lower or Same") wins`.

### Create a FastMarket

```bash
PID=0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271

# 1. Fetch the opening price from varabridge
vara-wallet --network mainnet --json call 0xfb7ed5a79dc2ff15283a524a4489321b5e1f6341db2b9892be83b9568cc1fcb4 \
  VaraBridge/GetPrice --args '["BTC"]' --idl vara_bridge.idl
# → { price_usd_micro: "77737350000", ... }

# 2. Create a FastMarket (50 blocks ≈ 5 minutes on Vara)
vara-wallet --network mainnet --account YOUR_WALLET call $PID \
  FastMarket/CreateFastMarket \
  --args '["Will BTC be higher in 50 blocks?", "BTC", "77737350000", 50]' \
  --idl hy4_predict.idl
# Returns market_id (u64)
```

### Bet on a FastMarket

```bash
# Bet on Outcome A (price goes Higher)
vara-wallet --network mainnet --account BETTOR call $PID \
  FastMarket/PlaceFastBet \
  --args '[<market_id>, {"A": null}]' \
  --value 0.5 \
  --idl hy4_predict.idl

# Bet on Outcome B (price stays Lower or Same)
vara-wallet --network mainnet --account BETTOR call $PID \
  FastMarket/PlaceFastBet \
  --args '[<market_id>, {"B": null}]' \
  --value 0.5 \
  --idl hy4_predict.idl
```

### Resolve and Claim (anyone can resolve after duration_blocks)

```bash
# 1. Fetch the closing price
vara-wallet --network mainnet --json call 0xfb7ed5a79dc2ff15283a524a4489321b5e1f6341db2b9892be83b9568cc1fcb4 \
  VaraBridge/GetPrice --args '["BTC"]' --idl vara_bridge.idl
# → { price_usd_micro: "78000000000", ... }

# 2. Resolve (anyone can call after resolve_after_block)
vara-wallet --network mainnet --account ANY_WALLET call $PID \
  FastMarket/ResolveFastMarket \
  --args '[<market_id>, "78000000000"]' \
  --idl hy4_predict.idl
# close(78000000000) > open(77737350000) → Outcome A wins

# 3. Winners claim
vara-wallet --network mainnet --account WINNER call $PID \
  FastMarket/ClaimFastWinnings \
  --args '[<market_id>]' \
  --idl hy4_predict.idl
```

### Check block countdown

```bash
# Query current block to see how many blocks remain
vara-wallet --network mainnet --json call $PID \
  FastMarket/CurrentBlock \
  --args '[]' \
  --idl hy4_predict.idl
# returns current block height; market resolves after FastMarket.resolve_after_block
```

---

## How to Integrate (for other agents)

### Step 1 — Get the IDL

```bash
IDL_URL=https://raw.githubusercontent.com/yeziR4/hy4-predict/main/hy4_predict.idl
PID=0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271

curl -O $IDL_URL
```

### Step 2 — Create a market about your own program

Any agent can create a market about anything. Use your own handle as the subject:

```bash
vara-wallet --network mainnet --account YOUR_WALLET call $PID \
  PredictionMarket/CreateMarket \
  --args '["Will YOUR_AGENT reach 500 integrationsIn by June 2, 2026?", "Yes", "No"]' \
  --idl hy4_predict.idl
# Returns market_id (u64) — save it for resolution
```

### Step 3 — Let your users bet

```bash
# Bet 0.5 VARA on outcome A ("Yes")
vara-wallet --network mainnet --account BETTOR_WALLET call $PID \
  PredictionMarket/PlaceBet \
  --args '[<market_id>, {"A": null}]' \
  --value 0.5 \
  --idl hy4_predict.idl

# Bet on outcome B ("No")
vara-wallet --network mainnet --account BETTOR_WALLET call $PID \
  PredictionMarket/PlaceBet \
  --args '[<market_id>, {"B": null}]' \
  --value 0.5 \
  --idl hy4_predict.idl
```

### Step 4 — Resolve and let winners claim

```bash
# Resolver (market creator) resolves
vara-wallet --network mainnet --account YOUR_WALLET call $PID \
  PredictionMarket/ResolveMarket \
  --args '[<market_id>, {"A": null}]' \
  --idl hy4_predict.idl

# Each winner claims proportional payout
vara-wallet --network mainnet --account WINNER_WALLET call $PID \
  PredictionMarket/ClaimWinnings \
  --args '[<market_id>]' \
  --idl hy4_predict.idl
```

### Step 5 — Query market state (free, no gas)

```bash
vara-wallet --network mainnet --json call $PID \
  PredictionMarket/Market \
  --args '[<market_id>]' \
  --idl hy4_predict.idl

# Query a FastMarket
vara-wallet --network mainnet --json call $PID \
  FastMarket/FastMarket \
  --args '[<market_id>]' \
  --idl hy4_predict.idl
```

---

## Live FastMarkets (v2 program)

| ID | Question | Symbol | Open Price (micro-USD) | Status |
|----|----------|--------|------------------------|--------|
| 0 | Will BTC be higher in 50 blocks? | BTC | 77,737,350,000 | Open |
| 1 | Will SOL be higher in 50 blocks? | SOL | 87,210,000 | Open |
| 2 | Will ETH be higher in 50 blocks? | ETH | 2,138,920,000 | Open |

## Live Markets — v1 program (`0x2aa206...`)

| ID | Question | Status |
|----|----------|--------|
| 0 | Will hy4-predict earn integrationsIn before the hackathon ends? | Open |
| 1075 | Will zeeast-casino jackpot exceed 50 VARA by June 2, 2026? | Open |
| 1076 | Will varabridge remain #1 on the VAN integrationsIn leaderboard until June 2, 2026? | Open |
| 1077 | Will the Vara Agent Network have more than 50 registered programs before Season 1 ends? | Open |
| 1078 | Will BTC exceed $85,000 before July 1 2026? *(resolves via varabridge price feed)* | Open |
| 1079 | Will Vara Network total registered programs exceed 60 by June 30, 2026? *(resolves via on-chain registry count)* | Open |
| 1080 | Will ETH exceed $3,000 before July 1 2026? *(resolves via varabridge price feed)* | Open |
| 1081 | Will any Vara A2A Season 1 agent earn a Builder Grant from Gear Foundation? *(resolves post-announcement)* | Open |
| 1082 | Will VARA token reach $0.10 by end of 2026? *(resolves via price feed)* | Open |

---

## Service Interface

### Service: `PredictionMarket`

#### Commands (mutating)

| Method | Args | Returns | Notes |
|--------|------|---------|-------|
| `CreateMarket` | `question: str, outcome_a: str, outcome_b: str` | `u64` (market_id) | Caller becomes resolver |
| `PlaceBet` | `market_id: u64, outcome: Outcome` | `null` | Send VARA as `--value` |
| `ResolveMarket` | `market_id: u64, winning_outcome: Outcome` | `null` | Only original resolver |
| `ClaimWinnings` | `market_id: u64` | `null` | Winners only, burns bet record |

#### Queries (read-only, free off-chain)

| Method | Args | Returns |
|--------|------|---------|
| `Market` | `market_id: u64` | `Option<Market>` |
| `Bet` | `market_id: u64, bettor: actor_id` | `Option<(Outcome, u128)>` |

---

### Service: `FastMarket` (v2 — NEW)

#### Commands (mutating)

| Method | Args | Returns | Notes |
|--------|------|---------|-------|
| `CreateFastMarket` | `question: str, symbol: str, open_price_micro_usd: u128, duration_blocks: u32` | `u64` | Anyone; fetch `open_price` from varabridge first |
| `PlaceFastBet` | `market_id: u64, outcome: Outcome` | `null` | Blocked once `block_height >= resolve_after_block` |
| `ResolveFastMarket` | `market_id: u64, close_price_micro_usd: u128` | `null` | **Anyone** after `resolve_after_block`; auto-determines winner |
| `ClaimFastWinnings` | `market_id: u64` | `null` | Winners only |

#### Queries (read-only, free off-chain)

| Method | Args | Returns |
|--------|------|---------|
| `FastMarket` | `market_id: u64` | `Option<FastMarket>` |
| `FastBet` | `market_id: u64, bettor: actor_id` | `Option<(Outcome, u128)>` |
| `CurrentBlock` | — | `u32` |

---

### Types

```
type Outcome = enum { A, B };
type MarketStatus = enum { Open, Resolved };

type Market = struct {
  question: str,
  outcome_a: str,
  outcome_b: str,
  resolver: actor_id,
  status: MarketStatus,
  winning_outcome: opt Outcome,
  pool_a: u128,   // planck staked on A
  pool_b: u128,   // planck staked on B
};

type FastMarket = struct {
  id: u64,
  question: str,
  symbol: str,                    // "BTC", "ETH", "SOL", etc.
  open_price_micro_usd: u128,     // price_usd_micro at creation
  close_price_micro_usd: opt u128,// set at resolution
  resolve_after_block: u32,       // block at/after which anyone can resolve
  status: MarketStatus,
  winning_outcome: opt Outcome,   // A = Higher, B = Lower or Same
  pool_a: u128,
  pool_b: u128,
};
```

---

## Frontend / JavaScript Integration

### Reading on-chain state (SCALE decoding)

To decode live market state in a JS/React frontend you need the program metadata. Use the **IDL** from this repo:

```js
import { GearApi, ProgramMetadata } from '@gear-js/api';
import { readFileSync } from 'fs';

const api = await GearApi.create({ providerAddress: 'wss://rpc.vara.network' });
const PID = '0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271';

// Use sails-js with the IDL (recommended for Sails programs)
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';

const parser = await SailsIdlParser.new();
const sails = new Sails(parser);
const idlText = readFileSync('./hy4_predict.idl', 'utf-8');
await sails.parseIdl(idlText);
sails.setProgramId(PID);
sails.setApi(api);

// Read a regular market
const market = await sails.services.PredictionMarket.queries.Market(
  '0x0000000000000000000000000000000000000000000000000000000000000000',
  undefined, undefined, 0n
);

// Read a FastMarket
const fastMarket = await sails.services.FastMarket.queries.FastMarket(
  '0x0000000000000000000000000000000000000000000000000000000000000000',
  undefined, undefined, 0n
);
console.log(fastMarket); // { question, symbol, open_price_micro_usd, resolve_after_block, status, ... }
```

### sails-js quick install

```bash
npm install sails-js sails-js-parser @gear-js/api
# IDL file: https://raw.githubusercontent.com/yeziR4/hy4-predict/main/hy4_predict.idl
```

---

## Vara Agent Network

- **VAN Handle:** `hy4-predict-app`
- **Program ID (v2):** `0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271`
- **Program ID (v1):** `0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6`
- **Operator:** `0x2a3d796f3e8401782789ebf3f92d12c8d9f0addb39643dbea01b96d230207a3f`
- **Track:** Economy
- **IDL:** [`hy4_predict.idl`](./hy4_predict.idl)

Calling this program from a registered VAN agent earns **integrationsIn** for hy4-predict and **integrationsOut** for you — win-win for both hackathon scores.

---

## Project Structure

```
hy4-predict/
├── hy4_predict.idl     # compiled Sails IDL (import this in clients)
├── Cargo.toml          # workspace root
├── build.rs            # builds wasm + generates IDL
├── src/lib.rs          # wasm re-export
├── app/src/lib.rs      # all logic: types, events, service, program
├── client/             # generated client (auto)
└── tests/              # gtest integration tests
```

---

## Build from source

```bash
# Requires stable toolchain + target wasm32-unknown-unknown
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# IDL output: target/wasm32-unknown-unknown/wasm32-gear/release/hy4_predict.idl
```

---

## License

MIT
