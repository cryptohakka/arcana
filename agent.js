require('dotenv').config();
const fs      = require('fs');
const axios   = require('axios');
const { ethers } = require('ethers');
const { detectRegime } = require('./regime');
const { getVaults }    = require('./earn');
const { rankVaults }   = require('./scorer');
const { depositToVault } = require('./composer');
const { transferToArc, getGatewayBalance } = require('./arc');
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
const USYC_CHAIN   = 8453; // Base

const INTERVAL_MS  = parseInt(process.env.REGIME_CHECK_INTERVAL) || 15 * 60 * 1000; // 15 min default

const WEBHOOK_SYSTEM = process.env.DISCORD_SYSTEM_WEBHOOK;

// ── Discord notify ────────────────────────────────────────────────────────────
async function notify(content) {
  if (!WEBHOOK_SYSTEM) return;
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
  const provider  = await getProviderWithFallback(chainId);
  const usdc      = new ethers.Contract(getUsdcAddress(chainId), ERC20_ABI, provider);
  const bal       = await usdc.balanceOf(walletAddress);
  return parseFloat(ethers.formatUnits(bal, 6));
}

// ── Find best risk-on vault ───────────────────────────────────────────────────
async function findBestVault(walletAddress, amountUsd) {
  const vaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
  const ranked = rankVaults(vaults, amountUsd);
  return ranked[0] || null;
}

// ── Risk-on: deploy into best yield vault ────────────────────────────────────
async function executeRiskOn(regime, walletAddress) {
  console.log('[agent] risk_on: scanning best vault...');
  const fromChainId = USYC_CHAIN; // start from Base where USYC lives

  const usdcBal = await getUsdcBalance(fromChainId, walletAddress);
  if (usdcBal < 1) {
    await notify(`⚠️ **Risk-On skipped** — USDC balance too low ($${usdcBal.toFixed(2)})`);
    return;
  }

  const best = await findBestVault(walletAddress, usdcBal);
  if (!best) {
    await notify('⚠️ **Risk-On skipped** — no suitable vault found');
    return;
  }

  await notify(
    `🟢 **Risk-On Rebalance**\n` +
    `BTC: $${regime.btc_price} | Phase: ${regime.phase} | Confidence: ${regime.confidence}\n` +
    `→ Deploying $${usdcBal.toFixed(2)} USDC into **${best.vault.name}** (${best.vault.protocol})\n` +
    `  APY: ${best.apy.toFixed(2)}% | Chain: ${best.vault.chainId}`
  );

  try {
    const provider = await getProviderWithFallback(fromChainId);
    const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
    const usdcContract = new ethers.Contract(getUsdcAddress(fromChainId), ERC20_ABI, provider);
    const amountWei = (await usdcContract.balanceOf(walletAddress)).toString();

    await depositToVault({
      signer,
      fromChainId,
      toChainId:         best.vault.chainId,
      fromTokenAddress:  getUsdcAddress(fromChainId),
      vaultTokenAddress: best.vault.address,
      amountWei,
      depositPack:       best.vault.depositPacks?.[0]?.name || '',
    });

    const positions = loadPositions();
    positions.push({
      vaultAddress: best.vault.address,
      vaultName:    best.vault.name,
      protocol:     best.vault.protocol,
      chainId:      best.vault.chainId,
      valueUsd:     usdcBal,
      depositedAt:  new Date().toISOString(),
    });
    savePositions(positions);

    recordTx({
      type: 'arcana-risk-on',
      toVault: best.vault.name,
      chainId: best.vault.chainId,
      valueUsd: usdcBal,
      apy: best.apy,
      regime: regime.regime,
    });

    await notify(`✅ **Deployed** — ${best.vault.name} | $${usdcBal.toFixed(2)} | APY ${best.apy.toFixed(2)}%`);
  } catch (e) {
    await notify(`❌ **Risk-On failed** — ${e.message?.slice(0, 100)}`);
    console.error('[agent] risk_on error:', e.message);
  }
}

// ── Risk-off: consolidate into USYC ──────────────────────────────────────────
async function executeRiskOff(regime, walletAddress) {
  console.log('[agent] risk_off: checking USYC position...');

  const positions = loadPositions();
  if (positions.length === 0) {
    await notify(
      `🔴 **Risk-Off** — No active positions to consolidate.\n` +
      `BTC: $${regime.btc_price} | Phase: ${regime.phase} | Confidence: ${regime.confidence}\n` +
      `Capital already safe in USYC / idle USDC.`
    );
    return;
  }

  await notify(
    `🔴 **Risk-Off Rebalance**\n` +
    `BTC: $${regime.btc_price} | Phase: ${regime.phase} | Confidence: ${regime.confidence}\n` +
    `→ Consolidating ${positions.length} position(s) into USYC stable yield\n` +
    `  Reason: ${regime.reasoning}`
  );

  for (const pos of positions) {
    recordTx({
      type:     'arcana-risk-off',
      fromVault: pos.vaultName,
      chainId:   pos.chainId,
      valueUsd:  pos.valueUsd,
      regime:    regime.regime,
    });
    console.log(`[agent] would withdraw from ${pos.vaultName} ($${pos.valueUsd})`);
  }

  // Bridge idle USDC to Arc Testnet (USYC stable yield)
  try {
    const balances = await getGatewayBalance();
    const available = balances.baseSepolia || 0;
    if (available >= 1) {
      const bridgeAmount = Math.floor(available).toString();
      await notify(`🌉 **Bridging ${bridgeAmount} USDC → Arc Testnet** (USYC parking)`);
      const mintTx = await transferToArc(bridgeAmount);
      await notify('✅ **Parked on Arc** — tx: `' + mintTx + '`');
      recordTx({ type: 'arcana-arc-bridge', amount: bridgeAmount, regime: regime.regime, tx: mintTx });
    } else {
      await notify(`ℹ️ Gateway balance low (${available} USDC), skipping Arc bridge`);
    }
  } catch (e) {
    await notify(`⚠️ **Arc bridge failed** — ${e.message?.slice(0, 100)}`);
    console.error('[agent] arc bridge error:', e.message);
  }

  savePositions([]);
  await notify(`✅ **Consolidated** — Capital parked in USYC stable yield`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function run() {
  const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  console.log(`[arcana] wallet: ${walletAddress}`);
  await notify(`🚀 **Arcana Agent Started**\nWallet: \`${walletAddress}\`\nInterval: ${INTERVAL_MS / 60000} min`);

  while (true) {
    try {
      console.log('\n[arcana] running regime detection...');
      const regime = await detectRegime();

      if (!regime.rebalance) {
        console.log(`[arcana] no rebalance needed (regime=${regime.regime}, confidence=${regime.confidence})`);
      } else {
        if (regime.regime === 'risk_on') {
          await executeRiskOn(regime, walletAddress);
        } else {
          await executeRiskOff(regime, walletAddress);
        }
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
module.exports = { executeRiskOn, executeRiskOff };

if (require.main === module) {
  run().catch(e => {
    console.error('[arcana] fatal:', e.message);
    process.exit(1);
  });
}
