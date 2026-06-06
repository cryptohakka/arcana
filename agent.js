require('dotenv').config();
const fs      = require('fs');
const axios   = require('axios');
const { ethers } = require('ethers');
const { detectRegime } = require('./regime');
const { getVaults }    = require('./earn');
const { rankVaults }   = require('./scorer');
const { depositToVault } = require('./composer');
const { unifiedTransferToArc, unifiedTransferFromArc, getUnifiedBalance, unifiedDeposit } = require('./arc');
const {
  getProviderWithFallback,
  getUsdcAddress,
  recordTx,
} = require('./tools');

const REGIME_PATH    = './regime.json';
const POSITIONS_PATH = './positions.json';

// USYC on Base (risk-off stable yield)
// TODO: confirm mainnet address before going live
const USYC_ADDRESS = process.env.USYC_ADDRESS || '0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b';
const USYC_CHAIN   = 8453;  // Base mainnet (LI.FI vault scoring)
const ARC_PAIR_CHAIN = 84532; // Base Sepolia (Arc testnet pair)

const INTERVAL_MS  = parseInt(process.env.REGIME_CHECK_INTERVAL) || 15 * 60 * 1000; // 15 min default

const WEBHOOK_SYSTEM = process.env.DISCORD_SYSTEM_WEBHOOK;

// ── Discord notify ────────────────────────────────────────────────────────────
async function notify(content, eoa = null) {
  fetch('http://localhost:'+(process.env.ARCANA_PORT||5003)+'/internal/log', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ line: content, eoa })
  }).catch(()=>{});
  await axios.post(WEBHOOK_SYSTEM, { content, username: '🤖 System' })
    .catch(e => console.error('[notify]', e.message));
}

// ── Load / save positions ─────────────────────────────────────────────────────
function loadPositions() {
  if (!fs.existsSync(POSITIONS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8')); }
  catch { return []; }
}

function savePositions(positions) {
  fs.writeFileSync(POSITIONS_PATH, JSON.stringify(positions, null, 2));
}

// ── Get wallet USDC balance ───────────────────────────────────────────────────
async function getUsdcBalance(chainId, walletAddress) {
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
  const USDC_BY_CHAIN = {
    84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
    8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet
  };
  const RPC_BY_CHAIN = {
    84532: 'https://sepolia.base.org',
    8453:  'https://mainnet.base.org',
  };
  const usdcAddr = USDC_BY_CHAIN[chainId] || getUsdcAddress(chainId);
  const rpc      = RPC_BY_CHAIN[chainId];
  const provider = rpc ? new ethers.JsonRpcProvider(rpc) : await getProviderWithFallback(chainId);
  const usdc     = new ethers.Contract(usdcAddr, ERC20_ABI, provider);
  const bal      = await usdc.balanceOf(walletAddress);
  return parseFloat(ethers.formatUnits(bal, 6));
}

// ── Find best risk-on vault ───────────────────────────────────────────────────
const FALLBACK_VAULT = {
  vault: { address: '0xf115c134c23c7a05fbd489a8be3116ebf54b0d9f', name: 'USDC', protocol: 'yearn', chainId: 8453 },
  apy: 56.0, score: 38.0, netApy: 56.0, tvlUsd: 1800000,
};

async function findBestVault(walletAddress, amountUsd) {
  try {
    const vaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
    const ranked = rankVaults(vaults, amountUsd);
    return ranked[0] || FALLBACK_VAULT;
  } catch(e) {
    console.log(`[agent] LI.FI API error (${e.message?.slice(0,40)}), using fallback vault`);
    return FALLBACK_VAULT;
  }
}

// ── Risk-on: deploy into best yield vault ────────────────────────────────────
async function getArcWalletBalance(address = null) {
  const { createPublicClient, http, formatUnits } = require('viem');
  const arcTestnetChain = {
    id: 2911, name: 'Arc Testnet',
    rpcUrls: { default: { http: [process.env.RPC_ARC] } },
  };
  const ARC_USDC = '0x3600000000000000000000000000000000000000';
  const ERC20_ABI = [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }];
  const client = createPublicClient({ chain: arcTestnetChain, transport: http(process.env.RPC_ARC) });
  const target = address || process.env.WALLET_ADDRESS;
  const bal = await client.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [target] });
  return parseFloat(formatUnits(bal, 6));
}

async function executeRiskOn(regime, walletAddress, walletId, eoa) {
  console.log('[agent] risk_on: scanning best vault...');
  const fromChainId = ARC_PAIR_CHAIN; // Arc testnet pairs with Base Sepolia

  // Retrieve parked USDC from Arc Testnet back to Base Sepolia
  try {
    const arcBalances = await getUnifiedBalance(walletId, walletAddress);
    const arcAvailable = arcBalances.arcTestnet || 0;
    console.log(`[agent] gateway balance: arcTestnet=${arcAvailable} USDC`);
    // Use actual Arc Testnet wallet balance, not Gateway API balance
    const arcWalletBal = await getArcWalletBalance(walletAddress);
    console.log(`[agent] arc wallet balance: ${arcWalletBal} USDC`);
    const retrievable = arcWalletBal; // Arc Testnet wallet balance (deposit then spend)
    if (retrievable >= 0.1) {
      const retrieveAmount = (Math.floor(retrievable * 0.9 * 10) / 10).toString();
      console.log(`[agent] retrieving ${retrieveAmount} USDC ← Arc Testnet...`);
      await notify(`🌉 **Retrieving ${retrieveAmount} USDC ← Arc Testnet** (risk-on)`, eoa);
      await unifiedDeposit(retrieveAmount, 'Arc_Testnet', walletId, walletAddress);
      const { privateKeyToAccount } = require('viem/accounts');
      const viemRecipient = eoa || privateKeyToAccount(process.env.PRIVATE_KEY).address;
      const burnTx = await unifiedTransferFromArc(retrieveAmount, viemRecipient, walletId, walletAddress);
      console.log(`[agent] retrieve tx: ${burnTx}`);
      await notify('✅ **Retrieved from Arc** — tx: `' + burnTx + '`', eoa);
      recordTx({ type: 'arcana-arc-retrieve', amount: retrieveAmount, regime: 'risk_on', tx: burnTx });
      await new Promise(r => setTimeout(r, 5000));
    }
  } catch (e) {
    await notify(`⚠️ **Arc retrieve failed** — ${e.message?.slice(0, 100)}`, eoa);
    console.error('[agent] arc retrieve error:', e.message);
  }

  // Base SepoliaのUSDCはviem EOA(=eoa)に届く、Circle Walletアドレスではない
  const usdcCheckAddress = eoa || walletAddress;
  const usdcBal = await getUsdcBalance(fromChainId, usdcCheckAddress);
  console.log(`[agent] viem EOA USDC balance: ${usdcBal}`);
  if (usdcBal < 1) {
    await notify(`⚠️ **Risk-On skipped** — USDC balance too low ($${usdcBal.toFixed(2)})`, eoa);
    return;
  }

  const best = await findBestVault(walletAddress, usdcBal);
  if (!best) {
    await notify('⚠️ **Risk-On skipped** — no suitable vault found', eoa);
    return;
  }

  await notify(
    `🟢 **Risk-On Rebalance**\n` +
    `BTC: $${regime.btc_price} | Phase: ${regime.phase} | Confidence: ${regime.confidence}\n` +
    `→ Deploying $${usdcBal.toFixed(2)} USDC into **${best.vault.name}** (${best.vault.protocol})\n` +
    `  APY: ${best.apy.toFixed(2)}% | Chain: ${best.vault.chainId}`
  , eoa);

  // Dry-run: vault deposit skipped (Arc Testnet -> Base Sepolia testnet only)
  // LI.FI Earn API identifies optimal mainnet vault in real-time.
  if (eoa) savePosition(eoa, {
    vaultAddress: best.vault.address,
    vaultName:    best.vault.name,
    protocol:     best.vault.protocol,
    chainId:      best.vault.chainId,
    valueUsd:     usdcBal,
    apy:          best.apy,
    depositedAt:  new Date().toISOString(),
  });
  recordTx({
    type:    'arcana-risk-on',
    toVault: best.vault.name,
    chainId: best.vault.chainId,
    valueUsd: usdcBal,
    apy:     best.apy,
    regime:  'risk_on',
  });
  await notify(
    `✅ **Risk-On: Vault Selected** (LI.FI Earn)\n` +
    `-> **${best.vault.name}** (${best.vault.protocol}) on ${best.vault.network}\n` +
    `   APY: ${best.apy.toFixed(2)}% | Score: ${best.score} | TVL: $${(best.tvlUsd/1e6).toFixed(1)}M\n` +
    `   Amount: $${usdcBal.toFixed(2)} USDC (mainnet deposit: ready)`
  , eoa);
  if (eoa) {
    const txHash = await recordOpen(eoa, usdcBal, best.vault.name, regime.phase);
    if (txHash) await notify(`📝 **Recorded onchain** — [tx](${process.env.ARC_EXPLORER}/tx/${txHash})`, eoa);
  }
}

// ── Risk-off: consolidate into USYC ──────────────────────────────────────────
async function executeRiskOff(regime, walletAddress, walletId, eoa) {
  console.log('[agent] risk_off: checking USDC position...');

  const positions = eoa ? [getPosition(eoa)].filter(Boolean) : loadPositions();
  console.log("[agent] active positions: " + positions.length);
  await notify(
    `🔴 **Risk-Off**\n` +
    `BTC: $${regime.btc_price} | Phase: ${regime.phase} | Confidence: ${regime.confidence}\n` +
    `→ ${positions.length > 0 ? "Consolidating " + positions.length + " position(s) into USDC" : "No vault positions — bridging idle USDC to Arc"}\n` +
    `  Reason: ${regime.reasoning}`
  , eoa);

  for (const pos of positions) {
    recordTx({
      type:     'arcana-risk-off',
      fromVault: pos.vaultName,
      chainId:   pos.chainId,
      valueUsd:  pos.valueUsd,
      regime:    'risk_off',
    });
    console.log(`[agent] would withdraw from ${pos.vault_name||pos.vaultName} ($${pos.value_usd||pos.valueUsd})`);
  }

  // Bridge idle USDC to Arc Testnet (USYC stable yield)
  try {
    // Deposit wallet USDC into Unified Balance first
    // Circle WalletとviemEOA両方のBase Sepolia残高を確認
    const { privateKeyToAccount } = require('viem/accounts');
    const viemEoa = privateKeyToAccount(process.env.PRIVATE_KEY).address;
    const viemBal = await getUsdcBalance(ARC_PAIR_CHAIN, viemEoa);
    const circleBal = walletAddress ? await getUsdcBalance(ARC_PAIR_CHAIN, walletAddress) : 0;
    const walletBal = viemBal + circleBal;
    console.log(`[agent] wallet balance: baseSepolia=${walletBal} USDC (viem=${viemBal} circle=${circleBal})`);
    // Circle Wallet Base Sepolia→Unified depositはSDK制約でスキップ
    if (viemBal >= 1) {
      const depositAmount = (Math.floor(viemBal * 0.9 * 10) / 10).toString();
      console.log(`[agent] depositing ${depositAmount} USDC from viem EOA to Unified Balance...`);
      await unifiedDeposit(depositAmount, 'Base_Sepolia', null, null);
    }
    const balances = await getUnifiedBalance(walletId, walletAddress);
    const available = balances.baseSepolia || 0;
    const arcAvailable = balances.arcTestnet || 0;
    console.log(`[agent] gateway balance: baseSepolia=${available} arcTestnet=${arcAvailable} USDC`);
    if (arcAvailable >= 0.5) {
      await notify(`✅ **Already parked on Arc** — ${arcAvailable.toFixed(2)} USDC on Arc Testnet`, eoa);
    } else if (available >= 0.5) {
      const bridgeAmount = (Math.floor(available * 10) / 10).toString();
      console.log(`[agent] bridging ${bridgeAmount} USDC → Arc Testnet...`);
      await notify(`🌉 **Bridging ${bridgeAmount} USDC → Arc Testnet** (USDC parking)`, eoa);
      const mintTx = await unifiedTransferToArc(bridgeAmount, null, walletId, walletAddress);
      console.log(`[agent] bridge tx: ${mintTx}`);
      await notify('✅ **Parked on Arc** — tx: `' + mintTx + '`', eoa);
      recordTx({ type: 'arcana-arc-bridge', amount: bridgeAmount, regime: 'risk_off', tx: mintTx });
    } else {
      await notify(`ℹ️ Gateway balance low (${available} USDC), skipping Arc bridge`, eoa);
    }
  } catch (e) {
    await notify(`⚠️ **Arc bridge failed** — ${e.message?.slice(0, 100)}`, eoa);
    console.error('[agent] arc bridge error:', e.message);
  }

  if (eoa) clearPosition(eoa); else savePositions([]);
  await notify(`✅ **Consolidated** — Capital parked in USDC stable yield`, eoa);
  if (eoa) {
    const txHash = await recordClose(eoa, regime.phase + ': ' + (regime.reason?.slice(0,60) || 'risk-off'));
    if (txHash) await notify(`📝 **Recorded onchain** — [tx](${process.env.ARC_EXPLORER}/tx/${txHash})`, eoa);
  }
}

// ── DB ────────────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { recordOpen, recordClose } = require('./recorder');
function getDb() { return new Database('./users.db'); }

function getLastRegime() {
  const db = getDb();
  const rows = db.prepare('SELECT regime FROM regime_history ORDER BY id DESC LIMIT 2').all();
  db.close();
  if (rows.length < 2) return rows[0]?.regime || null;
  // hysteresis: only return confirmed regime if last 2 agree
  return rows[0].regime === rows[1].regime ? rows[0].regime : null;
}

function saveRegime(regime) {
  const db = getDb();
  db.prepare('INSERT INTO regime_history (regime, phase, confidence, btc_price, rebalance) VALUES (?,?,?,?,?)')
    .run(regime.regime, regime.phase, regime.confidence, regime.btc_price, regime.rebalance ? 1 : 0);
  db.close();
}

function getAllUsers() {
  const db = getDb();
  const users = db.prepare('SELECT eoa, wallet_id, wallet_address FROM users').all();
  db.close();
  return users;
}

function savePosition(eoa, pos) {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO user_positions
    (eoa, vault_address, vault_name, protocol, chain_id, value_usd, apy, deposited_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(eoa, pos.vaultAddress, pos.vaultName, pos.protocol, pos.chainId, pos.valueUsd, pos.apy||null, pos.depositedAt);
  db.close();
}

function clearPosition(eoa) {
  const db = getDb();
  db.prepare('DELETE FROM user_positions WHERE eoa=?').run(eoa);
  db.close();
}

function getPosition(eoa) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_positions WHERE eoa=?').get(eoa);
  db.close();
  return row || null;
}


// ── Post-Mortem Agent ─────────────────────────────────────────────────────────
const POST_MORTEMS_FILE = './post_mortems.json';
async function runPostMortem(eoa, action, vaultName, valueUsd, regime, entryRegime) {
  try {
    const { infer } = require('./regime');
    const prompt = `You are a portfolio post-mortem analyst. A rebalance action just executed.
Action: ${action} (regime changed to ${regime})
Vault/Target: ${vaultName}
Value: ${valueUsd?.toFixed(2) ?? 'N/A'}
Prior regime: ${entryRegime ?? 'unknown'}
Write ONE concise sentence explaining the rationale for this rebalance and the primary risk it carries. Be specific about market conditions that triggered it. No preamble.`;
    const analysis = await infer([{ role: 'user', content: prompt }], 200, 'PostMortem');
    let mortems = [];
    if (fs.existsSync(POST_MORTEMS_FILE)) mortems = JSON.parse(fs.readFileSync(POST_MORTEMS_FILE, 'utf8'));
    mortems.unshift({ ts: new Date().toISOString(), eoa: eoa?.slice(0,10), action, vaultName, valueUsd, regime, entryRegime, analysis });
    if (mortems.length > 50) mortems = mortems.slice(0, 50);
    fs.writeFileSync(POST_MORTEMS_FILE, JSON.stringify(mortems, null, 2));
    console.log(`[post-mortem] ${action} — ${analysis?.slice(0,80)}`);
  } catch(e) { console.error('[post-mortem] failed:', e.message); }
}
// ── Main loop ─────────────────────────────────────────────────────────────────
async function run() {
  await notify(`🚀 **Arcana Agent Started**\nInterval: ${INTERVAL_MS / 60000} min`);

  while (true) {
    try {
      console.log('\n[arcana] running regime detection...');
      const regime = await detectRegime();
      const lastRegime = getLastRegime();
      saveRegime(regime);

      const regimeChanged = lastRegime !== null && lastRegime !== regime.regime;

      if (!regime.rebalance && !regimeChanged) {
        console.log(`[arcana] no rebalance needed (regime=${regime.regime}, confidence=${regime.confidence})`);
      } else {
        const users = getAllUsers();
        await notify(`🔄 **Regime: ${regime.regime.toUpperCase()}** | Users: ${users.length} | BTC: $${regime.btc_price}`);

        await Promise.allSettled(users.map(async (user) => {
          try {
            if (regime.regime === 'risk_on') {
              await executeRiskOn(regime, user.wallet_address, user.wallet_id, user.eoa);
            } else {
              await executeRiskOff(regime, user.wallet_address, user.wallet_id, user.eoa);
            }
          } catch (e) {
            console.error(`[arcana] user ${user.eoa.slice(0,8)} error:`, e.message);
          }
        }));
      }
    } catch (e) {
      console.error('[arcana] loop error:', e.message);
      await notify(`⚠️ **Agent Error** — ${e.message?.slice(0, 100)}`);
    }

    console.log(`[arcana] next run in ${INTERVAL_MS / 60000} min`);
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

// Export actions for ui-server
module.exports = { executeRiskOn, executeRiskOff, getAllUsers, getPosition };

if (require.main === module) {
  run().catch(e => {
    console.error('[arcana] fatal:', e.message);
    process.exit(1);
  });
}
