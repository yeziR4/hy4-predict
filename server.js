'use strict';
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const bip39    = require('bip39');
const { execSync, exec } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const NETWORK       = process.env.VARA_NETWORK || 'mainnet';
const FUNDER_WALLET = process.env.FUNDER_WALLET || 'hy4-agent';
const FUNDER_MN     = process.env.FUNDER_MNEMONIC || '';
const FUNDER_SEED   = process.env.FUNDER_SEED   || '';    // 0x… hex seed (alternative to mnemonic)
const FUNDER_JSON   = process.env.FUNDER_WALLET_JSON || ''; // base64 PKCS8 wallet file (Railway)
const PID_V1        = (process.env.PROGRAM_ID_V1 || '0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6').trim();
const PID_V2        = (process.env.PROGRAM_ID_V2 || '0xd24f2886dcb29dec16fc53214b7c8e498b2e96ea55d31a1497571e1ae15f5271').trim();
const FAUCET_VARA   = Number(process.env.FAUCET_AMOUNT_VARA || 10);

// vara-wallet binary
const VW_GLOBAL = 'C:\\nvm4w\\nodejs\\node_modules\\vara-wallet\\dist\\app.js';
let VW_SCRIPT;
try {
  VW_SCRIPT = require.resolve('vara-wallet/dist/app.js');
} catch {
  VW_SCRIPT = VW_GLOBAL;
}
const NODE = process.execPath;

const IDL_PATH        = path.join(__dirname, 'hy4_predict.idl');
const FUNDED_FILE     = path.join(__dirname, 'funded.json');
const IP_SESSION_FILE = path.join(__dirname, 'ip-sessions.json');
const BETS_FILE         = path.join(__dirname, 'bets.json');
const POLY_SYNC_FILE    = path.join(__dirname, 'polymarket-sync.json');
const MARKETS_META_FILE = path.join(__dirname, 'markets-meta.json');
const RESOLUTIONS_FILE  = path.join(__dirname, 'resolutions.json');

const ADMIN_KEY = process.env.ADMIN_KEY || 'hy4-admin-2026';

// Classify a Polymarket question into one of our categories by keyword matching.
// Polymarket's `category` field is unreliable (often empty) — so we ignore it.
const POLY_CAT_KEYWORDS = {
  crypto:        /\b(btc|bitcoin|eth|ethereum|sol|solana|xrp|ripple|bnb|doge|dogecoin|ada|cardano|crypto|blockchain|defi|nft|stablecoin|coinbase|binance|altcoin|memecoin|web3|layer.?2|base chain|avalanche|polygon|chainlink|uniswap|aave)\b/i,
  ai:            /\b(gpt|chatgpt|openai|claude|anthropic|gemini|google ai|mistral|llama|deepmind|ai model|large language|llm|artificial intelligence|machine learning|neural network|diffusion model|sora|midjourney|stable diffusion|ai.?agent|agi|superintelligence|copilot|cursor|coding ai)\b/i,
  sports:        /\b(nba|nfl|mlb|nhl|premier league|champions league|world cup|super bowl|ufc|mma|wimbledon|us open|masters|formula.?1|f1|nascar|olympics|fifa|championship|tournament|playoffs|finals|season|mvp|transfer|draft)\b/i,
  entertainment: /\b(oscar|grammy|emmy|golden globe|box office|movie|film|netflix|disney|marvel|dc comics|celebrity|kardashian|taylor swift|beyonce|album|billboard|streaming|spotify|youtube|twitch|gaming|esports|video game)\b/i,
  world:         /\b(election|president|congress|senate|prime minister|parliament|war|ceasefire|nato|ukraine|russia|china|taiwan|iran|israel|gaza|inflation|gdp|recession|federal reserve|fed rate|interest rate|oil price|gold price|crude|brent|commodity|trade war|tariff|sanctions)\b/i,
};

// Classify a question — returns first matching category or null
function classifyQuestion(question) {
  const q = question || '';
  for (const [cat, rx] of Object.entries(POLY_CAT_KEYWORDS)) {
    if (rx.test(q)) return cat;
  }
  return null;
}

// Kept for backwards-compat (no longer used for filtering, only for reference)
const POLY_CAT_MAP = {
  crypto: {}, ai: {}, world: {}, sports: {}, entertainment: {},
};

// Async version of callTx (non-blocking, uses exec not execSync)
function callTxAsync(account, pid, method, args, value) {
  const extra = value ? ['--value', String(value)] : [];
  return vwAsync(['--account', account, 'call', pid, method,
    '--args', JSON.stringify(args), '--idl', IDL_PATH, ...extra]);
}

// ── Portable HOME / vara-wallet dir ─────────────────────────────────────────
// On Windows (PowerShell / Railway) HOME may be unset; fall back to homedir()
const HOME_DIR       = process.env.HOME || process.env.USERPROFILE || os.homedir();
const VARA_WALLET_DIR = process.env.VARA_WALLET_DIR || path.join(HOME_DIR, '.vara-wallet');
const VW_WALLETS_DIR  = path.join(VARA_WALLET_DIR, 'wallets');

// ── vara-wallet helpers ───────────────────────────────────────────────────────
// All child processes get HOME + VARA_WALLET_DIR so vara-wallet can find its keystore
const CHILD_ENV = {
  ...process.env,
  HOME:             HOME_DIR,
  VARA_WALLET_DIR:  VARA_WALLET_DIR,
};

function buildCmd(args) {
  const argv = [NODE, VW_SCRIPT, '--network', NETWORK, '--json', ...args];
  return argv.map(a => /[\s"']/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a)).join(' ');
}

// Sync — wallet ops + transfers
function vwSync(args, opts = {}) {
  try {
    const out = execSync(buildCmd(args), { timeout: 90_000, stdio: ['pipe', 'pipe', 'pipe'], env: CHILD_ENV });
    return JSON.parse(out.toString().trim());
  } catch (err) {
    if (opts.ignoreError) {
      const raw = err.stdout?.toString().trim();
      try { return JSON.parse(raw); } catch {}
      return { error: err.stderr?.toString() || err.message };
    }
    throw err;
  }
}

// Async — market queries (non-blocking)
function vwAsync(args) {
  return new Promise(resolve => {
    exec(buildCmd(args), { timeout: 60_000, env: CHILD_ENV }, (err, stdout) => {
      try { resolve(JSON.parse(stdout.toString().trim())); }
      catch { resolve({ error: err?.message || stdout }); }
    });
  });
}

// Concurrency limiter
async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function vwAs(account, args, opts = {}) {
  return vwSync(['--account', account, ...args], opts);
}

function callQuery(pid, method, args) {
  return vwAsync(['call', pid, method, '--args', JSON.stringify(args), '--idl', IDL_PATH]);
}

function callTx(account, pid, method, args, value) {
  const extra = value ? ['--value', String(value)] : [];
  return vwSync(['--account', account, 'call', pid, method, '--args', JSON.stringify(args), '--idl', IDL_PATH, ...extra], { ignoreError: true });
}

// ── Funder wallet setup ───────────────────────────────────────────────────────
// Priority: FUNDER_WALLET_JSON > FUNDER_MNEMONIC > FUNDER_SEED > named wallet "hy4-agent"
const FUNDER_TMP_NAME = 'hy4_funder_tmp';
let funderReady = false;

function ensureWalletsDir() {
  if (!fs.existsSync(VW_WALLETS_DIR)) fs.mkdirSync(VW_WALLETS_DIR, { recursive: true });
}

function setupFunder() {
  ensureWalletsDir();

  // 1. FUNDER_WALLET_JSON: base64-encoded PKCS8 wallet file (best for Railway)
  if (FUNDER_JSON) {
    try {
      const walletPath = path.join(VW_WALLETS_DIR, `${FUNDER_WALLET}.json`);
      fs.writeFileSync(walletPath, Buffer.from(FUNDER_JSON, 'base64').toString('utf8'));
      funderReady = true;
      console.log('[funder] loaded from FUNDER_WALLET_JSON →', FUNDER_WALLET);
      return;
    } catch (e) {
      console.error('[funder] FUNDER_WALLET_JSON decode failed:', e.message);
    }
  }

  // 2. FUNDER_MNEMONIC: import 12-word phrase
  if (FUNDER_MN) {
    try {
      const mnEscaped = FUNDER_MN.replace(/"/g, '\\"');
      execSync(`${NODE} "${VW_SCRIPT}" wallet import --name ${FUNDER_TMP_NAME} --mnemonic "${mnEscaped}"`,
               { timeout: 30_000, stdio: 'pipe', env: CHILD_ENV });
      funderReady = true;
      console.log('[funder] imported from FUNDER_MNEMONIC as', FUNDER_TMP_NAME);
      return;
    } catch (e) {
      // already exists is fine
      funderReady = true;
      console.log('[funder] FUNDER_MNEMONIC import (ok):', e.message.slice(0, 80));
      return;
    }
  }

  // 3. FUNDER_SEED: import 0x… hex seed
  if (FUNDER_SEED) {
    try {
      execSync(`${NODE} "${VW_SCRIPT}" wallet import --name ${FUNDER_TMP_NAME} --seed ${FUNDER_SEED}`,
               { timeout: 30_000, stdio: 'pipe', env: CHILD_ENV });
      funderReady = true;
      console.log('[funder] imported from FUNDER_SEED as', FUNDER_TMP_NAME);
      return;
    } catch (e) {
      funderReady = true;
      console.log('[funder] FUNDER_SEED import (ok):', e.message.slice(0, 80));
      return;
    }
  }

  // 4. Named wallet already in keystore (local dev)
  funderReady = true;
  console.log('[funder] using named wallet:', FUNDER_WALLET);
}

function funderName() {
  if (FUNDER_JSON)  return FUNDER_WALLET;       // wrote file under original name
  if (FUNDER_MN || FUNDER_SEED) return FUNDER_TMP_NAME;
  return FUNDER_WALLET;
}

// ── File helpers ──────────────────────────────────────────────────────────────
function loadJson(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── Market cache ──────────────────────────────────────────────────────────────
const cache        = { standard: null, fast: null, ts: { standard: 0, fast: 0 } };
const CACHE_TTL    = 300_000;  // 5-minute TTL
const CACHE_STALE  = 600_000;  // serve stale up to 10 min while refreshing in background
const _fetching    = {};       // in-flight fetch promises (race-condition guard)

function planckToVara(p) {
  if (p == null || p === '0') return 0;
  return Number(BigInt(p.toString())) / 1e12;
}

function cleanQServer(q) {
  if (!q) return q;
  // Strip any leading bracket tags (v2-era, Hackathon day N, Day N, etc.) — may appear multiple times
  let out = q;
  let prev;
  do {
    prev = out;
    out = out
      .replace(/^\[v\d+-era\]\s*/i, '')
      .replace(/^\[Hackathon day \d+\]\s*/i, '')
      .replace(/^\[Day \d+\]\s*/i, '')
      .replace(/\(iter\s*\d+\)\s*/gi, '');
  } while (out !== prev);
  return out.trim();
}

// Fetch live price from CoinGecko; returns { priceUsd, priceMicroUsd }
async function fetchPrice(symbol) {
  const coinMap = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', VARA: 'vara-network', DOT: 'polkadot' };
  const coinId  = coinMap[symbol.toUpperCase()];
  if (!coinId) throw new Error(`Unsupported symbol: ${symbol}. Supported: ${Object.keys(coinMap).join(', ')}`);
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
    { signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error('Price fetch failed: HTTP ' + r.status);
  const d = await r.json();
  const priceUsd = d[coinId]?.usd;
  if (!priceUsd) throw new Error(`No price data for ${symbol}`);
  return { priceUsd, priceMicroUsd: Math.round(priceUsd * 1_000_000) };
}

function normaliseEnum(v) {
  if (!v) return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.kind) return v.kind;
  return String(v);
}

function enrichMarket(m) {
  const poolA = planckToVara(m.pool_a);
  const poolB = planckToVara(m.pool_b);
  const total = poolA + poolB;
  return {
    ...m,
    status:          normaliseEnum(m.status),
    winning_outcome: normaliseEnum(m.winning_outcome),
    vara_a: poolA,
    vara_b: poolB,
    pct_a: total > 0 ? Math.round(poolA / total * 100) : 50,
    pct_b: total > 0 ? Math.round(poolB / total * 100) : 50,
  };
}

async function fetchStandard() {
  // Build probe list from markets-meta.json (exact known IDs) + small lookahead
  // This avoids probing hundreds of empty IDs — only query what we know exists.
  const meta    = loadJson(MARKETS_META_FILE, {});
  const metaIds = Object.keys(meta).map(Number).filter(n => !isNaN(n) && n > 0);
  const maxId   = metaIds.length > 0 ? Math.max(...metaIds) : 1500;
  const lookahead = Array.from({ length: 12 }, (_, i) => maxId + 1 + i);
  // Keep a handful of legacy hand-crafted markets (pre-Polymarket era)
  const legacyIds = [0, 1075, 1076, 1077, 1078, 1079, 1080, 1081, 1082];
  const allIds = [...new Set([...legacyIds, ...metaIds, ...lookahead])];

  const results = await withConcurrency(allIds, 10, async id => {
    try {
      const r = await callQuery(PID_V1, 'PredictionMarket/Market', [id]);
      return (r && r.result) ? enrichMarket({ id, ...r.result }) : null;
    } catch { return null; }
  });
  return results.filter(Boolean);
}

async function fetchFast() {
  // Grab current block so we can detect the resolution window
  // (market is Open but betting has ended — block >= resolve_after_block)
  let currentBlock = 0;
  try {
    const br = await callQuery(PID_V2, 'FastMarket/CurrentBlock', []);
    if (br?.result) currentBlock = Number(br.result);
  } catch {}

  const ids = Array.from({ length: 25 }, (_, i) => i);
  const results = await withConcurrency(ids, 8, async id => {
    try {
      const r = await callQuery(PID_V2, 'FastMarket/FastMarket', [id]);
      if (!r?.result) return null;
      const m = enrichMarket({ id, ...r.result });
      // Mark markets that are past their betting window but not yet formally resolved
      if (m.status === 'Open' && currentBlock > 0 && m.resolve_after_block && currentBlock >= m.resolve_after_block) {
        return { ...m, status: 'Resolving' };
      }
      return m;
    } catch { return null; }
  });
  return results.filter(Boolean);
}

function _startFetch(type) {
  if (_fetching[type]) return _fetching[type];
  _fetching[type] = (type === 'standard' ? fetchStandard() : fetchFast())
    .then(markets => {
      cache[type] = markets;
      cache.ts[type] = Date.now();
      delete _fetching[type];
      return markets;
    })
    .catch(err => { delete _fetching[type]; throw err; });
  return _fetching[type];
}

async function getMarkets(type) {
  const age = Date.now() - (cache.ts[type] || 0);

  // Fresh cache — return immediately
  if (age < CACHE_TTL && cache[type]) return cache[type];

  // Stale-while-revalidate: data exists but is old → return it instantly, refresh in background
  if (cache[type] && age < CACHE_STALE) {
    _startFetch(type);          // fire-and-forget background refresh
    return cache[type];         // caller gets stale data in <1ms
  }

  // No cache at all (cold start) — must wait for the fetch
  return _startFetch(type);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// ── Static agent docs page ────────────────────────────────────────────────────
app.get('/agent-docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agent-docs.html'));
});

// ── Health (enriched for agents) ──────────────────────────────────────────────
app.get('/api/health', async (_, res) => {
  let openMarkets = null;
  try {
    const [std, fast] = await Promise.all([getMarkets('standard'), getMarkets('fast')]);
    openMarkets = [...std, ...fast].filter(m => m.status === 'Open').length;
  } catch {}
  res.json({
    status:           'live',
    timestamp:        new Date().toISOString(),
    markets_open:     openMarkets,
    faucet_available: funderReady,
    faucet_amount:    `${FAUCET_VARA} VARA`,
    program_v1:       PID_V1,
    program_v2:       PID_V2,
    rpc:              'wss://rpc.vara.network',
    docs:             '/agent-docs',
  });
});

// ── Debug (chain query diagnostic) ───────────────────────────────────────────
app.get('/api/debug/chain', async (req, res) => {
  const start = Date.now();
  try {
    const r = await callQuery(PID_V1, 'PredictionMarket/Market', [1481]);
    res.json({
      ok: true,
      ms: Date.now() - start,
      result: r,
      node: process.execPath,
      vw_script: VW_SCRIPT,
      idl_exists: fs.existsSync(IDL_PATH),
      idl_path: IDL_PATH,
      network: NETWORK,
    });
  } catch (e) {
    res.json({ ok: false, ms: Date.now() - start, error: e.message, node: process.execPath, vw_script: VW_SCRIPT });
  }
});

// ── Agent API ─────────────────────────────────────────────────────────────────

// GET /api/agent/categories — list available categories + market count
app.get('/api/agent/categories', async (req, res) => {
  try {
    const meta = loadJson(MARKETS_META_FILE, {});
    const counts = {};
    for (const entry of Object.values(meta)) {
      if (!entry.hidden) counts[entry.category] = (counts[entry.category] || 0) + 1;
    }
    const categories = Object.entries(counts).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    res.json({
      categories,
      available: Object.keys(POLY_CAT_MAP),
      hint: 'Use ?category=crypto|ai|world|sports|entertainment with /api/agent/markets',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/markets — top 10 open markets sorted by soonest closing
// Markets synced from Polymarket show first (have endDate); others follow sorted by id
app.get('/api/agent/markets', async (req, res) => {
  try {
    const [std, fast] = await Promise.all([getMarkets('standard'), getMarkets('fast')]);
    const meta = loadJson(MARKETS_META_FILE, {});
    const hasMeta = Object.keys(meta).length > 0;
    const now = Date.now();

    const markets = [...std.map(m => ({ ...m, _type: 'standard' })), ...fast.map(m => ({ ...m, _type: 'fast' }))]
      .filter(m => {
        const status = m.status?.kind ?? m.status;
        if (status !== 'Open') return false;
        if (meta[String(m.id)]?.hidden) return false;
        // When we have synced markets, only show those (keeps the list clean)
        if (hasMeta && !meta[String(m.id)]) return false;
        return true;
      })
      .map(m => {
        const entry     = meta[String(m.id)] || {};
        const poolA     = m.vara_a || 0;
        const poolB     = m.vara_b || 0;
        const totalPool = poolA + poolB;
        const endDate   = entry.endDate || null;
        const msLeft    = endDate ? new Date(endDate) - now : null;
        const daysLeft  = msLeft != null ? Math.max(0, Math.ceil(msLeft / 86_400_000)) : null;
        const hoursLeft = msLeft != null ? Math.max(0, Math.ceil(msLeft / 3_600_000)) : null;
        return {
          id:           m.id,
          question:     cleanQServer(m.question),
          outcomeA:     m.outcome_a || 'Yes',
          outcomeB:     m.outcome_b || 'No',
          totalPool:    totalPool.toFixed(2),
          percentA:     m.pct_a,
          percentB:     m.pct_b,
          status:       'open',
          type:         m._type,
          endDate,
          daysLeft,
          hoursLeft,
          closingLabel: daysLeft != null
            ? (daysLeft === 0 ? 'Today' : daysLeft === 1 ? 'Tomorrow' : `${daysLeft}d left`)
            : null,
          _sort_ts:     endDate ? new Date(endDate).getTime() : 9e15,
        };
      });

    markets.sort((a, b) => a._sort_ts - b._sort_ts || b.id - a.id);
    markets.forEach(m => delete m._sort_ts);

    res.json(markets.slice(0, 10));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IP-based rate-limit for register: max 3 registrations per IP per 10 minutes
const _regTs = {};
function regRateLimited(ip) {
  const now = Date.now();
  const window = 10 * 60 * 1000; // 10 min
  _regTs[ip] = (_regTs[ip] || []).filter(t => now - t < window);
  if (_regTs[ip].length >= 3) return true;
  _regTs[ip].push(now);
  return false;
}

// IP-based session: remember the most recently registered wallet per IP
// Lets agents call /api/agent/bet with just {marketId, outcome} after registering
const _ipSession = loadJson(IP_SESSION_FILE, {}); // { ip: { address, mnemonic } } — persisted across restarts
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

// POST /api/agent/register — generate keypair, fund 10 VARA, return credentials
// Mnemonic stored server-side so agents can bet with just {marketId, outcome} after registering
app.post('/api/agent/register', async (req, res) => {
  const ip = getClientIp(req);
  if (regRateLimited(ip)) {
    return res.status(429).json({
      error: 'Too many registrations. Use your existing mnemonic instead of registering again.',
      tip: 'POST /api/agent/bet with your saved mnemonic + marketId + outcome (YES/NO) + amount (optional)'
    });
  }

  const { agentId } = req.body || {};
  try {
    const mnemonic  = bip39.generateMnemonic();
    const tmpName   = 'agent_reg_' + Date.now();
    const mnEscaped = mnemonic.replace(/"/g, '\\"');

    const out     = execSync(`${NODE} "${VW_SCRIPT}" wallet import --name ${tmpName} --mnemonic "${mnEscaped}"`,
                             { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], env: CHILD_ENV });
    const walData = JSON.parse(out.toString().trim());
    const address = walData.address;
    if (!address) throw new Error('Could not derive address from mnemonic');

    const funded = loadJson(FUNDED_FILE, {});
    if (funded[address]) {
      try { execSync(`${NODE} "${VW_SCRIPT}" wallet delete --name ${tmpName}`, { timeout: 10_000, stdio: 'pipe', env: CHILD_ENV }); } catch {}
      // Return existing registration (idempotent)
      return res.json({
        address,
        mnemonic: funded[address].mnemonic || '(not stored — use your saved mnemonic)',
        balance: `${FAUCET_VARA} VARA`,
        txHash: funded[address].txHash,
        already_registered: true,
        instructions: {
          place_bet: 'POST /api/agent/bet',
          fast_bet:  'POST /api/agent/fast-bet',
          view_markets: 'GET /api/agent/markets',
          docs: '/agent-docs',
        },
      });
    }

    if (!funderReady) throw new Error('Faucet not ready');
    const txResult = vwAs(funderName(), ['transfer', address, String(FAUCET_VARA)], { ignoreError: true });
    if (txResult.error) throw new Error('Faucet failed: ' + txResult.error);

    // Store mnemonic — enables address-based bet lookups AND IP session bets
    funded[address] = {
      fundedAt: new Date().toISOString(),
      txHash:   txResult.txHash,
      agentId:  agentId || null,
      mnemonic,
    };
    saveJson(FUNDED_FILE, funded);

    // Remember this IP's session so they can bet with just {marketId, outcome} — persisted to disk
    _ipSession[ip] = { address, mnemonic };
    saveJson(IP_SESSION_FILE, _ipSession);
    console.log(`[register] IP ${ip} → ${address.slice(0,12)}…`);

    try { execSync(`${NODE} "${VW_SCRIPT}" wallet delete --name ${tmpName}`, { timeout: 10_000, stdio: 'pipe', env: CHILD_ENV }); } catch {}

    res.json({
      address,
      mnemonic,
      balance:  `${FAUCET_VARA} VARA`,
      txHash:   txResult.txHash,
      instructions: {
        place_bet:    'POST /api/agent/bet',
        fast_bet:     'POST /api/agent/fast-bet',
        view_markets: 'GET /api/agent/markets',
        docs:         '/agent-docs',
        tip: 'You can bet using either {mnemonic, ...} OR {address, ...} — no need to re-register',
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/bet — place bet on a standard (v1) prediction market
// Accepts:
//   mnemonic OR address  (address looks up stored mnemonic from register)
//   outcome: "A"/"B" OR "YES"/"NO"/"yes"/"no"
//   amount: optional, defaults to 0.5 VARA
app.post('/api/agent/bet', (req, res) => {
  let { mnemonic, address, marketId, outcome, amount } = req.body;
  const ip = getClientIp(req);

  // 1. Address-based lookup (funded.json)
  if (!mnemonic && address) {
    const rec = loadJson(FUNDED_FILE, {})[address];
    if (rec?.mnemonic) mnemonic = rec.mnemonic;
  }

  // 2. IP session fallback — works when bot sends only {marketId, outcome} after registering
  if (!mnemonic) {
    const session = _ipSession[ip];
    if (session?.mnemonic) {
      mnemonic = session.mnemonic;
      console.log(`[bet] IP session used for ${ip} → ${session.address?.slice(0,12)}…`);
    }
  }

  if (!mnemonic) {
    console.log('[bet] no credentials — body:', JSON.stringify(req.body).slice(0, 200));
    return res.status(400).json({
      error: 'No wallet found for this request. Call POST /api/agent/register first, then bet from the same connection.',
      example: { mnemonic: 'word1 word2 ... word12', marketId: 1462, outcome: 'YES', amount: '0.5' }
    });
  }
  if (marketId == null) return res.status(400).json({ error: 'marketId is required' });
  if (!outcome)         return res.status(400).json({ error: 'outcome is required: "YES", "NO", "A", or "B"' });

  // Normalise outcome — accept YES/NO/yes/no
  const outcomeNorm = String(outcome).toUpperCase();
  let outcomeLetter;
  if      (outcomeNorm === 'A'   || outcomeNorm === 'YES') outcomeLetter = 'A';
  else if (outcomeNorm === 'B'   || outcomeNorm === 'NO')  outcomeLetter = 'B';
  else return res.status(400).json({ error: 'outcome must be "YES"/"A" or "NO"/"B"' });

  // Default amount
  const amountVara = amount ? String(amount) : '0.5';

  try {
    const tmpName   = 'agent_bet_' + Date.now();
    const mnEscaped = mnemonic.replace(/"/g, '\\"');
    execSync(`${NODE} "${VW_SCRIPT}" wallet import --name ${tmpName} --mnemonic "${mnEscaped}"`,
             { timeout: 30_000, stdio: 'pipe', env: CHILD_ENV });

    const outcomeArg = outcomeLetter === 'A' ? { A: null } : { B: null };
    const result = vwAs(tmpName, [
      'call', PID_V1, 'PredictionMarket/PlaceBet',
      '--args', JSON.stringify([Number(marketId), outcomeArg]),
      '--idl', IDL_PATH,
      '--value', amountVara,
    ], { ignoreError: true });

    try { execSync(`${NODE} "${VW_SCRIPT}" wallet delete --name ${tmpName}`, { timeout: 10_000, stdio: 'pipe', env: CHILD_ENV }); } catch {}

    if (result.error) return res.status(400).json({ error: result.error });

    // Track bet for leaderboard P&L
    const resolvedAddr = address || _ipSession[ip]?.address || null;
    if (resolvedAddr) {
      try {
        // Grab question/labels from cache at bet time for permanent storage
        const cachedAll = [...(cache.standard || []), ...(cache.fast || [])];
        const betMarket = cachedAll.find(m => m.id === Number(marketId));
        const betsDb = loadJson(BETS_FILE, {});
        if (!betsDb[resolvedAddr]) betsDb[resolvedAddr] = { bets: [] };
        betsDb[resolvedAddr].bets.push({
          marketId:  Number(marketId),
          outcome:   outcomeLetter,
          amount:    parseFloat(amountVara),
          type:      'standard',
          question:  betMarket ? cleanQServer(betMarket.question) : null,
          outcome_a: betMarket?.outcome_a || null,
          outcome_b: betMarket?.outcome_b || null,
          placedAt:  new Date().toISOString(),
          txHash:    result.txHash,
        });
        saveJson(BETS_FILE, betsDb);
      } catch (e2) { console.warn('[bet-track] failed:', e2.message); }
    }

    res.json({ success: true, txHash: result.txHash, marketId: Number(marketId), outcome: outcomeLetter });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/fast-bet — fetch live price, create fast market, place bet (one call)
app.post('/api/agent/fast-bet', async (req, res) => {
  const { mnemonic, symbol = 'BTC', direction } = req.body;
  if (!mnemonic || !direction) {
    return res.status(400).json({ error: 'Required: mnemonic, symbol (BTC/ETH/SOL), direction ("higher"/"lower")' });
  }
  const dir = direction.toLowerCase();
  if (!['higher', 'lower'].includes(dir)) {
    return res.status(400).json({ error: 'direction must be "higher" or "lower"' });
  }
  try {
    // 1. Live price
    const { priceUsd, priceMicroUsd } = await fetchPrice(symbol);
    const sym = symbol.toUpperCase();

    // 2. Create fast market (funder wallet pays gas; no VARA value required)
    const question = `Will ${sym} be higher in 50 blocks? (opens at $${priceUsd.toLocaleString()})`;
    const createResult = callTx(funderName(), PID_V2, 'FastMarket/CreateFastMarket',
      [question, sym, priceMicroUsd, 50], null);
    if (createResult.error) throw new Error('Market creation failed: ' + createResult.error);

    const marketId = createResult.result ?? createResult.events?.find(e => e.type === 'FastMarketCreated')?.data?.market_id;
    if (marketId == null) throw new Error('Could not determine new market ID from response');

    // 3. Place bet with caller's wallet
    const tmpName   = 'agent_fb_' + Date.now();
    const mnEscaped = mnemonic.replace(/"/g, '\\"');
    execSync(`${NODE} "${VW_SCRIPT}" wallet import --name ${tmpName} --mnemonic "${mnEscaped}"`,
             { timeout: 30_000, stdio: 'pipe', env: CHILD_ENV });

    const outcomeArg = dir === 'higher' ? { A: null } : { B: null };
    const betResult  = vwAs(tmpName, [
      'call', PID_V2, 'FastMarket/PlaceFastBet',
      '--args', JSON.stringify([Number(marketId), outcomeArg]),
      '--idl', IDL_PATH,
      '--value', '0.5',
    ], { ignoreError: true });

    try { execSync(`${NODE} "${VW_SCRIPT}" wallet delete --name ${tmpName}`, { timeout: 10_000, stdio: 'pipe', env: CHILD_ENV }); } catch {}

    if (betResult.error) return res.status(400).json({ error: betResult.error });
    res.json({
      success:          true,
      txHash:           betResult.txHash,
      marketId:         Number(marketId),
      symbol:           sym,
      direction:        dir,
      openPrice:        priceUsd,
      openPriceMicroUsd: priceMicroUsd,
      outcome:          dir === 'higher' ? 'A' : 'B',
      resolvesAfterBlocks: 50,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/quick-start — one call: fund wallet + return today's hot markets
// Designed for zero-friction onboarding: agent calls this once, gets everything needed to bet
app.post('/api/agent/quick-start', async (req, res) => {
  const ip = getClientIp(req);

  // Re-use existing IP session if agent already registered — don't double-fund
  const existing = _ipSession[ip];
  let address, mnemonic, isNew = false;

  if (existing?.address && existing?.mnemonic) {
    address  = existing.address;
    mnemonic = existing.mnemonic;
  } else {
    // Register fresh wallet
    if (!funderReady) return res.status(503).json({ error: 'Funder wallet not ready' });
    if (regRateLimited(ip)) return res.status(429).json({ error: 'Already registered. Use your saved mnemonic.' });
    try {
      mnemonic       = bip39.generateMnemonic();
      const tmpName  = 'qs_' + Date.now();
      const mnEsc    = mnemonic.replace(/"/g, '\\"');
      execSync(`${NODE} "${VW_SCRIPT}" wallet import --name ${tmpName} --mnemonic "${mnEsc}"`,
        { timeout: 30_000, stdio: 'pipe', env: CHILD_ENV });
      const walletInfo = vwSync(['wallet', 'address', '--name', tmpName], { ignoreError: true });
      address = walletInfo?.address || walletInfo?.addressSS58 || null;

      // Fund it
      const txResult = vwAs(funderName(), [
        'transfer', '--to', address, '--amount', String(FAUCET_VARA),
      ], { ignoreError: true });
      try { execSync(`${NODE} "${VW_SCRIPT}" wallet delete --name ${tmpName}`, { timeout: 10_000, stdio: 'pipe', env: CHILD_ENV }); } catch {}

      if (txResult.error) throw new Error('Funding failed: ' + txResult.error);

      const funded = loadJson(FUNDED_FILE, {});
      funded[address] = { fundedAt: new Date().toISOString(), txHash: txResult.txHash, agentId: req.body?.agentId || null, mnemonic };
      saveJson(FUNDED_FILE, funded);
      _ipSession[ip] = { address, mnemonic };
      saveJson(IP_SESSION_FILE, _ipSession);
      isNew = true;
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Get hot markets — soonest closing, max 5
  let hotMarkets = [];
  try {
    const [std] = await Promise.all([getMarkets('standard')]);
    const meta  = loadJson(MARKETS_META_FILE, {});
    hotMarkets  = std
      .filter(m => {
        const status = m.status?.kind ?? m.status;
        return status === 'Open' && meta[String(m.id)] && !meta[String(m.id)].hidden;
      })
      .map(m => {
        const entry   = meta[String(m.id)] || {};
        const poolA   = m.vara_a || 0;
        const poolB   = m.vara_b || 0;
        return {
          id:           m.id,
          question:     cleanQServer(m.question),
          outcomeA:     m.outcome_a || 'Yes',
          outcomeB:     m.outcome_b || 'No',
          totalPool:    (poolA + poolB).toFixed(2),
          percentA:     m.pct_a,
          percentB:     m.pct_b,
          endDate:      entry.endDate || null,
          closingLabel: entry.endDate ? 'Resolving soon' : null,
          _sort:        entry.endDate ? new Date(entry.endDate).getTime() : 9e15,
        };
      })
      .sort((a, b) => a._sort - b._sort)
      .slice(0, 5)
      .map(({ _sort, ...m }) => m);
  } catch {}

  res.json({
    address,
    mnemonic,
    funded:     isNew ? FAUCET_VARA : 0,
    isNew,
    message:    isNew
      ? `Funded ${FAUCET_VARA} VARA to your wallet. Pick a market below and bet now.`
      : `Welcome back. Your wallet is ready.`,
    hotMarkets,
    betNow: {
      method:   'POST',
      url:      '/api/agent/bet',
      body:     { address, marketId: hotMarkets[0]?.id, outcome: 'YES', amount: '1' },
    },
  });
});

// GET /api/agent/info — plain-text docs for LLM agents that read API responses
app.get('/api/agent/info', (_, res) => {
  res.type('text/plain').send(`# Vara Predict Agent API

Vara Predict is an on-chain prediction market on Vara Network.
Any autonomous agent can participate in 3 API calls:

STEP 1 - Get a free funded wallet:
  POST /api/agent/register
  Body: { "agentId": "my-agent-v1" }  (agentId is optional)
  → Returns your address, mnemonic, and ${FAUCET_VARA} VARA balance

STEP 2 - Pick a category and view open markets:
  GET /api/agent/categories
  → Returns available categories: crypto, ai, world, sports, entertainment

  GET /api/agent/markets?category=crypto
  → Returns open markets for that category, sorted by soonest closing first
  → Each market includes: id, category, question, outcomeA, outcomeB, totalPool, percentA, percentB, daysLeft, closingLabel

STEP 3 - Place a bet:
  POST /api/agent/bet
  Body: { "mnemonic": "12 words", "marketId": 1462, "outcome": "A", "amount": "0.5" }
  → Returns txHash confirming your bet on Vara blockchain

BONUS - One-shot fast bet (price fetched automatically):
  POST /api/agent/fast-bet
  Body: { "mnemonic": "12 words", "symbol": "BTC", "direction": "higher" }
  → Creates a 5-min price market and bets on it in one call

That's it. No Web3 setup. No chain knowledge needed.
Pure REST API calls.

Program IDs:
  Standard markets (v1): ${PID_V1}
  Fast markets (v2):     ${PID_V2}

Network: Vara Mainnet — wss://rpc.vara.network
Explorer: https://vara.subscan.io
Full docs: /agent-docs
`);
});

// Generate fresh keypair
app.post('/api/new-wallet', (req, res) => {
  try {
    const mnemonic = bip39.generateMnemonic();
    // Import into vara-wallet to get the SS58 address, then we have it
    const tmpName = 'hy4web_' + Date.now();
    const argv = [NODE, VW_SCRIPT, 'wallet', 'import', '--name', tmpName, '--mnemonic', mnemonic].map(String);
    const cmd = argv.map(a => /[\s]/.test(a) ? `"${a}"` : a).join(' ');
    const out = execSync(cmd, { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], env: CHILD_ENV });
    const data = JSON.parse(out.toString().trim());
    res.json({ mnemonic, address: data.address || data.address });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Faucet
app.post('/api/faucet', (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });

  const funded = loadJson(FUNDED_FILE, {});
  if (funded[address]) return res.status(400).json({
    error: 'Address already funded',
    fundedAt: funded[address].fundedAt
  });

  if (!funderReady) return res.status(503).json({ error: 'Faucet not ready' });

  try {
    const result = vwAs(funderName(), ['transfer', address, String(FAUCET_VARA)], { ignoreError: true });
    if (result.error) throw new Error(result.error);
    funded[address] = { fundedAt: new Date().toISOString(), txHash: result.txHash, amount: FAUCET_VARA };
    saveJson(FUNDED_FILE, funded);
    res.json({ success: true, amount: FAUCET_VARA, address, txHash: result.txHash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Markets
app.get('/api/markets', async (req, res) => {
  const type = req.query.type === 'fast' ? 'fast' : 'standard';
  try {
    const markets = await getMarkets(type);
    const meta    = loadJson(MARKETS_META_FILE, {});
    // Enrich with category + closing info from meta
    const now = Date.now();
    const enriched = markets.map(m => {
      const entry   = meta[String(m.id)];
      if (!entry) return m;
      const msLeft  = entry.endDate ? new Date(entry.endDate) - now : null;
      return {
        ...m,
        category:     entry.category || null,
        endDate:      entry.endDate  || null,
        daysLeft:     msLeft != null ? Math.max(0, Math.ceil(msLeft / 86_400_000)) : null,
        closingLabel: msLeft != null ? (Math.ceil(msLeft/86_400_000) <= 0 ? 'Today' : Math.ceil(msLeft/86_400_000) === 1 ? 'Tomorrow' : `${Math.ceil(msLeft/86_400_000)}d left`) : null,
      };
    });
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const [std, fast] = await Promise.all([getMarkets('standard'), getMarkets('fast')]);
    const all = [...std, ...fast];
    const totalVara = all.reduce((s, m) => s + (m.vara_a || 0) + (m.vara_b || 0), 0);
    res.json({
      totalMarkets: all.length,
      openMarkets: all.filter(m => m.status === 'Open').length,
      totalVara: totalVara.toFixed(2),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Place bet (user provides mnemonic — imported as temp wallet, then deleted after)
app.post('/api/bet', (req, res) => {
  const { mnemonic, marketId, outcome, amount, type } = req.body;
  if (!mnemonic || marketId == null || !outcome || !amount) {
    return res.status(400).json({ error: 'mnemonic, marketId, outcome, amount required' });
  }

  try {
    const tmpName = 'hy4bet_' + Date.now();
    // Import wallet — mnemonic must be quoted so its words aren't treated as separate args
    const mnEscaped = mnemonic.replace(/"/g, '\\"');
    const impCmd = `${NODE} "${VW_SCRIPT}" wallet import --name ${tmpName} --mnemonic "${mnEscaped}"`;
    execSync(impCmd, { timeout: 30_000, stdio: 'pipe', env: CHILD_ENV });

    const isFast   = type === 'fast';
    const pid      = isFast ? PID_V2 : PID_V1;
    const service  = isFast ? 'FastMarket' : 'PredictionMarket';
    const method   = isFast ? 'PlaceFastBet' : 'PlaceBet';
    const outcomeArg = outcome === 'A' ? { A: null } : { B: null };

    const result = vwAs(tmpName, [
      'call', pid, `${service}/${method}`,
      '--args', JSON.stringify([Number(marketId), outcomeArg]),
      '--idl', IDL_PATH,
      '--value', String(amount),
    ], { ignoreError: true });

    // Clean up temp wallet (best-effort)
    try { execSync(`${NODE} "${VW_SCRIPT}" wallet delete --name ${tmpName}`, { timeout: 10_000, stdio: 'pipe', env: CHILD_ENV }); } catch {}

    if (result.error) return res.status(400).json({ error: result.error });

    // Track bet so it shows up in agent profile / leaderboard
    try {
      const userAddr = _ipSession[getClientIp(req)]?.address || null;
      if (userAddr) {
        const cachedAll = [...(cache.standard || []), ...(cache.fast || [])];
        const betMarket = cachedAll.find(m => m.id === Number(marketId));
        const outLetter = outcome === 'A' ? 'A' : 'B';
        const betsDb = loadJson(BETS_FILE, {});
        if (!betsDb[userAddr]) betsDb[userAddr] = { bets: [] };
        betsDb[userAddr].bets.push({
          marketId:  Number(marketId),
          outcome:   outLetter,
          amount:    parseFloat(amount),
          type:      isFast ? 'fast' : 'standard',
          question:  betMarket ? cleanQServer(betMarket.question) : null,
          outcome_a: betMarket?.outcome_a || null,
          outcome_b: betMarket?.outcome_b || null,
          placedAt:  new Date().toISOString(),
          txHash:    result.txHash,
        });
        saveJson(BETS_FILE, betsDb);
      }
    } catch {}

    res.json({ success: true, txHash: result.txHash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Claim winnings
app.post('/api/claim', (req, res) => {
  const { mnemonic, marketId, type } = req.body;
  if (!mnemonic || marketId == null) return res.status(400).json({ error: 'mnemonic and marketId required' });

  try {
    const tmpName  = 'hy4clm_' + Date.now();
    // Import wallet — mnemonic must be quoted so its words aren't treated as separate args
    const mnEscaped = mnemonic.replace(/"/g, '\\"');
    const impCmd   = `${NODE} "${VW_SCRIPT}" wallet import --name ${tmpName} --mnemonic "${mnEscaped}"`;
    execSync(impCmd, { timeout: 30_000, stdio: 'pipe', env: CHILD_ENV });

    const isFast  = type === 'fast';
    const pid     = isFast ? PID_V2 : PID_V1;
    const service = isFast ? 'FastMarket' : 'PredictionMarket';
    const method  = isFast ? 'ClaimFastWinnings' : 'ClaimWinnings';

    const result = vwAs(tmpName, [
      'call', pid, `${service}/${method}`,
      '--args', JSON.stringify([Number(marketId)]),
      '--idl', IDL_PATH,
    ], { ignoreError: true });

    try { execSync(`${NODE} "${VW_SCRIPT}" wallet delete --name ${tmpName}`, { timeout: 10_000, stdio: 'pipe', env: CHILD_ENV }); } catch {}

    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, txHash: result.txHash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bets for address
app.get('/api/bets/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const [std, fast] = await Promise.all([getMarkets('standard'), getMarkets('fast')]);
    const bets = [];

    // Scan only the 15 most recent standard + 8 most recent fast markets.
    // Each query spawns a child process (3-5s); 23 tasks at concurrency 8 ≈ 15-20s total.
    const byIdDesc = (a, b) => Number(b.id) - Number(a.id);
    const stdFiltered  = std.filter(m => m.status === 'Open').sort(byIdDesc).slice(0, 15);
    const fastFiltered = fast.filter(m => m.status === 'Open').sort(byIdDesc).slice(0, 8);

    const tasks = [
      ...stdFiltered.map(m => ({ m, pid: PID_V1, method: 'PredictionMarket/Bet', type: 'standard' })),
      ...fastFiltered.map(m => ({ m, pid: PID_V2, method: 'FastMarket/FastBet', type: 'fast' })),
    ];

    await withConcurrency(tasks, 8, async ({ m, pid, method, type }) => {
      const r = await callQuery(pid, method, [m.id, address]);
      if (r?.result) bets.push({
        marketId: m.id, question: m.question,
        outcome: r.result[0], amount: planckToVara(r.result[1]),
        status: m.status, winning_outcome: m.winning_outcome, type
      });
    });

    res.json(bets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/my-bets — agent queries its own bets (no address needed, uses IP session / address param)
// Accepts ?address=kG... OR reads from IP session after registration
app.get('/api/agent/my-bets', async (req, res) => {
  const ip = getClientIp(req);
  const address = req.query.address || _ipSession[ip]?.address
    || (() => {
      // also accept address in funded.json matched by ip session mnemonic
      const session = _ipSession[ip];
      if (!session) return null;
      const funded = loadJson(FUNDED_FILE, {});
      return Object.keys(funded).find(a => funded[a].mnemonic === session.mnemonic) || null;
    })();

  if (!address) {
    return res.status(400).json({
      error: 'Cannot identify agent. Pass ?address=kG... or register first from this IP.',
    });
  }

  try {
    // Fast path: return tracked bets from bets.json (instant, no chain queries)
    const betsDb = loadJson(BETS_FILE, {});
    const tracked = betsDb[address]?.bets || [];

    // Enrich with current market state from cache
    const [std, fast] = await Promise.all([getMarkets('standard'), getMarkets('fast')]);
    const marketMap = {};
    [...std, ...fast].forEach(m => { marketMap[String(m.id)] = m; });

    // On-demand fetch for any markets not in cache (resolved/old markets)
    const missingIds = [...new Set(
      tracked.map(b => b.marketId).filter(id => id != null && !marketMap[String(id)])
    )];
    if (missingIds.length > 0) {
      await withConcurrency(missingIds, 5, async id => {
        try {
          const r = await callQuery(PID_V1, 'PredictionMarket/Market', [id]);
          if (r?.result) marketMap[String(id)] = enrichMarket({ id, ...r.result });
        } catch {}
      });
    }

    const enriched = tracked.map(bet => {
      const market = marketMap[String(bet.marketId)];
      // Fall back to question/labels stored in the bet record itself
      if (!market) return {
        ...bet,
        marketStatus: 'Resolved',
        question:     bet.question   || null,
        outcomeLabel: bet.outcome === 'A' ? (bet.outcome_a || 'Yes') : (bet.outcome_b || 'No'),
        result:       null,
        potentialPayout: null,
      };

      const status   = market.status?.kind ?? market.status;
      const winOut   = market.winning_outcome?.kind ?? market.winning_outcome;
      const poolSide = bet.outcome === 'A' ? (market.vara_a || 0) : (market.vara_b || 0);
      const total    = (market.vara_a || 0) + (market.vara_b || 0);
      const potentialPayout = (status === 'Open' || status === 'Resolving') && poolSide > 0
        ? +((bet.amount / poolSide) * total).toFixed(3) : null;
      const result = status === 'Resolved'
        ? (winOut === bet.outcome ? 'won' : 'lost') : null;

      return {
        marketId:       bet.marketId,
        question:       cleanQServer(market.question),
        outcome:        bet.outcome,
        outcomeLabel:   bet.outcome === 'A' ? (market.outcome_a || 'Yes') : (market.outcome_b || 'No'),
        amount:         bet.amount,
        marketStatus:   status,
        winningOutcome: winOut || null,
        result,                           // "won" | "lost" | null (open)
        potentialPayout,                  // if open: VARA you'd receive if you win
        placedAt:       bet.placedAt,
        txHash:         bet.txHash,
        type:           bet.type,
      };
    });

    const open     = enriched.filter(b => b.marketStatus === 'Open' || b.marketStatus === 'Resolving');
    const resolved = enriched.filter(b => b.marketStatus === 'Resolved');
    const won      = resolved.filter(b => b.result === 'won');
    const lost     = resolved.filter(b => b.result === 'lost');

    res.json({
      address,
      summary: {
        totalBets:  enriched.length,
        openBets:   open.length,
        wins:       won.length,
        losses:     lost.length,
        stakedVara: +enriched.reduce((s, b) => s + b.amount, 0).toFixed(3),
        atRisk:     +open.reduce((s, b) => s + b.amount, 0).toFixed(3),
      },
      bets: enriched,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
// GET /api/leaderboard — P&L for all agents who have placed bets via the API
app.get('/api/leaderboard', async (req, res) => {
  try {
    const betsDb  = loadJson(BETS_FILE, {});
    const funded  = loadJson(FUNDED_FILE, {});
    const [std, fast] = await Promise.all([getMarkets('standard'), getMarkets('fast')]);

    const marketMap = {};
    [...std, ...fast].forEach(m => { marketMap[String(m.id)] = m; });

    const agents = [];
    for (const [addr, data] of Object.entries(betsDb)) {
      const fundedRec  = funded[addr] || {};
      let staked = 0, atRisk = 0, realisedPnl = 0, unrealisedValue = 0;
      let wins = 0, losses = 0, openCount = 0;
      const betList = data.bets || [];

      for (const bet of betList) {
        staked += bet.amount;
        const market = marketMap[String(bet.marketId)];
        if (!market) continue;

        const status   = market.status?.kind ?? market.status;
        const poolA    = market.vara_a || 0;
        const poolB    = market.vara_b || 0;
        const total    = poolA + poolB;
        const poolSide = bet.outcome === 'A' ? poolA : poolB;

        if (status === 'Open' || status === 'Resolving') {
          atRisk += bet.amount;
          openCount++;
          // Potential payout if their side wins
          if (poolSide > 0) unrealisedValue += (bet.amount / poolSide) * total;
        } else if (status === 'Resolved') {
          const winOut = market.winning_outcome?.kind ?? market.winning_outcome;
          if (winOut && winOut === bet.outcome) {
            wins++;
            const payout = poolSide > 0 ? (bet.amount / poolSide) * total : bet.amount;
            realisedPnl += payout - bet.amount;
          } else if (winOut) {
            losses++;
            realisedPnl -= bet.amount;
          }
        }
      }

      const unrealisedProfit = unrealisedValue - atRisk; // potential upside on open bets
      agents.push({
        address:         addr,
        agentId:         fundedRec.agentId || null,
        fundedAt:        fundedRec.fundedAt || null,
        betCount:        betList.length,
        openCount,
        wins,
        losses,
        staked:          +staked.toFixed(3),
        atRisk:          +atRisk.toFixed(3),
        unrealisedValue: +unrealisedValue.toFixed(3),
        unrealisedProfit:+unrealisedProfit.toFixed(3),
        realisedPnl:     +realisedPnl.toFixed(3),
        // totalPnl = realised gains/losses + potential upside
        totalPnl:        +(realisedPnl + unrealisedProfit).toFixed(3),
      });
    }

    agents.sort((a, b) => b.staked - a.staked || b.betCount - a.betCount);
    const totalStaked   = agents.reduce((s, a) => s + a.staked, 0);
    const totalAtRisk   = agents.reduce((s, a) => s + a.atRisk, 0);
    res.json({ agents, summary: { totalAgents: agents.length, totalStaked: +totalStaked.toFixed(3), totalAtRisk: +totalAtRisk.toFixed(3) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Polymarket feed ───────────────────────────────────────────────────────────
// GET /api/polymarkets — fetch active real-world markets from Polymarket
// Classifies category by keyword since Polymarket's category field is unreliable
app.get('/api/polymarkets', async (req, res) => {
  try {
    const filterCat = (req.query.category || '').toLowerCase();
    // Fetch more than needed so we can filter by our keyword classifier
    const limit     = Math.min(Number(req.query.limit) || 20, 50);
    const fetchN    = filterCat ? limit * 5 : limit * 2; // fetch extra when filtering by category
    const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${Math.min(fetchN,200)}&order=endDate&ascending=true`;

    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`Polymarket API ${r.status}`);
    const raw  = await r.json();
    const list = Array.isArray(raw) ? raw : (raw.markets || []);

    let markets = list.map(m => {
      let prices = [];
      try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch {}
      // Classify using our keyword matcher — ignore m.category (always empty)
      const detectedCat = classifyQuestion(m.question) || 'general';
      return {
        id:          m.conditionId || m.id,
        question:    m.question,
        endDate:     m.endDate,
        category:    detectedCat,
        volume:      +(parseFloat(m.volume    || 0)).toFixed(0),
        liquidity:   +(parseFloat(m.liquidity || 0)).toFixed(0),
        yesPrice:    prices[0] ?? null,
        noPrice:     prices[1] ?? null,
        resolved:    !!(m.closed || m.resolved),
        resolution:  m.resolution || null,
        url:         m.slug ? `https://polymarket.com/event/${m.slug}` : null,
      };
    });

    // Apply category filter if requested
    if (filterCat) markets = markets.filter(m => m.category === filterCat);
    markets = markets.slice(0, limit);

    res.json(markets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/sync-polymarket — fetch top N soonest-closing markets from Polymarket, create on our chain
// Body: { limit: 10, adminKey }
app.post('/api/admin/sync-polymarket', async (req, res) => {
  const { limit = 10, adminKey } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  if (!funderReady) return res.status(503).json({ error: 'Funder wallet not ready' });

  res.json({ status: 'started', message: `Syncing top ${limit} soonest-closing markets. Watch server logs.` });

  (async () => {
    const meta = loadJson(MARKETS_META_FILE, {});
    const sync = loadJson(POLY_SYNC_FILE, {});
    let created = 0, skipped = 0, errors = 0;

    try {
      // Fetch soonest-closing active markets — no category filter needed
      const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${limit * 4}&order=endDate&ascending=true`;
      console.log(`[sync] fetching from Polymarket…`);
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`Polymarket API ${r.status}`);
      const raw  = await r.json();
      const list = (Array.isArray(raw) ? raw : (raw.markets || []))
        .filter(m => m.question && m.endDate)  // must have a question and close date
        .slice(0, limit);

      console.log(`[sync] got ${list.length} markets to process`);

      for (const pm of list) {
        const question = pm.question.trim();
        const polyId   = pm.conditionId || pm.id;

        if (Object.values(sync).some(e => e.polymarketId === polyId)) {
          console.log(`[sync] skip (already exists): ${question.slice(0, 50)}`);
          skipped++;
          continue;
        }

        try {
          console.log(`[sync] creating "${question.slice(0, 70)}"`);
          const result = callTx(funderName(), PID_V1, 'PredictionMarket/CreateMarket',
            [question, 'Yes', 'No'], null);
          if (result.error) { console.warn(`[sync] failed: ${result.error}`); errors++; continue; }

          const marketId = result.result
            ?? result.events?.find(e => e.type === 'MarketCreated')?.data?.market_id;
          if (marketId == null) { errors++; continue; }

          meta[String(marketId)] = {
            category:     classifyQuestion(question) || 'general',
            endDate:      pm.endDate,
            polymarketId: polyId,
            source:       'polymarket',
            hidden:       false,
          };
          sync[String(marketId)] = {
            polymarketId: polyId, question,
            outcomeALabel: 'Yes', outcomeBLabel: 'No',
            createdAt: new Date().toISOString(), resolved: false,
          };
          saveJson(MARKETS_META_FILE, meta);
          saveJson(POLY_SYNC_FILE, sync);
          cache.ts.standard = 0; cache.ts.fast = 0;
          created++;
          console.log(`[sync] ✓ #${marketId} closes ${pm.endDate?.slice(0,10)} — ${question.slice(0, 55)}`);
        } catch (e2) {
          console.warn(`[sync] create error: ${e2.message}`);
          errors++;
        }
      }
    } catch (e) {
      console.warn(`[sync] fetch error: ${e.message}`);
    }

    console.log(`[sync] done — created:${created} skipped:${skipped} errors:${errors}`);
  })();
});

// POST /api/admin/tag-market — manually tag an existing market with category + endDate
// Body: { marketId, category, endDate, polymarketId, hidden, adminKey }
app.post('/api/admin/tag-market', (req, res) => {
  const { marketId, category, endDate, polymarketId, hidden = false, adminKey } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  if (!marketId) return res.status(400).json({ error: 'marketId required' });
  const meta = loadJson(MARKETS_META_FILE, {});
  meta[String(marketId)] = { category: category || 'general', endDate: endDate || null,
    polymarketId: polymarketId || null, hidden: !!hidden, source: 'manual' };
  saveJson(MARKETS_META_FILE, meta);
  cache.ts.standard = 0; cache.ts.fast = 0;
  res.json({ success: true, marketId, category, endDate });
});

// POST /api/admin/create-from-polymarket — mirror a Polymarket market on our chain
// Body: { polymarketId, question, outcomeA, outcomeB, adminKey }
app.post('/api/admin/create-from-polymarket', async (req, res) => {
  const { polymarketId, question, outcomeA = 'Yes', outcomeB = 'No', adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  if (!polymarketId || !question) return res.status(400).json({ error: 'polymarketId and question required' });
  if (!funderReady) return res.status(503).json({ error: 'Funder wallet not ready' });

  try {
    const result = callTx(funderName(), PID_V1, 'PredictionMarket/CreateMarket',
      [question, outcomeA, outcomeB], null);
    if (result.error) throw new Error(result.error);

    const marketId = result.result
      ?? result.events?.find(e => e.type === 'MarketCreated')?.data?.market_id;
    if (marketId == null) throw new Error('Could not determine new market ID');

    const sync = loadJson(POLY_SYNC_FILE, {});
    sync[String(marketId)] = {
      polymarketId, question,
      outcomeALabel: outcomeA, outcomeBLabel: outcomeB,
      createdAt: new Date().toISOString(), resolved: false,
    };
    saveJson(POLY_SYNC_FILE, sync);
    cache.ts.standard = 0; cache.ts.fast = 0; // bust market cache

    res.json({ success: true, marketId, polymarketId, question });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/manual-resolve — force-resolve a market with a known outcome
// Body: { marketId, outcome: "A"|"B", adminKey }
app.post('/api/admin/manual-resolve', async (req, res) => {
  const { marketId, outcome, adminKey } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  if (!funderReady) return res.status(503).json({ error: 'Funder wallet not ready' });
  if (!marketId || !['A','B'].includes(outcome)) return res.status(400).json({ error: 'marketId + outcome (A|B) required' });
  try {
    const outcomeArg = outcome === 'A' ? { A: null } : { B: null };
    const tx = callTx(funderName(), PID_V1, 'PredictionMarket/ResolveMarket',
      [Number(marketId), outcomeArg], null);
    const result = await tx;
    if (result.error) return res.status(500).json({ error: result.error });
    // Mark resolved in polymarket-sync.json
    const pms = loadJson(POLY_SYNC_FILE, {});
    if (pms[marketId]) { pms[marketId].resolved = true; pms[marketId].winningOutcome = outcome; saveJson(POLY_SYNC_FILE, pms); }
    cache.ts.standard = 0; cache.ts.fast = 0;
    console.log(`[manual-resolve] Market #${marketId} → ${outcome} tx=${result.txHash}`);
    res.json({ success: true, marketId, outcome, txHash: result.txHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/auto-resolve — check Polymarket for resolved markets, resolve ours
app.post('/api/admin/auto-resolve', async (req, res) => {
  const { adminKey } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  if (!funderReady) return res.status(503).json({ error: 'Funder wallet not ready' });

  try {
    const sync    = loadJson(POLY_SYNC_FILE, {});
    const results = [];

    for (const [ourId, entry] of Object.entries(sync)) {
      if (entry.resolved) continue;
      try {
        // Use conditionIds query param — direct path lookup rejects 0x conditionId format
        const r   = await fetch(
          `https://gamma-api.polymarket.com/markets?conditionIds=${entry.polymarketId}&limit=1`,
          { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) { results.push({ marketId: ourId, status: 'api-error', code: r.status }); continue; }
        const raw = await r.json();
        const pm  = Array.isArray(raw) ? raw[0] : raw;
        if (!pm) { results.push({ marketId: ourId, status: 'not-found' }); continue; }
        if (!pm?.closed && !pm?.resolved) {
          results.push({ marketId: ourId, status: 'still-open', question: entry.question?.slice(0,50) });
          continue;
        }

        const resolution = (pm.resolution || '').toLowerCase();
        let winOut = null;
        if (resolution === 'yes' || resolution === entry.outcomeALabel?.toLowerCase()) winOut = 'A';
        else if (resolution === 'no'  || resolution === entry.outcomeBLabel?.toLowerCase()) winOut = 'B';

        if (!winOut) {
          results.push({ marketId: ourId, status: 'skip', reason: `Unknown resolution: ${pm.resolution}` });
          continue;
        }

        const outcomeArg = winOut === 'A' ? { A: null } : { B: null };
        const tx = callTx(funderName(), PID_V1, 'PredictionMarket/ResolveMarket',
          [Number(ourId), outcomeArg], null);

        if (tx.error) {
          results.push({ marketId: ourId, status: 'error', error: tx.error });
        } else {
          sync[ourId] = { ...entry, resolved: true, resolvedAt: new Date().toISOString(),
            winningOutcome: winOut, polymarketResolution: pm.resolution };
          results.push({ marketId: ourId, status: 'resolved', outcome: winOut, txHash: tx.txHash,
            question: entry.question?.slice(0,60) });
        }
      } catch (e2) {
        results.push({ marketId: ourId, status: 'error', error: e2.message });
      }
    }

    saveJson(POLY_SYNC_FILE, sync);
    cache.ts.standard = 0; cache.ts.fast = 0;
    res.json({ resolved: results.filter(r => r.status === 'resolved').length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Polymarket standard market auto-resolve ───────────────────────────────────
// Runs every 5 minutes — checks if any Polymarket-linked markets have resolved
async function autoResolvePolymarketMarkets() {
  if (!funderReady) return;
  const sync = loadJson(POLY_SYNC_FILE, {});
  const unresolved = Object.entries(sync).filter(([, e]) => !e.resolved);
  if (!unresolved.length) return;

  for (const [ourId, entry] of unresolved) {
    try {
      const r   = await fetch(
        `https://gamma-api.polymarket.com/markets?conditionIds=${entry.polymarketId}&limit=1`,
        { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) continue;
      const raw = await r.json();
      const pm  = Array.isArray(raw) ? raw[0] : raw;
      if (!pm?.closed && !pm?.resolved) continue;

      const resolution = (pm.resolution || '').toLowerCase();
      let winOut = null;
      if      (resolution === 'yes' || resolution === (entry.outcomeALabel||'').toLowerCase()) winOut = 'A';
      else if (resolution === 'no'  || resolution === (entry.outcomeBLabel||'').toLowerCase()) winOut = 'B';
      if (!winOut) { console.log(`[poly-resolve] #${ourId}: unknown resolution "${pm.resolution}", skip`); continue; }

      const tx = callTx(funderName(), PID_V1, 'PredictionMarket/ResolveMarket',
        [Number(ourId), winOut === 'A' ? { A: null } : { B: null }], null);

      sync[ourId] = { ...entry, resolved: true, resolvedAt: new Date().toISOString(),
        winningOutcome: winOut, polymarketResolution: pm.resolution };
      saveJson(POLY_SYNC_FILE, sync);
      cache.ts.standard = 0; cache.ts.fast = 0;

      const log = loadJson(RESOLUTIONS_FILE, []);
      log.push({ type: 'standard', marketId: ourId, polymarketId: entry.polymarketId,
        winningOutcome: winOut, resolvedAt: new Date().toISOString(),
        txHash: tx.txHash || null, error: tx.error || null });
      saveJson(RESOLUTIONS_FILE, log);

      if (tx.error) console.warn(`[poly-resolve] #${ourId} resolve tx error: ${tx.error}`);
      else          console.log(`[poly-resolve] #${ourId} resolved → ${winOut} (${pm.resolution}) tx=${tx.txHash}`);
    } catch (e) {
      if (!e.message.includes('timeout')) console.warn(`[poly-resolve] #${ourId} error: ${e.message}`);
    }
  }
}

// ── FastMarket auto-resolve background job ────────────────────────────────────
async function autoResolveFastMarkets() {
  if (!funderReady) return;
  try {
    const fast = await getMarkets('fast');
    const blockR = await callQuery(PID_V2, 'FastMarket/CurrentBlock', []);
    const currentBlock = Number(blockR?.result || 0);
    if (!currentBlock) return;

    for (const m of fast) {
      const status = m.status?.kind ?? m.status;
      if (status !== 'Open') continue;
      if (!m.resolve_after_block || currentBlock < m.resolve_after_block) continue;
      // This market is past its resolve block — settle it
      try {
        const { priceMicroUsd } = await fetchPrice(m.symbol);
        const result = callTx(funderName(), PID_V2, 'FastMarket/ResolveFastMarket',
          [Number(m.id), priceMicroUsd], null);
        const entry = {
          marketId:           m.id,
          symbol:             m.symbol,
          openPriceMicroUsd:  m.open_price_micro_usd,
          closePriceMicroUsd: priceMicroUsd,
          resolvedAt:         new Date().toISOString(),
          txHash:             result.txHash || null,
          error:              result.error  || null,
        };
        const log = loadJson(RESOLUTIONS_FILE, []);
        log.push(entry);
        saveJson(RESOLUTIONS_FILE, log);
        cache.ts.standard = 0; cache.ts.fast = 0;
        if (result.error) {
          console.warn(`[auto-resolve] FastMarket #${m.id} ${m.symbol}: ${result.error}`);
        } else {
          console.log(`[auto-resolve] FastMarket #${m.id} ${m.symbol} settled → tx ${result.txHash}`);
        }
      } catch (e) {
        console.warn(`[auto-resolve] FastMarket #${m.id} price fetch failed: ${e.message}`);
      }
    }
  } catch (e) {
    // Don't crash server on job error
    if (!e.message.includes('timeout')) console.warn('[auto-resolve] job error:', e.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
setupFunder();
app.listen(PORT, () => {
  console.log(`[vara-predict] http://localhost:${PORT}`);
  getMarkets('standard').then(m => console.log(`[cache] standard: ${m.length} markets`)).catch(() => {});
  getMarkets('fast').then(m => console.log(`[cache] fast: ${m.length} markets`)).catch(() => {});

  // Auto-resolve FastMarkets every 60 seconds
  setInterval(autoResolveFastMarkets, 60_000);
  setTimeout(autoResolveFastMarkets, 10_000);
  console.log('[auto-resolve] FastMarket settler started (every 60s)');

  // Auto-resolve Polymarket-linked standard markets every 5 minutes
  setInterval(autoResolvePolymarketMarkets, 5 * 60_000);
  setTimeout(autoResolvePolymarketMarkets, 30_000); // first check after 30s
  console.log('[auto-resolve] Polymarket standard settler started (every 5min)');
});
