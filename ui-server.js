require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const { getGatewayBalance } = require('./arc');
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
  try { res.json(await getGatewayBalance()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Inline runner
let running = false;
async function runInline(fn, label) {
  if (running) { broadcast({ type:'error', message:'Already running' }); return; }
  running = true;
  broadcast({ type:'start', script: label });
  const orig = console.log;
  console.log = (...a) => {
    const line = a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    orig(line);
    broadcast({ type:'log', line });
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

// Serve static files last
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('[ui-server] :' + PORT);
  setTimeout(async () => {
    try { broadcast({ type:'regime', data: JSON.parse(fs.readFileSync(REGIME_PATH,'utf8')) }); } catch {}
    try { const b = await getGatewayBalance(); broadcast({ type:'balances', data:b }); } catch {}
  }, 1000);
});
