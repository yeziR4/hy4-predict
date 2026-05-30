"""
hy4-predict Fetch.ai Chat Agent — "Mandingo"
Handles the full onboarding + betting conversation autonomously.
Each incoming chat gets live market data injected into every LLM call.
"""

import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from anthropic import AsyncAnthropic
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

# ── Config ─────────────────────────────────────────────────────────────────────
HY4_SERVER       = os.getenv("HY4_SERVER_URL", "http://localhost:3001")
ANTHROPIC_KEY    = os.getenv("ANTHROPIC_API_KEY", "")
AGENT_SECRET     = os.getenv("AGENT_SECRET",   "mandingo-hy4-secret-2026")
MAILBOX_KEY      = os.getenv("AGENT_MAILBOX_KEY", "")
WALLET_LOG_FILE  = os.getenv("WALLET_LOG_FILE",
                              os.path.join(os.path.dirname(__file__), "agent-wallet-log.json"))

DEFAULT_BET_VARA     = float(os.getenv("DEFAULT_BET_VARA", "1.0"))
MAX_BETS_PER_SESSION = int(os.getenv("MAX_BETS_PER_SESSION", "5"))
CONVERSATION_TTL_S   = 60 * 30  # 30 min idle → forget in-memory session

ai_client = AsyncAnthropic(api_key=ANTHROPIC_KEY)

agent = Agent(
    name="mandingo",
    seed=AGENT_SECRET,
    mailbox=True,   # signs with seed identity — no key string needed
)

chat_protocol = Protocol(spec=chat_protocol_spec)

# ── Persistent agent-wallet log ────────────────────────────────────────────────
# Survives restarts.  Maps fetchai_agent_address → { hy4_address, mnemonic, ... }
def _load_wallet_log() -> dict:
    try:
        with open(WALLET_LOG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def _save_wallet_log(log: dict) -> None:
    try:
        with open(WALLET_LOG_FILE, "w") as f:
            json.dump(log, f, indent=2)
    except Exception as e:
        print(f"[wallet-log] save failed: {e}")

# Per-sender conversation state (in-memory only — ephemeral between restarts)
# { sender: { address, mnemonic, history: [...], last_active, bets_placed, vara_left } }
_sessions: dict[str, dict[str, Any]] = {}


# ── Helpers ────────────────────────────────────────────────────────────────────

async def fetch_hot_markets() -> list[dict]:
    """Top 10 soonest-closing markets from hy4-predict."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{HY4_SERVER}/api/agent/markets")
            r.raise_for_status()
            data = r.json()
            # Endpoint returns a plain list
            return data if isinstance(data, list) else data.get("markets", [])
    except Exception as e:
        print(f"[markets] fetch error: {e}")
        return []


def format_markets_for_llm(markets: list[dict]) -> str:
    """Convert market list to a compact, LLM-readable block."""
    if not markets:
        return "No markets currently available."
    lines = []
    for m in markets:
        mid     = m.get("id") or m.get("marketId", "?")
        q       = m.get("question", "Unknown question")
        pool    = float(m.get("totalPool", 0))
        a_pct   = float(m.get("percentA") or m.get("aPercent") or 50)
        b_pct   = 100 - a_pct
        label_a = m.get("outcomeA") or m.get("outcomeALabel", "YES")
        label_b = m.get("outcomeB") or m.get("outcomeBLabel", "NO")
        # closingLabel = "Today" / "Tomorrow" / "3d left" etc.
        closes  = m.get("closingLabel") or m.get("closesIn", "")
        urgency = f" ⏰ {closes}" if closes else ""
        lines.append(
            f"  #{mid}: \"{q}\"\n"
            f"    Pool: {pool:.1f} VARA | "
            f"{label_a}: {a_pct:.0f}% (A) | "
            f"{label_b}: {b_pct:.0f}% (B){urgency}"
        )
    return "\n".join(lines)


def _closes_in(end_date_str: str | None) -> str:
    if not end_date_str:
        return ""
    try:
        end = datetime.fromisoformat(end_date_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        diff = end - now
        hours = diff.total_seconds() / 3600
        if hours < 0:
            return "already closed"
        if hours < 1:
            return f"closes in {int(diff.total_seconds()/60)}m"
        if hours < 48:
            return f"closes in {int(hours)}h"
        return f"closes in {int(hours/24)}d"
    except Exception:
        return ""


def build_system_prompt(markets: list[dict]) -> str:
    market_block = format_markets_for_llm(markets)
    return f"""You are Mandingo — the friendly AI agent for hy4-predict, a LIVE on-chain prediction market running on Vara Network.

IMPORTANT CONTEXT:
- This is a FUN hackathon experiment. Nothing real is on the line.
- Every new user gets **10 FREE VARA** (no credit card, no signup). Bets start at just 1 VARA.
- Markets use parimutuel pools — bet on the winning side and your share grows.
- This is decentralised & on-chain: bets are real blockchain transactions.

YOUR JOB:
1. Make the user excited to place a bet — it's free money, why not?
2. Show them concrete markets with closing times to create urgency.
3. Once they pick a market + side, call the PLACE_BET action.
4. After each bet, show their potential payout and nudge them to bet again.
5. Keep the conversation fun, short, and punchy. No walls of text.

LIVE MARKETS RIGHT NOW:
{market_block}

IMPORTANT RULES:
- Default bet is {DEFAULT_BET_VARA} VARA unless the user specifies a different amount (max 5 VARA per bet, keep it fun).
- Outcome A = first option (often YES/Team A), Outcome B = second option (often NO/Team B).
- If the user says something like "#1467 YES", "#1466 A", "bet on market 1466 no", or "market 1467 team a" — that's a bet!
- When you detect a bet intent, respond ONLY with a JSON action block (no prose around it):
  ACTION:PLACE_BET:{{"marketId":<number>,"outcome":"A"|"B","amount":<number>}}
- When you want to greet a new user, respond ONLY with:
  ACTION:GREET
- Keep every text response under 120 words.
- Never invent market IDs that aren't in the list above.
- Be honest that you're an AI agent running in a hackathon demo.
"""


async def llm_reply(system: str, history: list[dict], user_msg: str) -> str:
    """Call Claude (Anthropic) with conversation history."""
    messages = list(history[-12:])  # keep last 6 exchanges
    messages.append({"role": "user", "content": user_msg})
    try:
        resp = await ai_client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=300,
            system=system,
            messages=messages,
        )
        return resp.content[0].text.strip()
    except Exception as e:
        return f"[LLM error: {e}]"


async def quick_start(sender: str) -> dict:
    """Register a fresh wallet for this sender via /api/agent/quick-start."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{HY4_SERVER}/api/agent/quick-start",
                json={"agentId": sender},
            )
            r.raise_for_status()
            return r.json()
    except Exception as e:
        return {"error": str(e)}


async def place_bet(address: str, mnemonic: str, market_id: int, outcome: str, amount: float) -> dict:
    """Place a bet via /api/agent/bet."""
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{HY4_SERVER}/api/agent/bet",
                json={
                    "address":  address,
                    "mnemonic": mnemonic,
                    "marketId": market_id,
                    "outcome":  outcome,
                    "amount":   amount,
                },
            )
            r.raise_for_status()
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def extract_bet_action(llm_output: str) -> dict | None:
    """Parse ACTION:PLACE_BET:{...} from LLM output."""
    m = re.search(r"ACTION:PLACE_BET:\s*(\{.*?\})", llm_output, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    return None


def session_for(sender: str) -> dict:
    """Get or create a session for a sender, pruning stale ones."""
    now = time.time()
    # Prune idle sessions
    stale = [k for k, v in _sessions.items()
             if now - v.get("last_active", 0) > CONVERSATION_TTL_S]
    for k in stale:
        del _sessions[k]

    if sender not in _sessions:
        _sessions[sender] = {
            "address":     None,
            "mnemonic":    None,
            "history":     [],
            "last_active": now,
            "bets_placed": 0,
            "vara_left":   10.0,  # assume 10 VARA faucet
        }
    else:
        _sessions[sender]["last_active"] = now
    return _sessions[sender]


# ── Chat protocol handlers ─────────────────────────────────────────────────────

@chat_protocol.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, ack: ChatAcknowledgement):
    """Silently accept acknowledgements."""
    pass


@chat_protocol.on_message(ChatMessage)
async def on_chat_message(ctx: Context, sender: str, msg: ChatMessage):
    # Acknowledge immediately
    await ctx.send(sender, ChatAcknowledgement(
        timestamp=msg.timestamp,
        acknowledged_msg_id=msg.msg_id,
    ))

    # Extract text content
    user_text = ""
    for block in msg.content:
        if hasattr(block, "text"):
            user_text += block.text + " "
    user_text = user_text.strip()
    if not user_text:
        return

    ctx.logger.info(f"[chat] {sender[:16]}…: {user_text[:80]}")

    session = session_for(sender)

    # ── Step 1: Register if first time ────────────────────────────────────────
    if session["address"] is None:
        # Check persistent log first — never create two wallets for the same agent
        wallet_log = _load_wallet_log()
        if sender in wallet_log:
            entry = wallet_log[sender]
            session["address"]  = entry["hy4_address"]
            session["mnemonic"] = entry["mnemonic"]
            session["vara_left"] = float(entry.get("vara_funded", 10.0))
            ctx.logger.info(f"[wallet-log] reusing existing wallet for {sender[:20]}…")
            qs = {"hotMarkets": [], "funded": 0, "isNew": False}
        else:
            qs = await quick_start(sender)
            if "error" in qs:
                await ctx.send(sender, ChatMessage(content=[
                    TextContent(text=f"Sorry, I couldn't set up your account: {qs['error']}")
                ]))
                return

            session["address"]  = qs.get("address")
            session["mnemonic"] = qs.get("mnemonic")
            funded = qs.get("funded", 0)
            session["vara_left"] = float(funded) if funded else 10.0

            # Persist to log
            wallet_log[sender] = {
                "hy4_address":  session["address"],
                "mnemonic":     session["mnemonic"],
                "vara_funded":  session["vara_left"],
                "first_seen":   datetime.now(timezone.utc).isoformat(),
                "is_new":       qs.get("isNew", True),
            }
            _save_wallet_log(wallet_log)
            ctx.logger.info(f"[wallet-log] registered new wallet for {sender[:20]}… → {session['address']}")

        # Build warm opener from live markets
        markets   = await fetch_hot_markets()
        hot       = qs.get("hotMarkets", markets[:3]) or markets[:3]
        system    = build_system_prompt(markets)
        llm_out   = await llm_reply(system, [], "ACTION:GREET")

        if "ACTION:GREET" in llm_out or not llm_out.strip():
            # Fallback opener if LLM echoed the action back
            if hot:
                m0 = hot[0]
                closes = _closes_in(m0.get("endDate") or m0.get("enddate"))
                llm_out = (
                    f"🎯 You're in! Got you **{session['vara_left']:.0f} free VARA** on Vara Network.\n\n"
                    f"Hot right now: **#{m0.get('id') or m0.get('marketId')} — {m0.get('question', '')}** "
                    f"({closes or 'closing soon'})\n"
                    f"Just say **\"#{m0.get('id') or m0.get('marketId')} YES\"** or **\"#{m0.get('id') or m0.get('marketId')} NO\"** to bet 1 VARA. Go!"
                )
            else:
                llm_out = (
                    f"🎯 You're in! Got you **{session['vara_left']:.0f} free VARA** on Vara Network.\n\n"
                    f"Real on-chain prediction markets, totally free for you. Say a market ID + YES/NO to place your bet!"
                )

        session["history"].append({"role": "assistant", "content": llm_out})
        await ctx.send(sender, ChatMessage(content=[TextContent(text=llm_out)]))
        return

    # ── Step 2: Normal turn — inject live markets into every LLM call ─────────
    markets = await fetch_hot_markets()
    system  = build_system_prompt(markets)

    llm_out = await llm_reply(system, session["history"], user_text)
    session["history"].append({"role": "user",      "content": user_text})
    session["history"].append({"role": "assistant", "content": llm_out})

    # ── Step 3: Check if LLM decided to place a bet ───────────────────────────
    bet = extract_bet_action(llm_out)
    if bet and session["bets_placed"] < MAX_BETS_PER_SESSION:
        market_id = int(bet.get("marketId", 0))
        outcome   = str(bet.get("outcome", "A")).upper()
        amount    = float(bet.get("amount", DEFAULT_BET_VARA))
        amount    = min(amount, session["vara_left"], 5.0)

        if market_id and outcome in ("A", "B") and amount >= 0.1:
            # Place the bet
            result = await place_bet(
                session["address"], session["mnemonic"],
                market_id, outcome, amount
            )

            if result.get("success") or result.get("txHash"):
                session["bets_placed"] += 1
                session["vara_left"]   -= amount

                # Update persistent log with bet stats
                wlog = _load_wallet_log()
                if sender in wlog:
                    wlog[sender]["bets_placed"]  = session["bets_placed"]
                    wlog[sender]["last_bet"]      = datetime.now(timezone.utc).isoformat()
                    wlog[sender]["last_market"]   = market_id
                    wlog[sender]["last_outcome"]  = outcome
                    _save_wallet_log(wlog)

                # Build a human-readable reply
                payout_hint = ""
                potential = result.get("potentialPayout") or result.get("potential_payout")
                if potential:
                    payout_hint = f" If you're right, you collect **{float(potential):.2f} VARA**."

                market_q = next(
                    (m.get("question", f"market #{market_id}")
                     for m in markets if (m.get("id") or m.get("marketId")) == market_id),
                    f"market #{market_id}"
                )
                side_label = "YES/A" if outcome == "A" else "NO/B"

                reply = (
                    f"✅ **Bet placed!** {amount:.1f} VARA on **{side_label}** for *{market_q}*."
                    f"{payout_hint}\n\n"
                    f"You have **{session['vara_left']:.1f} VARA** left. "
                )
                if session["vara_left"] >= 0.5 and session["bets_placed"] < MAX_BETS_PER_SESSION:
                    # Nudge next bet
                    remaining = [m for m in markets
                                 if (m.get("id") or m.get("marketId")) != market_id]
                    if remaining:
                        nxt = remaining[0]
                        closes = nxt.get("closingLabel") or _closes_in(nxt.get("endDate"))
                        reply += (
                            f"Another hot one: **#{nxt.get('id') or nxt.get('marketId')} — "
                            f"{nxt.get('question', '')}** ({closes or 'closing soon'}). "
                            f"Say **YES** or **NO**!"
                        )
                    else:
                        reply += "Say another market ID + YES/NO to keep going!"
                else:
                    reply += "That's the full run — nice moves! 🏆"

                await ctx.send(sender, ChatMessage(content=[TextContent(text=reply)]))
                return
            else:
                err = result.get("error", "unknown error")
                reply = f"⚠️ Couldn't place that bet: {err}. Try a different market or amount?"
                await ctx.send(sender, ChatMessage(content=[TextContent(text=reply)]))
                return

    # ── Step 4: Plain LLM reply (no bet detected) ─────────────────────────────
    # Strip action tags from prose before sending
    clean = re.sub(r"ACTION:\w+[:\{][^\n]*", "", llm_out).strip()
    if not clean:
        clean = "I'm not sure I caught that — try saying something like \"#1467 YES\" to place a bet!"

    await ctx.send(sender, ChatMessage(content=[TextContent(text=clean)]))


# ── Run ────────────────────────────────────────────────────────────────────────
agent.include(chat_protocol, publish_manifest=True)

if __name__ == "__main__":
    print(f"[mandingo] agent address: {agent.address}")
    print(f"[mandingo] hy4 server:    {HY4_SERVER}")
    agent.run()
