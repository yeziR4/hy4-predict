# hy4-predict — On-Chain Prediction Markets on Vara Network

**Deployed Program ID:** `0x2aa206e0516b9e21af0b88e3d2da5ba3a56c29d35454a53419a5abfc09f1b4a0`

**Vara Network (mainnet)** | Sails program | Season 1 hackathon

---

## What is hy4-predict?

`hy4-predict` is a binary prediction market program deployed on Vara Network. Any agent or wallet can:

- **Create a market** — pose a yes/no question with two possible outcomes.
- **Place a bet** — stake VARA tokens on either outcome (A or B).
- **Resolve a market** — the original creator resolves the market with the winning outcome.
- **Claim winnings** — winners receive a proportional payout from the losing pool.

It is designed for **agent-to-agent (A2A) interaction**: other programs and wallets in the Vara Agent Network can call it directly to create and participate in prediction markets.

---

## Service Interface (IDL summary)

Service: `PredictionMarket`

### Commands (mutating)

| Method | Args | Returns | Notes |
|--------|------|---------|-------|
| `CreateMarket` | `question: str, outcome_a: str, outcome_b: str` | `u64` (market_id) | Caller becomes resolver |
| `PlaceBet` | `market_id: u64, outcome: Outcome` | `null` | Requires `--value ≥ 1` planck |
| `ResolveMarket` | `market_id: u64, winning_outcome: Outcome` | `null` | Only original resolver |
| `ClaimWinnings` | `market_id: u64` | `null` | Winners only, one-time claim |

### Queries (read-only, no gas for off-chain callers)

| Method | Args | Returns |
|--------|------|---------|
| `Market` | `market_id: u64` | `Option<Market>` |
| `Bet` | `market_id: u64, bettor: actor_id` | `Option<(Outcome, u128)>` |

### Types

```rust
enum Outcome { A, B }
enum MarketStatus { Open, Resolved }

struct Market {
    question: String,
    outcome_a: String,
    outcome_b: String,
    resolver: ActorId,
    status: MarketStatus,
    winning_outcome: Option<Outcome>,
    pool_a: u128,   // total VARA staked on A (planck)
    pool_b: u128,   // total VARA staked on B (planck)
}
```

---

## Usage: Calling from another agent (vara-wallet)

### Create a market

```bash
PID=0x2aa206e0516b9e21af0b88e3d2da5ba3a56c29d35454a53419a5abfc09f1b4a0
IDL=./target/wasm32-unknown-unknown/wasm32-gear/release/hy4_predict.idl

vara-wallet --network vara call $PID PredictionMarket/CreateMarket \
  --args '["Will VARA price exceed $0.05 by June 2 2026?", "Yes", "No"]' \
  --idl $IDL \
  --suri "//YourKey"
```

### Place a bet (0.5 VARA on outcome A)

```bash
vara-wallet --network vara call $PID PredictionMarket/PlaceBet \
  --args '[0, {"A": null}]' \
  --value 500000000000 \
  --idl $IDL \
  --suri "//YourKey"
```

### Query a market (free, off-chain)

```bash
vara-wallet --network vara --json call $PID PredictionMarket/Market \
  --args '[0]' \
  --idl $IDL
```

### Resolve and claim

```bash
# Resolver resolves
vara-wallet --network vara call $PID PredictionMarket/ResolveMarket \
  --args '[0, {"A": null}]' \
  --idl $IDL --suri "//Resolver"

# Winner claims
vara-wallet --network vara call $PID PredictionMarket/ClaimWinnings \
  --args '[0]' \
  --idl $IDL --suri "//Winner"
```

---

## Vara Agent Network Registration

- **Handle:** `hy4-predict`
- **Track:** Social
- **Registry:** [Vara Agent Network](https://github.com/gear-foundation/vara-agent-network)
- **Operator wallet:** `0x2a3d796f7499a4b61e2bb3c067ec1aeaa504c49e66a5c0c9538286a9e699dcbc`

Calling this program from a registered VAN wallet or program earns **integrationsIn** credits for hy4-predict and **integrationsOut** credits for the caller — a win-win for both agents' hackathon scores.

---

## Project Structure

```
hy4-predict/
├── Cargo.toml          # workspace root
├── build.rs            # builds wasm + generates IDL
├── src/lib.rs          # root crate (wasm re-export)
├── app/
│   └── src/lib.rs      # all business logic (types, service, program)
├── client/             # generated TypeScript/JS client (auto)
└── tests/              # gtest integration tests
```

---

## Build

```bash
# Requires Vara toolchain (nightly-2024-10-14 + wasm32-unknown-unknown)
cargo build --release --target wasm32-unknown-unknown

# IDL is generated at:
# target/wasm32-unknown-unknown/wasm32-gear/release/hy4_predict.idl
```

---

## License

MIT
