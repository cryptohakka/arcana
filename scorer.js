// Vaulthoric — Vault Scoring Engine
// Risk-adjusted scoring formula:
//   score = net_apy * stability * (1 + tvl_bonus) * trust * penalty
//
// APY values from the LI.FI API are already in percent (e.g. 5.34 = 5.34%).
// net_apy = (gross_yield - gas_cost) / deposit_amount * 100

const MIN_TVL_USD = 1_000_000;
const MIN_APY     = 0.1;
const MAX_APY     = 100; // Filter out abnormal outliers above 100%

// Protocol trust multipliers (covers all 11 LI.FI Earn protocols)
const PROTOCOL_TRUST = {
  'aave-v3':         1.3,
  'morpho-v1':       1.25,
  'euler-v2':        1.2,
  'ether.fi-liquid': 1.15,
  'ether.fi-stake':  1.15,
  'pendle':          1.15,
  'ethena-usde':     1.1,
  'maple':           1.05,
  'upshift':         1.0,
  'yo-protocol':     0.9,
  'neverland':       0.9,
};

// Estimated vault deposit gas cost per chain (USD)
const GAS_COST_USD = {
  1:      0.5,   // Ethereum
  10:     0.01,  // Optimism
  56:     0.01,  // BSC
  100:    0.01,  // Gnosis
  130:    0.01,  // Unichain
  137:    0.01,  // Polygon
  143:    0.01,  // Monad
  146:    0.01,  // Sonic
  5000:   0.01,  // Mantle
  8453:   0.01,  // Base
  42161:  0.01,  // Arbitrum
  42220:  0.01,  // Celo
  43114:  0.01,  // Avalanche
  59144:  0.01,  // Linea
  80094:  0.01,  // Berachain
  534352: 0.01,  // Scroll
  747474: 0.01,  // Katana
};

// Estimated bridge cost (USD), added when source and destination chains differ
const BRIDGE_COST_USD = 0.01;

// ─── Scoring Components ───────────────────────────────────────────────────────

// APY stability score based on coefficient of variation across time windows (0–1).
function apyStability(vault) {
  const { apy, apy1d, apy7d, apy30d } = vault.analytics;
  const current = apy.total;
  const values  = [current, apy1d, apy7d, apy30d].filter(v => v != null && v > 0);
  if (values.length < 2) return 0.5;
  const mean     = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  const cv       = mean > 0 ? Math.sqrt(variance) / mean : 1;
  return Math.max(0, 1 - cv);
}

// TVL bonus on a log10 scale (0 at MIN_TVL_USD, grows slowly above it).
function tvlBonus(vault) {
  const tvlUsd = parseFloat(vault.analytics.tvl.usd);
  if (tvlUsd < MIN_TVL_USD) return 0;
  return Math.log10(tvlUsd / MIN_TVL_USD + 1);
}

// Penalty multiplier for KYC requirements or long time-locks.
function penalties(vault) {
  let penalty = 1.0;
  if (vault.kyc)             penalty *= 0.5;
  if (vault.timeLock > 86400) penalty *= 0.8;
  return penalty;
}

// ─── Main Scorer ──────────────────────────────────────────────────────────────

function scoreVault(vault, amountUsd = 1000, fromChainId = null) {
  const apy = vault.analytics.apy.total;
  if (!apy || apy < MIN_APY || apy > MAX_APY) return null;

  // Only include vaults that support both deposit and redeem via LI.FI.
  if (!vault.isTransactional)                      return null;
  if (!vault.isRedeemable)                         return null;
  if (!vault.redeemPacks  || vault.redeemPacks.length  === 0) return null;
  if (!vault.depositPacks || vault.depositPacks.length === 0) return null;

  const stability = apyStability(vault);
  const tvl       = tvlBonus(vault);
  const penalty   = penalties(vault);
  const trust     = PROTOCOL_TRUST[vault.protocol.name] || 1.0;

  const chainGas     = GAS_COST_USD[vault.chainId] || 0.5;
  const needsBridge  = fromChainId && fromChainId !== vault.chainId;
  const totalGasCost = chainGas + (needsBridge ? BRIDGE_COST_USD : 0);

  const grossYield = amountUsd * (apy / 100);
  const netYield   = grossYield - totalGasCost;
  const netApy     = (netYield / amountUsd) * 100;

  const score = netApy * stability * (1 + tvl * 0.2) * trust * penalty;

  return {
    score:         parseFloat(score.toFixed(4)),
    apy:           parseFloat(apy.toFixed(2)),
    netApy:        parseFloat(netApy.toFixed(2)),
    stability:     parseFloat(stability.toFixed(3)),
    tvlUsd:        parseFloat(vault.analytics.tvl.usd),
    penalty:       parseFloat(penalty.toFixed(2)),
    trust,
    totalGasCost:  parseFloat(totalGasCost.toFixed(3)),
    grossYield:    parseFloat(grossYield.toFixed(2)),
    netYield:      parseFloat(netYield.toFixed(2)),
    vault: {
      address:          vault.address,
      chainId:          vault.chainId,
      name:             vault.name,
      protocol:         vault.protocol.name,
      network:          vault.network,
      slug:             vault.slug,
      underlyingTokens: vault.underlyingTokens,
      depositPacks:     vault.depositPacks,
      redeemPacks:      vault.redeemPacks,
    },
  };
}

// Score and sort an array of vaults, discarding null scores and negative net APY.
function rankVaults(vaults, amountUsd = 1000, fromChainId = null) {
  return vaults
    .map(v => scoreVault(v, amountUsd, fromChainId))
    .filter(v => v !== null && v.netApy > 0)
    .sort((a, b) => b.score - a.score);
}

// Return top-N vaults grouped by underlying asset symbol.
function topVaultsByAsset(vaults, topN = 3, amountUsd = 1000, fromChainId = null) {
  const ranked  = rankVaults(vaults, amountUsd, fromChainId);
  const byAsset = {};
  for (const result of ranked) {
    const symbols = result.vault.underlyingTokens.map(t => t.symbol).join('+');
    if (!byAsset[symbols]) byAsset[symbols] = [];
    if (byAsset[symbols].length < topN) byAsset[symbols].push(result);
  }
  return byAsset;
}

module.exports = { scoreVault, rankVaults, topVaultsByAsset, PROTOCOL_TRUST, GAS_COST_USD, BRIDGE_COST_USD };
