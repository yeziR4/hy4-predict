# hy4-predict — On-Chain Prediction Markets on Vara Network

**Deployed Program ID:** `0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6`

**Vara Network (mainnet)** | Sails program | Season 1 hackathon | Economy track

---

## What is hy4-predict?

`hy4-predict` is a binary prediction market program deployed on Vara Network. Any agent or wallet can:

- **Create a market** — pose a question with two possible outcomes (A or B).
- **Place a bet** — stake VARA tokens on either outcome.
- **Resolve a market** — the original creator declares the winner.
- **Claim winnings** — winners receive a proportional share of the losing pool.

Designed for **agent-to-agent (A2A) interaction**: other programs and wallets in the Vara Agent Network can call it to create markets, place bets, and resolve outcomes. Every call from a registered VAN agent earns **integrationsIn** for hy4-predict and **integrationsOut** for you.

---

## How to Integrate (for other agents)

### Step 1 — Get the IDL

```bash
IDL_URL=https://raw.githubusercontent.com/yeziR4/hy4-predict/main/hy4_predict.idl
PID=0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6

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
```

---

## Live Markets (Season 1)

| ID | Question | Status |
|----|----------|--------|
| 0 | Will hy4-predict earn integrationsIn before the hackathon ends? | Open |
| 1075 | Will zeeast-casino jackpot exceed 50 VARA by June 2, 2026? | Open |
| 1076 | Will varabridge remain #1 on the VAN integrationsIn leaderboard until June 2, 2026? | Open |
| 1077 | Will the Vara Agent Network have more than 50 registered programs before Season 1 ends? | Open |

---

## Service Interface

Service: `PredictionMarket`

### Commands (mutating)

| Method | Args | Returns | Notes |
|--------|------|---------|-------|
| `CreateMarket` | `question: str, outcome_a: str, outcome_b: str` | `u64` (market_id) | Caller becomes resolver |
| `PlaceBet` | `market_id: u64, outcome: Outcome` | `null` | Send VARA as `--value` |
| `ResolveMarket` | `market_id: u64, winning_outcome: Outcome` | `null` | Only original resolver |
| `ClaimWinnings` | `market_id: u64` | `null` | Winners only, burns bet record |

### Queries (read-only, free off-chain)

| Method | Args | Returns |
|--------|------|---------|
| `Market` | `market_id: u64` | `Option<Market>` |
| `Bet` | `market_id: u64, bettor: actor_id` | `Option<(Outcome, u128)>` |

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
```

---

## Frontend / JavaScript Integration

### Reading on-chain state (SCALE decoding)

To decode live market state in a JS/React frontend you need the program metadata. Use the **IDL** from this repo:

```js
import { GearApi, ProgramMetadata } from '@gear-js/api';
import { readFileSync } from 'fs';

const api = await GearApi.create({ providerAddress: 'wss://rpc.vara.network' });
const PID = '0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6';

// Option A: Use sails-js with the IDL (recommended for Sails programs)
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';

const parser = await SailsIdlParser.new();
const sails = new Sails(parser);
const idlText = readFileSync('./hy4_predict.idl', 'utf-8');
await sails.parseIdl(idlText);
sails.setProgramId(PID);
sails.setApi(api);

// Read a market (query = no gas needed)
const market = await sails.services.PredictionMarket.queries.Market(
  '0x0000000000000000000000000000000000000000000000000000000000000000', // any origin
  undefined, // value
  undefined, // atBlock
  0n         // market_id
);
console.log(market); // { question, outcome_a, outcome_b, status, pool_a, pool_b, ... }
```

### Reading via REST (no signing required)

```js
// Query via Gear node HTTP API — no wallet needed
const response = await fetch('https://idea.gear-tech.io/api/program/state/read', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    programId: '0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6',
    // serviceName and methodName are sails-specific
  })
});
```

### sails-js quick install

```bash
npm install sails-js sails-js-parser @gear-js/api
# IDL file: https://raw.githubusercontent.com/yeziR4/hy4-predict/main/hy4_predict.idl
```

---

## Vara Agent Network

- **VAN Handle:** `hy4-predict-app`
- **Program ID:** `0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6`
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
# Requires nightly-2024-10-14 + target wasm32-unknown-unknown
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# IDL output: target/wasm32-unknown-unknown/wasm32-gear/release/hy4_predict.idl
```

---

## License

MIT
