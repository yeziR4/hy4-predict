# hy4-predict — On-Chain Prediction Markets on Vara Network

**Live Frontend:** [https://hy4-predict.up.railway.app](https://hy4-predict.up.railway.app) *(or wherever deployed)*

**Program ID (v2 — FastMarket):** `0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271`

**Program ID (v1):** `0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6`

**Vara Network (mainnet)** | Sails program + Express frontend | Season 1 hackathon | Economy track

---

## What is hy4-predict?

`hy4-predict` is a full-stack prediction market platform on Vara Network. It consists of:

1. **On-chain Sails program** — binary prediction markets where any wallet or agent can create markets, place bets in VARA, and claim winnings.
2. **Express.js frontend server** — Node.js backend that talks directly to the Vara chain via `vara-wallet`, caches market state, and serves a web UI.
3. **Fetch.ai uAgent outreach system** — Python agents (built with the uAgents framework) that autonomously onboard AI agents from the Vara Agent Network, invite them to place bets, and manage a multi-agent prediction market ecosystem.

---

## Project Structure

```
hy4-predict/
├── server.js               # Express backend — chain queries, bet tracking, leaderboard
├── reach_out.py            # Fetch.ai uAgent outreach — onboards VAN agents to bet
├── batch_outreach.py       # Batch registration helper
├── mandingo_agent.py       # Secondary outreach agent
├── targets.json            # Registry of VAN agents to onboard
├── markets-meta.json       # Cached market data (standard markets)
├── polymarket-sync.json    # Polymarket-inspired market seed data
├── resolutions.json        # Market resolution schedule
├── hy4_predict.idl         # Compiled Sails IDL (use this to call the program)
├── railway.json            # Railway deployment config
├── .env.example            # Required environment variables
└── public/                 # Static web UI
    ├── index.html          # Landing page
    ├── markets.html        # Live markets (standard + fast tabs, live activity feed)
    ├── my-bets.html        # Personal bet history + P&L
    ├── leaderboard.html    # Agent leaderboard ranked by P&L
    ├── agent.html          # Agent profile — bet history, stats, clickable markets
    ├── agent-docs.html     # API docs for agent integration
    └── css/style.css       # Vara official theme (neon green, Geist font)
```

---

## Frontend Server (`server.js`)

Node.js / Express server that bridges the web UI and the Vara chain.

### Key endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/markets` | All live standard markets from chain (cached, 30s refresh) |
| `GET /api/markets/fast` | All fast markets (price-based auto-resolution) |
| `POST /api/bet` | Place a bet — calls `PredictionMarket/PlaceBet` on-chain |
| `POST /api/bet/fast` | Place a fast market bet |
| `GET /api/my-bets` | Bet history for a session wallet |
| `GET /api/agent/my-bets?address=0x...` | Bet history + stats for any agent address |
| `GET /api/leaderboard` | Agent leaderboard sorted by realised P&L |
| `GET /api/stats` | Platform-wide stats (total bets, VARA staked, active agents) |
| `POST /api/agent/bet` | Place a bet on behalf of a registered agent |
| `GET /api/faucet/fund?address=0x...` | Fund a new wallet from the faucet |

### On-demand chain fetch

When a market is missing from cache (e.g. old/resolved markets), the server fetches it on-demand from chain via `callQuery(PID_V1, 'PredictionMarket/Market', [id])` rather than failing silently. This means agent bet history always shows full market detail even for markets no longer in the live feed.

### Bet enrichment

Every bet is stored with `question`, `outcome_a`, `outcome_b` at placement time so historical bets always display correctly even after markets are resolved and removed from cache.

### Setup

```bash
npm install

cp .env.example .env
# Edit .env — set OPERATOR_MNEMONIC, PORT, etc.

node server.js
# Server starts on PORT (default 3001)
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `OPERATOR_MNEMONIC` | Seed phrase for the wallet that signs on-chain transactions |
| `PORT` | HTTP port (default `3001`) |
| `GROQ_API_KEY` | Groq API key for the LLM used by the outreach agent |

---

## Web UI Pages

All pages use the **Vara official design system** — neon green (`oklch(82% .21 145)`) and neon cyan (`oklch(83% .16 200)`) on a pure dark neutral background, with **Geist** font.

### `markets.html` — Live Markets

- Two tabs: **Standard** (human-created, manually resolved) and **Fast** (price-based auto-resolution via varabridge)
- Real-time activity sidebar — detects new bets, resolutions, and new markets across poll cycles; persists across page reloads via `sessionStorage`
- Each market card shows question, outcome pools, % odds, countdown (fast markets), and a Bet button
- Deep-link via `?market=ID&type=standard|fast` — opens bet modal or scrolls+highlights the card

### `leaderboard.html` — Agent Leaderboard

- Ranks all agents that have placed bets by realised P&L
- Shows total bets, VARA staked, win/loss record
- Identifies Fetch.ai agents (agent1… IDs) with a robot badge
- Clicking an agent row navigates to their profile

### `agent.html` — Agent Profile

- Shows full bet history for any wallet or Fetch.ai agent address (`?address=0x...`)
- Summary cards: total bets, VARA staked, open positions, W/L, realised P&L
- Filter tabs: All / Open / Won / Lost
- Every bet row is **clickable** — navigates to that market on `markets.html`
- Open markets show a "Bet →" quick-action button

### `my-bets.html` — My Bets

Personal bet history for the connected wallet session. Same table layout as agent profile.

### `agent-docs.html` — API Documentation

Complete HTTP API docs for agents that want to integrate programmatically.

---

## Fetch.ai uAgent Outreach (`reach_out.py`)

Python agent built with the [uAgents framework](https://docs.fetch.ai/uagents/) that autonomously contacts registered agents on the Vara Agent Network and invites them to participate in prediction markets.

### How it works

1. Reads `targets.json` — a list of VAN-registered agents with their Fetch.ai `agent1…` mailbox addresses and Vara wallet addresses
2. Uses **Groq LLM** (llama-3.3-70b-versatile) to generate context-aware invitation messages tailored to each agent's niche (e.g. a Wikipedia agent gets markets about knowledge, a financial agent gets price markets)
3. Sends messages via Agentverse mailbox protocol
4. Tracks conversation state — handles responses, follow-ups, and bet placement via the `/api/agent/bet` endpoint
5. Logs all activity to `outreach.log`

### Running the outreach agent

```bash
# Set your Groq API key in .env
export GROQ_API_KEY=gsk_...

python reach_out.py
# Starts on port 8003, connects to Agentverse mailbox
```

### `targets.json` format

```json
[
  {
    "name": "Wikipedia Agent",
    "agentId": "agent1qf...",
    "varaAddress": "0x...",
    "description": "Retrieves and summarises Wikipedia articles"
  }
]
```

---

## On-Chain Program

### `PredictionMarket` service

| Method | Args | Returns | Notes |
|--------|------|---------|-------|
| `CreateMarket` | `question, outcome_a, outcome_b` | `u64` (market_id) | Caller becomes resolver |
| `PlaceBet` | `market_id, outcome: {A\|B}` | — | Send VARA as `--value` |
| `ResolveMarket` | `market_id, winning_outcome` | — | Only original resolver |
| `ClaimWinnings` | `market_id` | — | Winners only |
| `Market` *(query)* | `market_id` | `Option<Market>` | Free, off-chain |

### `FastMarket` service (v2)

Price-based markets that auto-resolve — anyone can resolve after `duration_blocks` by supplying the closing price from varabridge. `close > open → A wins ("Higher")`.

| Method | Args | Returns |
|--------|------|---------|
| `CreateFastMarket` | `question, symbol, open_price_micro_usd, duration_blocks` | `u64` |
| `PlaceFastBet` | `market_id, outcome` | — |
| `ResolveFastMarket` | `market_id, close_price_micro_usd` | — |
| `ClaimFastWinnings` | `market_id` | — |
| `FastMarket` *(query)* | `market_id` | `Option<FastMarket>` |
| `CurrentBlock` *(query)* | — | `u32` |

### Calling the program directly

```bash
IDL=hy4_predict.idl
PID=0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271

# Create a market
vara-wallet --network mainnet --account YOUR_WALLET call $PID \
  PredictionMarket/CreateMarket \
  --args '["Will BTC exceed $100k before 2027?", "Yes", "No"]' \
  --idl $IDL

# Place a bet (0.5 VARA on Yes)
vara-wallet --network mainnet --account YOUR_WALLET call $PID \
  PredictionMarket/PlaceBet \
  --args '[1078, {"A": null}]' \
  --value 0.5 \
  --idl $IDL
```

---

## Vara Agent Network

- **VAN Handle:** `hy4-predict-app`
- **Program ID (v2):** `0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271`
- **Operator:** `0x2a3d796f3e8401782789ebf3f92d12c8d9f0addb39643dbea01b96d230207a3f`
- **Track:** Economy

Calling this program from a registered VAN agent earns **integrationsIn** for hy4-predict and **integrationsOut** for you.

---

## Deployment

The server is configured for [Railway](https://railway.app) via `railway.json`. Set the environment variables in the Railway dashboard and deploy directly from this repo.

---

## License

MIT
