"""
batch_outreach.py — Scale hy4-predict outreach to many Fetch.ai agents at once.

Usage:
  python batch_outreach.py agent1q...aaa agent1q...bbb agent1q...ccc
  python batch_outreach.py --file agents.txt          # one address per line
  python batch_outreach.py --follow-up                # re-bet all agents with VARA left

What it does per agent:
  1. Checks agent-wallet-log.json → skip if already fully onboarded
  2. Calls /api/agent/register  → fresh Vara wallet + 10 VARA faucet
  3. Spreads bets across the top open markets (up to MAX_BETS)
  4. Writes results to agent-wallet-log.json
  5. Prints a summary table at the end
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

# ── Config ─────────────────────────────────────────────────────────────────────
HY4_SERVER      = os.getenv("HY4_SERVER_URL", "http://127.0.0.1:3001")
WALLET_LOG_FILE = os.getenv("WALLET_LOG_FILE",
                             str(Path(__file__).parent / "agent-wallet-log.json"))
MAX_BETS        = int(os.getenv("MAX_BETS_PER_AGENT", "4"))
BET_AMOUNT      = float(os.getenv("BET_AMOUNT_VARA", "1.5"))
DELAY_BETWEEN   = float(os.getenv("DELAY_BETWEEN_BETS_S", "2"))

# Bet strategy: spread across different markets with alternating YES/NO for drama
# Format: (marketId, outcome, label)
# Loaded dynamically from /api/agent/markets, but fallback hardcoded here
STRATEGY = [
    # (None means: pick from live markets dynamically)
]


def load_log() -> dict:
    try:
        return json.loads(Path(WALLET_LOG_FILE).read_text())
    except Exception:
        return {}


def save_log(log: dict):
    Path(WALLET_LOG_FILE).write_text(json.dumps(log, indent=2))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_markets(client: httpx.Client) -> list[dict]:
    try:
        r = client.get(f"{HY4_SERVER}/api/agent/markets",
                       timeout=httpx.Timeout(connect=10, read=30, write=10, pool=10))
        r.raise_for_status()
        d = r.json()
        return d if isinstance(d, list) else d.get("markets", [])
    except Exception as e:
        print(f"  [!] markets fetch failed: {e}")
        return []


def register(client: httpx.Client, agent_addr: str) -> dict | None:
    """Register a new Vara wallet for this Fetch.ai agent."""
    try:
        r = client.post(
            f"{HY4_SERVER}/api/agent/register",
            json={"agentId": agent_addr},
            timeout=60,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  [!] register failed: {e}")
        return None


def place_bet(client: httpx.Client, address: str, mnemonic: str,
              market_id: int, outcome: str, amount: float) -> dict:
    try:
        r = client.post(
            f"{HY4_SERVER}/api/agent/bet",
            json={"address": address, "mnemonic": mnemonic,
                  "marketId": market_id, "outcome": outcome, "amount": amount},
            timeout=90,
        )
        if r.status_code >= 400:
            # Try to get the JSON error body
            try:
                body = r.json()
                return {"error": body.get("error", body)}
            except Exception:
                return {"error": f"HTTP {r.status_code}: {r.text[:200]}"}
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def pick_bets(markets: list[dict], existing_bets: list[dict], n: int) -> list[tuple]:
    """
    Pick n markets to bet on, alternating YES/NO, avoiding duplicates.
    Returns [(market_id, outcome, question_short), ...]
    """
    already = {b["marketId"] for b in existing_bets}
    picks = []
    for i, m in enumerate(markets):
        mid = m.get("id")
        if mid in already:
            continue
        # Alternate: even index = A (YES), odd index = B (NO)
        # But if pool is very one-sided (>90%) follow the crowd
        a_pct = float(m.get("percentA") or 50)
        if a_pct >= 85:
            outcome = "A"
        elif a_pct <= 15:
            outcome = "B"
        else:
            outcome = "A" if len(picks) % 2 == 0 else "B"
        picks.append((mid, outcome, m.get("question", "?")[:50]))
        if len(picks) >= n:
            break
    return picks


def onboard_agent(agent_addr: str, log: dict, markets: list[dict],
                  client: httpx.Client, follow_up: bool = False) -> dict:
    """Register + bet for one Fetch.ai agent. Returns result summary."""
    print(f"\n{'─'*60}")
    print(f"Agent: {agent_addr[:28]}...{agent_addr[-8:]}")

    existing = log.get(agent_addr)
    address, mnemonic, funded_vara = None, None, 10.0

    if existing:
        address  = existing["hy4_address"]
        mnemonic = existing["mnemonic"]
        funded_vara = float(existing.get("vara_funded", 10.0))
        existing_bets = existing.get("bets_summary", [])
        bets_placed = existing.get("bets_placed", 0)
        print(f"  Wallet: {address[:20]}... (existing)")
        if not follow_up and bets_placed >= MAX_BETS:
            print(f"  Already placed {bets_placed} bets — skipping (use --follow-up to add more)")
            return {"status": "skipped", "address": address, "bets": bets_placed}
    else:
        print(f"  Registering new wallet...")
        reg = register(client, agent_addr)
        if not reg or "address" not in reg:
            print(f"  [!] Registration failed")
            return {"status": "failed"}
        address  = reg["address"]
        mnemonic = reg["mnemonic"]
        funded_vara = float(reg.get("balance", "10").split()[0])
        existing_bets = []
        bets_placed = 0
        print(f"  Wallet: {address}")
        print(f"  Funded: {funded_vara} VARA")

        # Save to log immediately
        log[agent_addr] = {
            "hy4_address":  address,
            "mnemonic":     mnemonic,
            "vara_funded":  funded_vara,
            "first_seen":   now_iso(),
            "fetchai_addr": agent_addr,
            "bets_placed":  0,
            "bets_summary": [],
        }
        save_log(log)

    # Pick markets to bet on
    slots_left = MAX_BETS - (0 if follow_up else bets_placed)
    if slots_left <= 0 and not follow_up:
        print(f"  No bet slots left.")
        return {"status": "done", "address": address, "bets": bets_placed}

    picks = pick_bets(markets, existing_bets, MAX_BETS if follow_up else slots_left)
    if not picks:
        print(f"  No markets to bet on.")
        return {"status": "no_markets", "address": address, "bets": bets_placed}

    print(f"  Placing {len(picks)} bets...")
    placed = []
    for market_id, outcome, q in picks:
        side = "YES" if outcome == "A" else "NO"
        print(f"    #{market_id} {side} {BET_AMOUNT}V — {q}")
        res = place_bet(client, address, mnemonic, market_id, outcome, BET_AMOUNT)
        if res.get("txHash"):
            print(f"    OK: {res['txHash'][:22]}...")
            placed.append({"marketId": market_id, "outcome": outcome, "amount": BET_AMOUNT,
                           "txHash": res["txHash"], "placedAt": now_iso()})
        else:
            err = res.get("error", "?")
            if "balance" in str(err).lower() or "1010" in str(err):
                print(f"    [!] Insufficient balance — stopping")
                break
            print(f"    [!] {str(err)[:80]}")
        time.sleep(DELAY_BETWEEN)

    # Update log
    log[agent_addr].update({
        "bets_placed":  (log[agent_addr].get("bets_placed", 0) or 0) + len(placed),
        "last_bet":     now_iso() if placed else log[agent_addr].get("last_bet"),
        "bets_summary": (log[agent_addr].get("bets_summary", []) or []) + placed,
    })
    save_log(log)

    total = (log[agent_addr].get("bets_placed") or 0)
    print(f"  Done. Total bets: {total} | This run: {len(placed)}")
    return {"status": "ok", "address": address, "bets": total, "placed_now": len(placed)}


def main():
    parser = argparse.ArgumentParser(description="Batch onboard Fetch.ai agents onto hy4-predict")
    parser.add_argument("agents", nargs="*", help="Fetch.ai agent addresses to onboard")
    parser.add_argument("--file", "-f", help="Text file with one agent address per line")
    parser.add_argument("--follow-up", action="store_true",
                        help="Re-bet all agents in wallet log that still have VARA")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would happen without placing bets")
    args = parser.parse_args()

    # Collect targets
    targets: list[str] = list(args.agents)

    if args.file:
        try:
            targets += [l.strip() for l in Path(args.file).read_text().splitlines()
                        if l.strip() and not l.startswith("#")]
        except Exception as e:
            print(f"[!] Could not read file {args.file}: {e}")

    log = load_log()

    if args.follow_up:
        # Add all agents already in log
        existing_in_log = [a for a in log if a not in targets]
        print(f"[follow-up] Adding {len(existing_in_log)} agents from wallet log")
        targets = targets + existing_in_log

    if not targets:
        print("No agent addresses provided. Usage:")
        print("  python batch_outreach.py agent1q...aaa agent1q...bbb")
        print("  python batch_outreach.py --file agents.txt")
        print("  python batch_outreach.py --follow-up")
        sys.exit(1)

    # De-duplicate
    seen = set()
    targets = [t for t in targets if not (t in seen or seen.add(t))]

    print(f"[batch] Processing {len(targets)} agent(s)")
    print(f"[batch] Server: {HY4_SERVER}")
    print(f"[batch] Max bets per agent: {MAX_BETS} @ {BET_AMOUNT} VARA each")

    if args.dry_run:
        print("\n[DRY RUN] Would process:")
        for t in targets:
            status = "existing" if t in log else "new"
            print(f"  {t[:32]}... [{status}]")
        sys.exit(0)

    results = []
    with httpx.Client(timeout=httpx.Timeout(connect=15, read=90, write=15, pool=15)) as client:
        markets = get_markets(client)
        if not markets:
            print("[!] Could not fetch markets. Is the server running?")
            sys.exit(1)
        print(f"[batch] {len(markets)} open markets available")

        for i, agent_addr in enumerate(targets):
            result = onboard_agent(agent_addr, log, markets, client,
                                   follow_up=args.follow_up)
            results.append({"agent": agent_addr, **result})
            if i < len(targets) - 1:
                time.sleep(1)  # small gap between agents

    # Summary
    print(f"\n{'='*60}")
    print(f"BATCH SUMMARY ({len(results)} agents)")
    print(f"{'='*60}")
    ok      = [r for r in results if r["status"] == "ok"]
    skipped = [r for r in results if r["status"] == "skipped"]
    failed  = [r for r in results if r["status"] in ("failed", "no_markets")]
    print(f"  Onboarded:  {len(ok)}")
    print(f"  Skipped:    {len(skipped)}")
    print(f"  Failed:     {len(failed)}")
    total_bets = sum(r.get("placed_now", 0) for r in ok)
    print(f"  Bets placed this run: {total_bets}")
    print(f"\nWallet log: {WALLET_LOG_FILE}")
    print(f"Leaderboard: {HY4_SERVER}/leaderboard.html")


if __name__ == "__main__":
    main()
