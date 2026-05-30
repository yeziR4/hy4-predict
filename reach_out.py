"""
reach_out.py — LLM-driven conversational outreach for hy4-predict.

Every message in and out goes through Claude. The LLM knows:
  - Who we're talking to (agent description)
  - Live markets with real liquidity
  - Full conversation history
  - When and how to steer toward a bet naturally

Claude decides the tone, the framing, when to introduce markets,
and when to pull the trigger on a bet. The only hardcoded logic
is the actual POST /api/agent/bet call.

Usage:
  python reach_out.py <agent_address> "<one-line description of target agent>"

  e.g.
  python reach_out.py agent1qg5xf8... "Peter's Home Energy Agent — monitors
  electricity usage, energy marketplaces, live price feeds, wallet ops"

If no description is given, Claude will adapt to whatever the agent says.
"""

import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from openai import AsyncOpenAI
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

# ── Config ─────────────────────────────────────────────────────────────────────
HY4_SERVER  = os.getenv("HY4_SERVER_URL", "http://localhost:3001")
GROQ_KEY    = os.getenv("GROQ_API_KEY", "")
LLM_MODEL   = "llama-3.3-70b-versatile"
AGENT_SEED  = os.getenv("REACH_AGENT_SEED", "mandingo_local_v2")
AGENT_PORT  = int(os.getenv("REACH_AGENT_PORT", "8003"))
WALLET_LOG  = str(Path(__file__).parent / "agent-wallet-log.json")
DEFAULT_BET = float(os.getenv("DEFAULT_BET_VARA", "1.5"))
MAX_BETS    = int(os.getenv("MAX_BETS_PER_SESSION", "4"))
CONVO_TTL   = 60 * 45   # drop idle sessions after 45 min
TARGETS_FILE = str(Path(__file__).parent / "targets.json")  # hot-reload file

# Parse CLI: reach_out.py <address1> "<desc1>" [-- <address2> "<desc2>" ...]
# Pairs are separated by " -- "
# Simple form (single target): reach_out.py <address> "<description>"
_raw = " ".join(sys.argv[1:])
_pairs = [p.strip() for p in _raw.split("--") if p.strip()]
TARGETS: dict[str, str] = {}   # address -> description
for pair in _pairs:
    parts = pair.split(None, 1)
    if parts:
        addr = parts[0].strip()
        desc = parts[1].strip() if len(parts) > 1 else "an AI agent on Agentverse"
        TARGETS[addr] = desc
# Fallback: no separator used, first token is address, rest is description
if not TARGETS and sys.argv[1:]:
    addr = sys.argv[1]
    desc = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else "an AI agent on Agentverse"
    TARGETS[addr] = desc

# Keep backward-compat single-target vars
TARGET_ADDRESS = next(iter(TARGETS), None)
TARGET_DESC    = TARGETS.get(TARGET_ADDRESS, "an AI agent on Agentverse") if TARGET_ADDRESS else ""

ai = AsyncOpenAI(base_url="https://api.groq.com/openai/v1", api_key=GROQ_KEY)

# ── Agent setup ────────────────────────────────────────────────────────────────
sender = Agent(name="hy4-outreach", seed=AGENT_SEED, port=AGENT_PORT, mailbox=True)
proto  = Protocol(spec=chat_protocol_spec)

print(f"[outreach] our address : {sender.address}", flush=True)
for _a, _d in TARGETS.items():
    print(f"[outreach] target      : {_a}  ({_d[:60]})", flush=True)

# ── Per-agent session state ────────────────────────────────────────────────────
# keyed by sender address
_sessions: dict[str, dict[str, Any]] = {}


def get_session(addr: str) -> dict:
    now = time.time()
    # Expire old sessions
    for k in [k for k, v in _sessions.items() if now - v["last"] > CONVO_TTL]:
        del _sessions[k]
    if addr not in _sessions:
        _sessions[addr] = {
            "history":      [],     # [{role, content}, ...]
            "address":      None,   # hy4 wallet address
            "mnemonic":     None,
            "vara_left":    10.0,
            "bets_placed":  0,
            "last":         now,
            "wallet_saved": False,
            "all_bets":     [],     # accumulates every bet this session + prior
            "done":         False,  # True once closing message sent
            "turns":        0,      # message turns this session
        }
    else:
        _sessions[addr]["last"] = now
    return _sessions[addr]


# ── hy4-predict helpers ────────────────────────────────────────────────────────

async def fetch_markets() -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=12) as c:
            r = await c.get(f"{HY4_SERVER}/api/agent/markets")
            r.raise_for_status()
            d = r.json()
            markets = d if isinstance(d, list) else d.get("markets", [])
            # Only return markets with real liquidity
            return [m for m in markets if float(m.get("totalPool", 0)) > 0]
    except Exception as e:
        print(f"[markets] {e}", flush=True)
        return []


async def register_wallet(agent_addr: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=40) as c:
            r = await c.post(f"{HY4_SERVER}/api/agent/register",
                             json={"agentId": agent_addr})
            r.raise_for_status()
            return r.json()
    except Exception as e:
        return {"error": str(e)}


async def place_bet(address: str, mnemonic: str,
                    market_id: int, outcome: str, amount: float) -> dict:
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(f"{HY4_SERVER}/api/agent/bet",
                             json={"address": address, "mnemonic": mnemonic,
                                   "marketId": market_id, "outcome": outcome,
                                   "amount": amount})
            r.raise_for_status()
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def load_targets_file() -> dict[str, str]:
    """Load agent targets from targets.json for hot-reload. {address: description}"""
    try:
        with open(TARGETS_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}
        if isinstance(data, list):
            return {
                item["address"]: item.get("description", "an AI agent on Agentverse")
                for item in data if isinstance(item, dict) and "address" in item
            }
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[targets] load error: {e}", flush=True)
    return {}


def load_wallet_log() -> dict:
    try:
        with open(WALLET_LOG) as f:
            return json.load(f)
    except Exception:
        return {}


def save_wallet_log(log: dict) -> None:
    try:
        with open(WALLET_LOG, "w") as f:
            json.dump(log, f, indent=2)
    except Exception as e:
        print(f"[wallet-log] save error: {e}", flush=True)


def save_conversation_history(sender_addr: str, history: list[dict]) -> None:
    """Persist last 20 turns of conversation into wallet log for cross-session memory."""
    try:
        wlog = load_wallet_log()
        if sender_addr in wlog:
            # Store as compact list of {role, content} — trimmed to last 20 turns
            wlog[sender_addr]["conversation_history"] = history[-20:]
            save_wallet_log(wlog)
    except Exception as e:
        print(f"[memory] save error: {e}", flush=True)


def load_conversation_history(sender_addr: str) -> list[dict]:
    """Load previous conversation turns from wallet log."""
    try:
        wlog = load_wallet_log()
        return wlog.get(sender_addr, {}).get("conversation_history", [])
    except Exception:
        return []


def markets_block(markets: list[dict]) -> str:
    """Format markets for the LLM system prompt."""
    if not markets:
        return "  (no markets with liquidity available right now)"
    lines = []
    for m in markets[:8]:
        mid   = m.get("id", "?")
        q     = m.get("question", "?")
        pool  = float(m.get("totalPool", 0))
        a_pct = float(m.get("percentA") or 50)
        la    = m.get("outcomeA", "Yes")
        lb    = m.get("outcomeB", "No")
        cl    = m.get("closingLabel") or ""
        urgency = f" | closes: {cl}" if cl else ""
        lines.append(
            f"  #{mid} [{pool:.1f} VARA pool] {q[:65]}\n"
            f"       {la}: {a_pct:.0f}%  |  {lb}: {100-a_pct:.0f}%{urgency}"
        )
    return "\n".join(lines)


def is_capable_agent(desc: str) -> tuple[bool, str]:
    """Return (True, capability_description) if the agent can fetch live data."""
    d = desc.lower()
    caps = []
    if any(k in d for k in ["fox news", "cnn", "news api", "n8n news", "financial news",
                              "news agent", "news fetching", "breaking news", "latest news"]):
        caps.append("real-time news articles")
    if any(k in d for k in ["wikipedia", "wiki search"]):
        caps.append("Wikipedia lookups")
    if any(k in d for k in ["web search", "internet search", "search the web", "search tool"]):
        caps.append("web searches")
    return bool(caps), " and ".join(caps) if caps else ""


def build_system(markets: list[dict], s: dict, target_desc: str) -> str:
    wallet_status = (
        f"Wallet registered: {s['address']} — {s['vara_left']:.1f} VARA remaining"
        if s["address"]
        else "Wallet NOT yet registered (will be created on first bet)"
    )
    capable, cap_desc = is_capable_agent(target_desc)
    capable_section = ""
    if capable:
        # Pick a market topic to research based on what's available
        sample_q = ""
        if markets:
            sample_q = markets[0].get("question", "")[:60]
        capable_section = f"""
LEVERAGE THEIR DATA-FETCHING CAPABILITY:
This agent can perform {cap_desc}. Use this before steering to a bet.
First ask them to look something up that's relevant to one of the markets above.
Examples:
  - Crypto market: "Can you pull the latest Bitcoin or ETH headlines?"
  - CPI/inflation market: "What's the latest news on inflation or consumer prices?"
  - Geopolitical market: "Can you check what's going on with [relevant topic]?"
  - General: "I'm looking at a market around '{sample_q}' — can you check recent news on this?"
Once they share their findings, bridge it naturally:
  "Interesting — based on what you just found, I think [side] on market #[id] is worth a small bet. Want to try it with your free VARA?"
This makes the bet feel evidence-based and collaborative, not random.
"""
    return f"""You are the hy4-predict outreach agent — a sharp, friendly AI that recruits other AI agents to bet on on-chain prediction markets on Vara Network.

WHO YOU'RE TALKING TO:
{target_desc}

YOUR GOAL:
Get this agent to place at least one bet on hy4-predict. This is part of a hackathon — the target agent gets 10 free VARA to bet with, nothing is at risk for them.

HOW TO DO IT:
- Start by being genuinely curious about what THEY do. Ask about their domain.
- Find natural connections between their domain and the available markets.
  e.g. energy agent -> CPI market (energy drives inflation), geopolitical markets (conflict affects energy prices)
- Don't pitch hy4-predict immediately. Build rapport first (1-2 exchanges).
- When the moment is right, introduce the relevant market naturally.
- When they show interest, tell them betting is instant and they have free VARA.
- Keep messages SHORT — under 120 words. No walls of text.
{capable_section}
LIVE MARKETS WITH LIQUIDITY:
{markets_block(markets)}

WALLET STATE:
{wallet_status}
Bets placed this session: {s['bets_placed']} / {MAX_BETS}

PLACING A BET:
When you decide it's time to place a bet (the other agent has indicated interest OR
you've built enough rapport that a direct suggestion feels natural), output EXACTLY
this on its own line and nothing else after it:
  ACTION:BET:{{"marketId": <id>, "outcome": "A" or "B", "amount": <float>}}

A = first option (Yes/Up/etc), B = second option (No/Down/etc).
Only emit ACTION:BET when you're genuinely ready to place — not speculatively.
If they explicitly say NO or show no interest, don't force it. Try a different angle.

IMPORTANT:
- Never reveal you have a script or that this is automated outreach.
- Never make up market IDs not listed above.
- Be a peer, not a salesperson.
- ALWAYS respond in natural conversational prose. Never use command syntax, headers, bullet lists, or structured formats.
- Never prefix your message with QUERY, ACTION, COMMAND, or any keyword. Just talk naturally.
- You are having a chat conversation, not executing API calls.
"""


# ── LLM call ──────────────────────────────────────────────────────────────────

async def llm_respond(markets: list[dict], s: dict,
                       incoming: str, target_desc: str) -> str:
    system = build_system(markets, s, target_desc)
    messages = [{"role": "system", "content": system}] + \
               list(s["history"][-16:]) + \
               [{"role": "user", "content": incoming}]
    try:
        resp = await ai.chat.completions.create(
            model=LLM_MODEL,
            max_tokens=300,
            messages=messages,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        print(f"[llm] error: {e}", flush=True)
        return "Hey, I got a bit tangled up — mind repeating that?"


async def llm_opener(markets: list[dict], target_desc: str,
                     prior_bets: list[dict] | None = None,
                     vara_remaining: float = 10.0,
                     prior_history: list[dict] | None = None) -> str:
    if prior_bets:
        # Build a human-readable conversation recap so the stateless target can follow
        recap = ""
        if prior_history:
            turns = []
            for turn in prior_history[-10:]:  # last 10 turns max
                role  = "You" if turn["role"] == "user" else "Me"
                turns.append(f"{role}: {turn['content'][:120]}")
            recap = "\n".join(turns)

        bets_str = "\n".join(
            f"  - #{b['marketId']}: {b['outcome']} side, {b['amount']} VARA"
            + (f" — tx {b.get('txHash','')[:18]}..." if b.get('txHash') else "")
            for b in prior_bets
        )

        prompt = f"""You are the hy4-predict outreach agent returning to check in with:
{target_desc}

IMPORTANT: This agent has NO memory of your previous conversation.
You must bring them up to speed in your opening message so they have full context.

YOUR PREVIOUS CONVERSATION SUMMARY:
{recap if recap else "(no prior chat history saved)"}

BETS YOU PLACED ON THEIR BEHALF LAST TIME:
{bets_str}
Remaining VARA balance: {vara_remaining:.1f}

Write a returning message (under 140 words) that:
1. Re-introduces yourself briefly ("Hey, it's me from Vara Network — we chatted before about...")
2. Recaps the key points of your last conversation in 1-2 sentences so they have context
3. Gives a bet status update — those bets are sitting on-chain waiting to resolve
4. If vara_remaining > 1.0: naturally mention there's still VARA to use on new markets
5. If vara_remaining < 1.0: say the balance is mostly used, you're mainly checking on outcomes

Be warm. Don't assume they remember anything — give them enough to feel caught up.
"""
    else:
        prompt = f"""You are the hy4-predict outreach agent. You're about to send the FIRST message to:
{target_desc}

Write a short, natural opening message (under 80 words) that:
1. Introduces yourself briefly as an AI agent on Vara Network
2. Shows genuine curiosity about what THEY do
3. Mentions one thing about their domain that's interesting to you

Do NOT mention hy4-predict or betting yet.
Be casual, peer-to-peer, like two agents meeting at a hackathon.
"""
    try:
        resp = await ai.chat.completions.create(
            model=LLM_MODEL,
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        print(f"[llm-opener] {e}", flush=True)
        if prior_bets:
            return (
                f"Hey! We chatted before — I'm an agent on Vara Network. "
                f"Last time I placed {len(prior_bets)} bets on hy4-predict on your behalf "
                f"using your 10 VARA allocation. You still have {vara_remaining:.1f} VARA left. "
                "Checking in to see if you'd like to use it on new markets!"
            )
        return f"Hey! I'm an agent on Vara Network. I saw you're working on {target_desc[:60]} — that's interesting. What kinds of decisions are you helping with day to day?"


async def llm_closing(markets: list[dict], s: dict, target_desc: str) -> str:
    """Generate a natural closing message once all bets are placed."""
    bets_str = "\n".join(
        f"  - Market #{b['marketId']}: {b['outcome']} side, {b['amount']} VARA  (tx: {b.get('txHash','')[:16]}...)"
        for b in s.get("all_bets", [])
    )
    prompt = f"""You are the hy4-predict outreach agent wrapping up a conversation with:
{target_desc}

You've just finished placing {s['bets_placed']} bets on their behalf:
{bets_str}
Remaining VARA balance: {s['vara_left']:.1f}

Write a short, friendly closing message (under 100 words) that:
1. Summarizes what was bet (briefly)
2. Tells them you'll come back once markets resolve to share the outcome
3. Mentions that if there are winnings, they can be used to place more bets
4. Feels like a natural end to the conversation — warm, not abrupt

Do NOT say goodbye forever — frame it as "talk soon" / "I'll check back".
"""
    try:
        resp = await ai.chat.completions.create(
            model=LLM_MODEL,
            max_tokens=180,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        print(f"[llm-closing] {e}", flush=True)
        return (
            f"All {s['bets_placed']} bets are placed on-chain. "
            "I'll swing back once the markets resolve to share the results — "
            "if any pay out, we can roll the winnings into new markets. Talk soon! 🤝"
        )


def parse_bet_action(text: str) -> dict | None:
    m = re.search(r"ACTION:BET:\s*(\{[^}]+\})", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def strip_action(text: str) -> str:
    """Remove the ACTION:BET line from the visible reply."""
    return re.sub(r"\nACTION:BET:\{[^}]+\}", "", text).strip()


# ── Send helper ────────────────────────────────────────────────────────────────

async def send(ctx: Context, dest: str, text: str):
    clean = text[:1200]  # Fetch.ai message size limit
    await ctx.send(dest, ChatMessage(content=[TextContent(text=clean)]))
    print(f"[-> {dest[:22]}] {clean[:100]}", flush=True)


# ── Startup ────────────────────────────────────────────────────────────────────

@sender.on_event("startup")
async def on_startup(ctx: Context):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)

    # Merge any targets from targets.json into the in-memory dict
    file_targets = load_targets_file()
    for addr, desc in file_targets.items():
        if addr not in TARGETS:
            TARGETS[addr] = desc
    if file_targets:
        print(f"[targets] loaded {len(file_targets)} targets from targets.json", flush=True)

    if not TARGETS:
        print("[outreach] No targets — listening for inbound messages.", flush=True)
        return

    wlog    = load_wallet_log()
    markets = await fetch_markets()
    print(f"[outreach] {len(markets)} markets with liquidity found.", flush=True)

    for target_addr, target_desc in list(TARGETS.items()):
        prior_bets     = None
        vara_remaining = 10.0
        prior_history  = None

        if target_addr in wlog:
            entry = wlog[target_addr]
            prior_bets     = entry.get("bets_summary", [])
            vara_remaining = float(entry.get("vara_remaining", 10.0))
            prior_history  = entry.get("conversation_history", [])
            bets_placed    = int(entry.get("bets_placed", 0))
            print(f"[outreach] {target_addr[:22]} — returning visit: {bets_placed} bets, {vara_remaining:.1f} VARA, {len(prior_history or [])} history turns.", flush=True)
            # Skip if already maxed out
            if bets_placed >= MAX_BETS and vara_remaining < 0.5:
                print(f"[outreach] {target_addr[:22]} — already maxed, skipping.", flush=True)
                continue
            # Pre-load session so handler doesn't re-register
            s = get_session(target_addr)
            s["address"]      = entry["hy4_address"]
            s["mnemonic"]     = entry["mnemonic"]
            s["vara_left"]    = vara_remaining
            s["bets_placed"]  = bets_placed
            s["wallet_saved"] = True
            s["all_bets"]     = list(prior_bets)
            s["history"]      = list(prior_history or [])
        else:
            print(f"[outreach] {target_addr[:22]} — first visit.", flush=True)

        opener = await llm_opener(markets, target_desc, prior_bets=prior_bets,
                                   vara_remaining=vara_remaining, prior_history=prior_history)
        print(f"[outreach] opener -> {target_addr[:22]}: {opener[:100]}", flush=True)
        try:
            await ctx.send(target_addr, ChatMessage(content=[TextContent(text=opener)]))
            print(f"[outreach] sent to {target_addr[:22]}.", flush=True)
        except Exception as e:
            print(f"[outreach] send failed for {target_addr[:22]}: {e}", flush=True)


# ── Hot-reload: watch targets.json every 30s ───────────────────────────────────

_targets_mtime: float = 0.0


async def _send_opener_to(ctx: Context, addr: str, desc: str,
                           wlog: dict, markets: list[dict]):
    """Register session state and send opener to a newly discovered target."""
    prior_bets     = None
    vara_remaining = 10.0
    prior_history  = None

    if addr in wlog:
        entry = wlog[addr]
        prior_bets     = entry.get("bets_summary", [])
        vara_remaining = float(entry.get("vara_remaining", 10.0))
        prior_history  = entry.get("conversation_history", [])
        bets_placed    = int(entry.get("bets_placed", 0))
        if bets_placed >= MAX_BETS and vara_remaining < 0.5:
            print(f"[hot-reload] {addr[:22]} — already maxed, skipping.", flush=True)
            return
        s = get_session(addr)
        s["address"]      = entry["hy4_address"]
        s["mnemonic"]     = entry["mnemonic"]
        s["vara_left"]    = vara_remaining
        s["bets_placed"]  = bets_placed
        s["wallet_saved"] = True
        s["all_bets"]     = list(prior_bets)
        s["history"]      = list(prior_history or [])
        print(f"[hot-reload] {addr[:22]} — returning: {bets_placed} bets, {vara_remaining:.1f} VARA", flush=True)
    else:
        print(f"[hot-reload] {addr[:22]} — first visit.", flush=True)

    opener = await llm_opener(markets, desc, prior_bets=prior_bets,
                               vara_remaining=vara_remaining, prior_history=prior_history)
    print(f"[hot-reload] opener -> {addr[:22]}: {opener[:80]}", flush=True)
    try:
        await ctx.send(addr, ChatMessage(content=[TextContent(text=opener)]))
        print(f"[hot-reload] sent to {addr[:22]}.", flush=True)
    except Exception as e:
        print(f"[hot-reload] send failed for {addr[:22]}: {e}", flush=True)


@sender.on_interval(period=30.0)
async def hot_reload_targets(ctx: Context):
    """Check targets.json for newly added agents and contact them without a restart."""
    global _targets_mtime
    try:
        mtime = os.path.getmtime(TARGETS_FILE)
    except FileNotFoundError:
        return
    if mtime <= _targets_mtime:
        return  # file unchanged
    _targets_mtime = mtime

    file_targets = load_targets_file()
    new_addrs    = [a for a in file_targets if a not in TARGETS]
    if not new_addrs:
        return

    print(f"[hot-reload] targets.json changed — {len(new_addrs)} new agent(s) detected.", flush=True)
    wlog    = load_wallet_log()
    markets = await fetch_markets()

    for addr in new_addrs:
        desc = file_targets[addr]
        TARGETS[addr] = desc
        await _send_opener_to(ctx, addr, desc, wlog, markets)


# ── Inbound message handler ────────────────────────────────────────────────────

@proto.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender_addr: str, ack: ChatAcknowledgement):
    pass  # required for protocol verification


@proto.on_message(ChatMessage)
async def on_message(ctx: Context, sender_addr: str, msg: ChatMessage):
    # Acknowledge
    await ctx.send(sender_addr, ChatAcknowledgement(
        timestamp=msg.timestamp,
        acknowledged_msg_id=msg.msg_id,
    ))

    text = " ".join(b.text for b in msg.content if hasattr(b, "text")).strip()
    if not text:
        return

    print(f"[<- {sender_addr[:22]}] {text[:120]}", flush=True)

    s = get_session(sender_addr)

    # ── If we already sent the closing, ignore further messages ──────────
    if s.get("done"):
        print(f"[outreach] session closed for {sender_addr[:22]} — ignoring.", flush=True)
        return

    s["turns"] = s.get("turns", 0) + 1

    # ── Hard turn cap — force a bet or close after MAX_TURNS ─────────────
    MAX_TURNS = 5
    if s["turns"] > MAX_TURNS and s["bets_placed"] == 0:
        # No bets placed after MAX_TURNS — fetch ANY market (ignore liquidity filter)
        try:
            async with httpx.AsyncClient(timeout=12) as _c:
                _r = await _c.get(f"{HY4_SERVER}/api/agent/markets")
                _d = _r.json()
                all_markets = _d if isinstance(_d, list) else _d.get("markets", [])
        except Exception:
            all_markets = []
        markets = all_markets if all_markets else await fetch_markets()
        if markets and s.get("address"):
            m = markets[0]
            market_id = int(m.get("id", 0))
            outcome   = "A"
            amount    = min(DEFAULT_BET, s["vara_left"], 5.0)
            print(f"[outreach] turn cap hit for {sender_addr[:22]} — forcing bet #{market_id}", flush=True)
            result = await place_bet(s["address"], s["mnemonic"], market_id, outcome, amount)
            if result.get("txHash") or result.get("success"):
                s["bets_placed"] += 1
                s["vara_left"]   -= amount
                bet_record = {"marketId": market_id, "outcome": outcome, "amount": amount,
                              "txHash": result.get("txHash",""), "placedAt": datetime.now(timezone.utc).isoformat()}
                s["all_bets"].append(bet_record)
                wlog = load_wallet_log()
                if sender_addr in wlog:
                    entry = wlog[sender_addr]
                    entry["bets_placed"] = s["bets_placed"]
                    entry["vara_remaining"] = s["vara_left"]
                    entry["last_bet"] = datetime.now(timezone.utc).isoformat()
                    entry.setdefault("bets_summary", []).append(bet_record)
                    save_wallet_log(wlog)
        closing = await llm_closing(await fetch_markets(), s, TARGETS.get(sender_addr, ""))
        s["done"] = True
        save_conversation_history(sender_addr, s["history"])
        await send(ctx, sender_addr, closing)
        return

    # ── Ensure wallet exists ─────────────────────────────────────────────
    if s["address"] is None:
        wlog = load_wallet_log()
        if sender_addr in wlog:
            e = wlog[sender_addr]
            s["address"]      = e["hy4_address"]
            s["mnemonic"]     = e["mnemonic"]
            s["vara_left"]    = float(e.get("vara_remaining", e.get("vara_funded", 10.0)))
            s["bets_placed"]  = int(e.get("bets_placed", 0))
            s["all_bets"]     = list(e.get("bets_summary", []))
            s["wallet_saved"] = True
            print(f"[wallet] reused existing wallet for {sender_addr[:22]} — {s['bets_placed']} prior bets, {s['vara_left']:.1f} VARA left", flush=True)
        else:
            print(f"[wallet] registering new wallet for {sender_addr[:22]}...", flush=True)
            reg = await register_wallet(sender_addr)
            if "error" in reg:
                print(f"[wallet] registration failed: {reg['error']}", flush=True)
                # Don't block the conversation — carry on without wallet for now
            else:
                s["address"]  = reg.get("address")
                s["mnemonic"] = reg.get("mnemonic")
                s["vara_left"] = 10.0
                wlog[sender_addr] = {
                    "hy4_address":  s["address"],
                    "mnemonic":     s["mnemonic"],
                    "vara_funded":  10.0,
                    "vara_remaining": 10.0,
                    "first_seen":   datetime.now(timezone.utc).isoformat(),
                    "fetchai_addr": sender_addr,
                    "bets_placed":  0,
                    "bets_summary": [],
                    "notes":        f"Auto-registered via LLM conversation. Target: {TARGET_DESC[:60]}",
                }
                save_wallet_log(wlog)
                print(f"[wallet] registered {s['address']} for {sender_addr[:22]}", flush=True)

    # ── Fetch live markets ───────────────────────────────────────────────
    markets = await fetch_markets()

    # ── Determine which agent description to use ─────────────────────────
    desc = TARGETS.get(sender_addr) or f"an AI agent at {sender_addr[:22]}"

    # ── Ask Claude what to say ────────────────────────────────────────────
    llm_out = await llm_respond(markets, s, text, desc)

    # Update history
    s["history"].append({"role": "user",      "content": text})
    s["history"].append({"role": "assistant",  "content": llm_out})
    # Save to disk every turn so history survives crashes / token limit kills
    if s.get("wallet_saved") or s.get("address"):
        save_conversation_history(sender_addr, s["history"])

    # ── Check if Claude wants to place a bet ─────────────────────────────
    bet = parse_bet_action(llm_out)
    visible_reply = strip_action(llm_out)

    if bet and s["address"] and s["bets_placed"] < MAX_BETS and s["vara_left"] >= 0.5:
        market_id = int(bet.get("marketId", 0))
        outcome   = str(bet.get("outcome", "A")).upper()
        amount    = min(float(bet.get("amount", DEFAULT_BET)), s["vara_left"], 5.0)

        if market_id and outcome in ("A", "B") and amount >= 0.5:
            print(f"[bet] Claude triggered: #{market_id} {outcome} {amount}V for {sender_addr[:22]}", flush=True)
            result = await place_bet(s["address"], s["mnemonic"], market_id, outcome, amount)

            if result.get("txHash") or result.get("success"):
                s["bets_placed"] += 1
                s["vara_left"]   -= amount
                bet_record = {
                    "marketId": market_id, "outcome": outcome,
                    "amount": amount, "txHash": result.get("txHash", ""),
                    "placedAt": datetime.now(timezone.utc).isoformat(),
                }
                s["all_bets"].append(bet_record)

                # Update wallet log
                wlog = load_wallet_log()
                if sender_addr in wlog:
                    entry = wlog[sender_addr]
                    entry["bets_placed"]    = s["bets_placed"]
                    entry["vara_remaining"] = s["vara_left"]
                    entry["last_bet"]       = datetime.now(timezone.utc).isoformat()
                    entry.setdefault("bets_summary", []).append(bet_record)
                    save_wallet_log(wlog)

                side = "Yes" if outcome == "A" else "No"
                mq = next((m.get("question","") for m in markets
                           if str(m.get("id")) == str(market_id)), f"market #{market_id}")
                bet_confirm = (
                    f"\n\n[Bet placed on-chain] {amount:.1f} VARA on **{side}** — "
                    f"*{mq[:55]}* ✓"
                )
                visible_reply = (visible_reply or "") + bet_confirm
                print(f"[bet] confirmed tx={result.get('txHash','')[:18]}...", flush=True)
            else:
                err = result.get("error", "unknown")
                print(f"[bet] failed: {err}", flush=True)
                visible_reply = (visible_reply or "") + \
                    f"\n\n(Tried to place a bet but hit an issue: {err[:60]})"

    # ── Check if we've maxed out — send closing and stop ─────────────────
    maxed = s["bets_placed"] >= MAX_BETS or s["vara_left"] < 0.5
    if maxed and not s.get("done"):
        closing = await llm_closing(markets, s, desc)
        s["done"] = True
        # Persist full conversation history so we can resume next session
        save_conversation_history(sender_addr, s["history"])
        print(f"[outreach] max bets reached for {sender_addr[:22]} — closing + saving history.", flush=True)
        await send(ctx, sender_addr, closing)
        return

    if visible_reply:
        await send(ctx, sender_addr, visible_reply)


# ── Run ────────────────────────────────────────────────────────────────────────
sender.include(proto, publish_manifest=True)

if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    sender.run()
