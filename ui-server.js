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
const clients = new Map(); // eoa -> Set<res>
const logBuffers = new Map(); // eoa -> [{id,line,ts}]
function getLogBuffer(eoa) {
  if (!logBuffers.has(eoa)) logBuffers.set(eoa, []);
  return logBuffers.get(eoa);
}
function broadcast(obj, eoa = null) {
  if (obj.type === 'log') {
    const targets = eoa ? [eoa] : [...logBuffers.keys(), '__global__'];
    for (const key of (eoa ? [eoa] : ['__global__'])) {
      const buf = getLogBuffer(key);
      const id = (buf.length > 0 ? buf[buf.length-1].id : 0) + 1;
      buf.push({ ...obj, ts: new Date().toISOString(), id });
      if (buf.length > 200) buf.shift();
    }
  }
  if (eoa) {
    const conns = clients.get(eoa);
    if (conns) conns.forEach(c => c.write('data: ' + JSON.stringify(obj) + '\n\n'));
  } else {
    // global broadcast (regime, balances等)
    clients.forEach(conns => conns.forEach(c => c.write('data: ' + JSON.stringify(obj) + '\n\n')));
  }
}
app.get('/events', (req, res) => {
  res.set({ 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
  res.flushHeaders();
  const eoa = req.query.eoa?.toLowerCase() || '__global__';
  const lastId = parseInt(req.headers['last-event-id'] || '0');
  const buf = getLogBuffer(eoa);
  const toSend = lastId > 0 ? buf.filter(e => e.id > lastId) : buf;
  for (const entry of toSend) {
    res.write('id: ' + entry.id + '\ndata: ' + JSON.stringify(entry) + '\n\n');
  }
  // heartbeat
  res.write(': heartbeat\n\n');
  if (!clients.has(eoa)) clients.set(eoa, new Set());
  clients.get(eoa).add(res);
  req.on('close', () => {
    const conns = clients.get(eoa);
    if (conns) { conns.delete(res); if (conns.size === 0) clients.delete(eoa); }
  });
});

// GET
app.get('/api/regime',     (req, res) => { try { res.json(JSON.parse(fs.readFileSync(REGIME_PATH,'utf8'))); } catch { res.json({}); } });
app.get('/api/snapshots',  (req, res) => { try { res.json(JSON.parse(fs.readFileSync(SNAPSHOTS_PATH,'utf8'))); } catch { res.json([]); } });
app.get('/api/tx-history', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(TX_PATH,'utf8'))); } catch { res.json([]); } });
app.get('/api/balances', async (req, res) => {
  const orig = console.log; console.log = () => {};
  try {
    const { AppKit } = require('@circle-fin/app-kit');
    const { createCircleWalletsAdapter } = require('@circle-fin/adapter-circle-wallets');
    const { createViemAdapterFromPrivateKey } = require('@circle-fin/adapter-viem-v2');
    const kit = new AppKit();

    // ユーザーEOAが指定されてればCircle Walletアダプター、なければPRIVATE_KEY
    const userEoa = req.query.address?.toLowerCase();
    let adapter, walletAddress;
    if (userEoa) {
      const row = db.prepare('SELECT * FROM users WHERE eoa = ?').get(userEoa);
      if (!row) return res.status(404).json({ error: 'wallet not found, register first' });
      adapter = createCircleWalletsAdapter({
        apiKey: process.env.CIRCLE_API_KEY,
        entitySecret: process.env.CIRCLE_ENTITY_SECRET,
        walletId: row.wallet_id,
      });
      walletAddress = row.wallet_address;
    } else {
      adapter = createViemAdapterFromPrivateKey({ privateKey: process.env.PRIVATE_KEY });
      walletAddress = process.env.CIRCLE_WALLET_ADDRESS;
    }

    const walletId = userEoa ? db.prepare('SELECT wallet_id FROM users WHERE eoa = ?').get(userEoa)?.wallet_id : process.env.CIRCLE_WALLET_ID;
    const [gwRes, circleTokens] = await Promise.all([
      fetch('https://gateway-api-testnet.circle.com/v1/balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'USDC', sources: [{ domain: 26, depositor: walletAddress }] }),
      }).then(r => r.json()),
      getAgentWalletBalance(walletId)
    ]);
    const CHAIN_MAP = {
      0: 'Ethereum_Sepolia', 1: 'Avalanche_Fuji', 2: 'Optimism_Sepolia',
      3: 'Arbitrum_Sepolia', 5: 'Solana_Devnet', 6: 'Base_Sepolia',
      7: 'Polygon_Amoy_Testnet', 10: 'Unichain_Sepolia', 13: 'Sonic_Testnet',
      14: 'World_Chain_Sepolia', 16: 'Sei_Testnet', 19: 'HyperEVM_Testnet', 26: 'Arc_Testnet'
    };
    const gwBalances = gwRes.balances || [];
    const ALL_CHAINS = ['Ethereum_Sepolia','Base_Sepolia','Avalanche_Fuji','Arbitrum_Sepolia','Sonic_Testnet','World_Chain_Sepolia','Sei_Testnet','HyperEVM_Testnet','Arc_Testnet','Optimism_Sepolia','Polygon_Amoy_Testnet','Unichain_Sepolia'];
    const gwMap = {};
    gwBalances.forEach(b => { const name = CHAIN_MAP[b.domain]; if(name) gwMap[name] = parseFloat(b.balance||'0'); });
    const chains = ALL_CHAINS.map(chain => ({ chain, balance: gwMap[chain] || 0 }));
    const circleWallet = parseFloat(circleTokens.find(t => t.token?.symbol === 'USDC' && !t.token?.isNative)?.amount || '0');
    const unifiedTotal = gwBalances.reduce((s, b) => s + parseFloat(b.balance || '0'), 0);
    const total = circleWallet + unifiedTotal;
    const baseSepolia = chains.find(c => c.chain === 'Base_Sepolia')?.balance || 0;
    const arcTestnet  = chains.find(c => c.chain === 'Arc_Testnet')?.balance || 0;
    res.json({ chains, unifiedTotal, circleWallet, total, baseSepolia, arcTestnet, walletAddress });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
  finally { console.log = orig; }
});

// Inline runner
let running = false;
async function runInline(fn, label, eoa = null) {
  if (running) { broadcast({ type:'error', message:'Already running' }, eoa); return; }
  running = true;
  broadcast({ type:'start', script: label }, eoa);
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a) => {
    const line = a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    orig(line);
    broadcast({ type:'log', line }, eoa);
  };
  console.error = (...a) => {
    const line = a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    origErr(line);
    broadcast({ type:'log', line: '⚠️ ' + line }, eoa);
  };
  try {
    await fn();
    broadcast({ type:'done', code:0 }, eoa);
  } catch(e) {
    broadcast({ type:'log', line:'❌ ' + e.message }, eoa);
    broadcast({ type:'done', code:1 }, eoa);
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
  runInline(() => detectRegime(), 'regime-check', req.body?.eoa?.toLowerCase() || null);
});
app.post('/api/risk-on', (req, res) => {
  res.json({ ok:true });
  const eoa = req.body?.eoa?.toLowerCase();
  const regime = (() => { try { return JSON.parse(fs.readFileSync(REGIME_PATH,'utf8')); } catch { return {}; } })();
  async function runForUsers() {
    const { getAllUsers } = require('./agent');
    const users = eoa
      ? [db.prepare('SELECT eoa, wallet_id, wallet_address FROM users WHERE eoa=?').get(eoa)].filter(Boolean)
      : getAllUsers();
    for (const user of users) {
      await executeRiskOn(regime, user.wallet_address, user.wallet_id, user.eoa);
    }
  }
  runInline(() => runForUsers(), 'risk-on', eoa || null);
});
app.post('/api/risk-off', (req, res) => {
  res.json({ ok:true });
  const eoa = req.body?.eoa?.toLowerCase();
  const regime = (() => { try { return JSON.parse(fs.readFileSync(REGIME_PATH,'utf8')); } catch { return {}; } })();
  async function runForUsers() {
    const { getAllUsers } = require('./agent');
    const users = eoa
      ? [db.prepare('SELECT eoa, wallet_id, wallet_address FROM users WHERE eoa=?').get(eoa)].filter(Boolean)
      : getAllUsers();
    for (const user of users) {
      await executeRiskOff(regime, user.wallet_address, user.wallet_id, user.eoa);
    }
  }
  runInline(() => runForUsers(), 'risk-off', eoa || null);
});

// ── Positions ────────────────────────────────────────────────────────────────
app.get('/api/positions', (req, res) => {
  const eoa = req.query.eoa?.toLowerCase();
  const { getAllUsers, getPosition } = require('./agent');
  if (eoa) {
    const pos = getPosition(eoa);
    return res.json(pos ? [pos] : []);
  }
  const users = getAllUsers();
  const positions = users.map(u => {
    const pos = getPosition(u.eoa);
    return pos ? { ...pos, eoa: u.eoa } : null;
  }).filter(Boolean);
  res.json(positions);
});

// ── User Count ───────────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  try {
    const count = db.prepare('SELECT COUNT(*) as count FROM users').get();
    res.json({ count: count.count });
  } catch(e) { res.json({ count: 0 }); }
});

// ── Internal Log (from agent.js) ─────────────────────────────────────────────
app.post('/internal/log', (req, res) => {
  const { line, eoa } = req.body || {};
  if (line) broadcast({ type:'log', line }, eoa?.toLowerCase() || null);
  res.json({ ok: true });
});

// ── Withdraw ─────────────────────────────────────────────────────────────────
app.post('/api/withdraw', async (req, res) => {
  try {
    const { eoa, amount } = req.body;
    if (!eoa || !amount) return res.status(400).json({ error: 'eoa and amount required' });
    const row = db.prepare('SELECT * FROM users WHERE eoa = ?').get(eoa.toLowerCase());
    if (!row) return res.status(404).json({ error: 'wallet not found' });
    const { createCircleWalletsAdapter } = require('@circle-fin/adapter-circle-wallets');
    const { AppKit } = require('@circle-fin/app-kit');
    const adapter = createCircleWalletsAdapter({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
    const kit = new AppKit();
    // Unified残高を取得して実際の残高でspend
    const { getUnifiedBalance } = require('./arc');
    const ubBal = await getUnifiedBalance(row.wallet_id, row.wallet_address);
    const arcBal = ubBal.arcTestnet || 0;
    let unifiedTxHash = null;
    if (arcBal >= 0.01) {
      const spendAmt = (Math.floor((arcBal - 0.01) * 100) / 100).toFixed(2);
      const result = await kit.unifiedBalance.spend({
        amount: spendAmt,
        token: 'USDC',
        from: { adapter, address: row.wallet_address },
        to: { adapter, chain: 'Arc_Testnet', recipientAddress: eoa, address: row.wallet_address },
      });
      unifiedTxHash = result.txHash;
    }
    // Circle Walletも同時に引き出し
    const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');
    const circleClient = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
    const balRes = await circleClient.getWalletTokenBalance({ id: row.wallet_id });
    const circleBal = parseFloat(balRes.data?.tokenBalances?.find(t => t.token?.symbol === 'USDC')?.amount || '0');
    let circleTxId = null;
    if (circleBal >= 0.01) {
      const tx = await circleClient.createTransaction({
        walletId:           row.wallet_id,
        tokenAddress:       '0x3600000000000000000000000000000000000000',
        destinationAddress: eoa,
        amounts:            [circleBal.toString()],
        fee:                { type: 'level', config: { feeLevel: 'MEDIUM' } },
        blockchain:         'ARC-TESTNET',
      });
      circleTxId = tx.data?.transaction?.id || tx.data?.id;
    }
    res.json({ ok: true, txHash: unifiedTxHash, circleTxId });
  } catch(e) {
    console.error('[withdraw]', e.message);
    res.status(500).json({ error: e.message });
  }
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

const server = app.listen(PORT, () => {
  console.log('[ui-server] :' + PORT);
  setTimeout(async () => {
    try { broadcast({ type:'regime', data: JSON.parse(fs.readFileSync(REGIME_PATH,'utf8')) }); } catch {}
  }, 1000);
});
server.on('error', (e) => console.error('[server error]', e.message));
process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
