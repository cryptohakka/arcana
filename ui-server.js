require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const { getGatewayBalance, getAgentWalletBalance } = require('./arc');
const { detectRegime }      = require('./regime');
const { executeRiskOn, executeRiskOff } = require('./agent');

const app  = express();
const PORT = parseInt(process.env.ARCANA_PORT) || 5001;
const PASS = process.env.ARCANA_PASSWORD || null;

const REGIME_PATH    = path.join(__dirname, 'regime.json');
const SNAPSHOTS_PATH = path.join(__dirname, 'snapshots.json');
const TX_PATH        = path.join(__dirname, 'tx_history.json');

app.use(express.json());



// SSE
const clients = new Set();
function broadcast(obj) {
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  clients.forEach(c => c.write(data));
}
app.get('/events', (req, res) => {
  res.set({ 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// GET
app.get('/api/regime',     (req, res) => { try { res.json(JSON.parse(fs.readFileSync(REGIME_PATH,'utf8'))); } catch { res.json({}); } });
app.get('/api/snapshots',  (req, res) => { try { res.json(JSON.parse(fs.readFileSync(SNAPSHOTS_PATH,'utf8'))); } catch { res.json([]); } });
app.get('/api/tx-history', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(TX_PATH,'utf8'))); } catch { res.json([]); } });
app.get('/api/balances', async (req, res) => {
  const orig = console.log; console.log = () => {};
  try {
    const [gateway, agent] = await Promise.all([getGatewayBalance(), getAgentWalletBalance()]);
    const agentUsdc = agent.find(t => t.token.symbol === 'USDC')?.amount || '0';
    res.json({ ...gateway, agentWallet: parseFloat(agentUsdc) });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
  finally { console.log = orig; }
});

// Inline runner
let running = false;
async function runInline(fn, label) {
  if (running) { broadcast({ type:'error', message:'Already running' }); return; }
  running = true;
  broadcast({ type:'start', script: label });
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a) => {
    const line = a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    orig(line);
    broadcast({ type:'log', line });
  };
  console.error = (...a) => {
    const line = a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    origErr(line);
    broadcast({ type:'log', line: '⚠️ ' + line });
  };
  try {
    await fn();
    broadcast({ type:'done', code:0 });
  } catch(e) {
    broadcast({ type:'log', line:'❌ ' + e.message });
    broadcast({ type:'done', code:1 });
  } finally {
    console.log = orig;
    running = false;
    getGatewayBalance().then(b => broadcast({ type:'balances', data:b })).catch(()=>{});
    try { broadcast({ type:'regime', data: JSON.parse(fs.readFileSync(REGIME_PATH,'utf8')) }); } catch {}
  }
}

// POST
app.post('/api/regime-check', (req, res) => {
  res.json({ ok:true });
  runInline(() => detectRegime(), 'regime-check');
});
app.post('/api/risk-on', (req, res) => {
  res.json({ ok:true });
  const { ethers } = require('ethers');
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  const regime = (() => { try { return JSON.parse(fs.readFileSync(REGIME_PATH,'utf8')); } catch { return {}; } })();
  runInline(() => executeRiskOn(regime, wallet), 'risk-on');
});
app.post('/api/risk-off', (req, res) => {
  res.json({ ok:true });
  const { ethers } = require('ethers');
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  const regime = (() => { try { return JSON.parse(fs.readFileSync(REGIME_PATH,'utf8')); } catch { return {}; } })();
  runInline(() => executeRiskOff(regime, wallet), 'risk-off');
});

// ── User Wallet Management ───────────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'users.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users (
  eoa TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);

const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');
function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey:       process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });
}

// GET /api/user/:eoa — ウォレット情報取得（DB消失時はCircle逆引き）
app.get('/api/user/:eoa', async (req, res) => {
  try {
    const eoa = req.params.eoa.toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE eoa = ?').get(eoa);
    if (row) return res.json({ exists: true, walletAddress: row.wallet_address, walletId: row.wallet_id });

    // DBにない場合Circle側で逆引き
    const client = getCircleClient();
    const result = await client.listWallets({ refId: eoa });
    const wallet = result.data?.wallets?.[0];
    if (wallet) {
      // DB復元
      db.prepare('INSERT OR IGNORE INTO users (eoa, wallet_id, wallet_address) VALUES (?, ?, ?)')
        .run(eoa, wallet.id, wallet.address);
      console.log(`[user] restored wallet for ${eoa.slice(0,8)}... from Circle`);
      return res.json({ exists: true, walletAddress: wallet.address, walletId: wallet.id });
    }
    res.json({ exists: false });
  } catch(e) {
    res.json({ exists: false });
  }
});

// POST /api/user/register — EOA署名検証 → DCWウォレット生成
app.post('/api/user/register', async (req, res) => {
  try {
    const { eoa, signature, message } = req.body;
    if (!eoa || !signature || !message) return res.status(400).json({ error: 'missing fields' });

    // 署名検証
    const { ethers } = require('ethers');
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== eoa.toLowerCase()) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    // 既存チェック
    const existing = db.prepare('SELECT * FROM users WHERE eoa = ?').get(eoa.toLowerCase());
    if (existing) {
      return res.json({ walletAddress: existing.wallet_address, walletId: existing.wallet_id, created: false });
    }

    // DCWウォレット生成
    const client = getCircleClient();
    const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
    const w = await client.createWallets({
      walletSetId,
      blockchains: ['ARC-TESTNET'],
      count: 1,
      accountType: 'EOA',
      metadata: [{ refId: eoa.toLowerCase() }],
    });
    const wallet = w.data?.wallets?.[0];
    if (!wallet) return res.status(500).json({ error: 'wallet creation failed' });

    db.prepare('INSERT INTO users (eoa, wallet_id, wallet_address) VALUES (?, ?, ?)')
      .run(eoa.toLowerCase(), wallet.id, wallet.address);

    console.log(`[user] new wallet for ${eoa.slice(0,8)}... → ${wallet.address}`);
    res.json({ walletAddress: wallet.address, walletId: wallet.id, created: true });
  } catch(e) {
    console.error('[user] register error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve static files last
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('[ui-server] :' + PORT);
  setTimeout(async () => {
    try { broadcast({ type:'regime', data: JSON.parse(fs.readFileSync(REGIME_PATH,'utf8')) }); } catch {}
    try { const orig2 = console.log; console.log = ()=>{}; const b = await getGatewayBalance(); console.log = orig2; broadcast({ type:'balances', data:b }); } catch(e) {}
  }, 1000);
});
