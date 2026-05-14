// Vaulthoric — LI.FI Composer Integration
// Handles quote fetching, allowance management, transaction submission,
// cross-chain status polling, and vault deposit routing.

const axios   = require('axios');
const { ethers } = require('ethers');
const {
  ERC20_ABI,
  ERC4626_ABI,
  AAVE_POOL_ABI,
  AAVE_POOLS,
  USDC_ADDRESSES,
  getProviderWithFallback,
} = require('./tools');

const LIFI_BASE = 'https://li.quest';
const API_KEY   = process.env.LIFI_API_KEY || '';
const HEADERS   = API_KEY ? { 'Content-Type': 'application/json', 'x-lifi-api-key': API_KEY }
                          : { 'Content-Type': 'application/json' };

// If LI.FI gas estimate exceeds this threshold (USD), fall back to direct deposit.
const GAS_FALLBACK_THRESHOLD_USD = 0.05;

// ─── Quote ───────────────────────────────────────────────────────────────────

async function getQuote({ fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, slippage = '0.005' }) {
  const params = new URLSearchParams({
    fromChain,
    toChain,
    fromToken,
    toToken,
    fromAmount: fromAmount.toString(),
    fromAddress,
    toAddress: fromAddress,
    slippage,
  });
  const res = await axios.get(`${LIFI_BASE}/v1/quote?${params}`, { headers: HEADERS });
  return res.data;
}

// ─── Allowance ────────────────────────────────────────────────────────────────

async function ensureAllowance(signer, tokenAddress, spender, amount) {
  if (tokenAddress === ethers.ZeroAddress) return;
  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const current = await erc20.allowance(owner, spender);
  if (current < BigInt(amount)) {
    console.log(`🔓 Approving ${spender}...`);
    const tx = await erc20.approve(spender, amount);
    await tx.wait();
    console.log('✅ Approval confirmed');
  } else {
    console.log('✅ Allowance sufficient');
  }
}

// ─── Transaction ──────────────────────────────────────────────────────────────

async function sendTx(signer, transactionRequest) {
  console.log('📤 Sending transaction...');

  // EIP-1559: gasPrice and maxFeePerGas cannot coexist.
  delete transactionRequest.gasPrice;

  // Always overwrite fee fields with current network values + 20% buffer.
  const feeData = await signer.provider.getFeeData();
  if (feeData.maxFeePerGas) {
    transactionRequest.maxFeePerGas = (feeData.maxFeePerGas * 120n / 100n).toString();
    transactionRequest.maxPriorityFeePerGas = (
      feeData.maxPriorityFeePerGas ?? feeData.maxFeePerGas / 10n
    ).toString();
    console.log(`⚡ Gas: current fee +20% → ${transactionRequest.maxFeePerGas}`);
  }

  try {
    const estimated = await signer.estimateGas(transactionRequest);
    transactionRequest.gasLimit = (estimated * 120n / 100n).toString();
    console.log(`⚡ gasLimit: ${estimated} → ${transactionRequest.gasLimit}`);
  } catch (e) {
    console.log(`  ⚠️  estimateGas failed, using LI.FI value: ${transactionRequest.gasLimit}`);
  }

  const tx = await signer.sendTransaction(transactionRequest);
  console.log(`🔗 Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
  return tx;
}

// ─── Status Polling ───────────────────────────────────────────────────────────

async function pollStatus(txHash, fromChain, toChain, intervalMs = 5000) {
  if (fromChain === toChain) return { status: 'DONE' };
  console.log('⏳ Polling cross-chain status...');
  let status;
  do {
    const res = await axios.get(`${LIFI_BASE}/v1/status`, {
      params: { txHash, fromChain, toChain },
      headers: HEADERS,
    });
    status = res.data;
    console.log(`📊 Status: ${status.status}${status.substatus ? ` (${status.substatus})` : ''}`);
    if (status.status !== 'DONE' && status.status !== 'FAILED') {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  } while (status.status !== 'DONE' && status.status !== 'FAILED');
  return status;
}

// ─── Direct Deposit Strategies ───────────────────────────────────────────────

async function _depositAave(signer, fromTokenAddress, toChainId, amountWei) {
  const fromAddress = await signer.getAddress();
  const poolAddress = AAVE_POOLS[toChainId];
  console.log('\n🏦 Depositing to Aave directly...');
  await ensureAllowance(signer, fromTokenAddress, poolAddress, amountWei);
  const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, signer);
  const tx = await pool.supply(fromTokenAddress, amountWei, fromAddress, 0);
  console.log(`🔗 Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
  return { tx, finalStatus: { status: 'DONE' } };
}

async function _depositERC4626(signer, fromTokenAddress, vaultTokenAddress, amountWei) {
  const fromAddress = await signer.getAddress();
  console.log('\n🔷 Depositing to ERC-4626 vault directly...');
  await ensureAllowance(signer, fromTokenAddress, vaultTokenAddress, amountWei);
  const vault = new ethers.Contract(vaultTokenAddress, ERC4626_ABI, signer);
  const tx = await vault.deposit(amountWei, fromAddress);
  console.log(`🔗 Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
  return { tx, finalStatus: { status: 'DONE' } };
}

// ─── PARTIAL Recovery ─────────────────────────────────────────────────────────

// Bridge succeeded but vault deposit incomplete — check destination USDC balance
// and attempt a direct deposit.
async function _recoverPartial({ fromAddress, toChainId, vaultTokenAddress, pack }) {
  const toUsdcAddress = USDC_ADDRESSES[toChainId];
  if (!toUsdcAddress) {
    console.log('  ⚠️  No USDC address for recovery, skipping');
    return null;
  }

  console.log('\n🔄 PARTIAL detected — checking USDC balance on destination chain...');
  await new Promise(r => setTimeout(r, 5000));

  const toProvider = await getProviderWithFallback(toChainId);
  const toSigner   = new ethers.Wallet(process.env.PRIVATE_KEY, toProvider);
  const erc20      = new ethers.Contract(toUsdcAddress, ERC20_ABI, toProvider);
  const bal        = await erc20.balanceOf(fromAddress);

  if (bal === 0n) {
    console.log('  ⚠️  No USDC found on destination chain yet, manual deposit needed');
    return null;
  }

  console.log(`  Found ${ethers.formatUnits(bal, 6)} USDC — proceeding with direct deposit`);

  if (pack === 'aave-zaps' && AAVE_POOLS[toChainId]) {
    return await _depositAave(toSigner, toUsdcAddress, toChainId, bal);
  }
  if (pack === 'morpho-zaps') {
    return await _depositERC4626(toSigner, toUsdcAddress, vaultTokenAddress, bal);
  }
  console.log(`  ⚠️  No direct deposit support for pack="${pack}"`);
  return null;
}

// ─── Cross-Chain 2-Step Fallback ──────────────────────────────────────────────

// LI.FI bridge only → then direct deposit on destination chain.
async function _depositCrossChain2Step({ signer, fromChainId, toChainId, fromTokenAddress, vaultTokenAddress, amountWei, pack }) {
  const fromAddress   = await signer.getAddress();
  const toUsdcAddress = USDC_ADDRESSES[toChainId];
  if (!toUsdcAddress) throw new Error(`No USDC address for chainId ${toChainId}`);

  console.log(`\n🌉 Step 1: Bridging USDC ${fromChainId} → ${toChainId}...`);
  const bridgeQuote = await getQuote({
    fromChain: fromChainId,
    toChain:   toChainId,
    fromToken: fromTokenAddress,
    toToken:   toUsdcAddress,
    fromAmount: amountWei,
    fromAddress,
  });

  const bridgeGasUsd  = parseFloat(bridgeQuote.estimate?.gasCosts?.[0]?.amountUSD || '0');
  const bridgedAmount = bridgeQuote.estimate?.toAmount || amountWei;
  console.log(`  Bridge gas: $${bridgeGasUsd} | Est. received: ${ethers.formatUnits(bridgedAmount, 6)} USDC`);

  await ensureAllowance(
    signer,
    bridgeQuote.action.fromToken.address,
    bridgeQuote.estimate.approvalAddress,
    bridgeQuote.action.fromAmount,
  );

  const bridgeTx     = await sendTx(signer, bridgeQuote.transactionRequest);
  const bridgeStatus = await pollStatus(bridgeTx.hash, fromChainId, toChainId);
  if (bridgeStatus.status === 'FAILED') throw new Error('Bridge failed');
  console.log('✅ Bridge complete');

  console.log(`\n🏦 Step 2: Depositing to vault on chain ${toChainId}...`);
  const toProvider = await getProviderWithFallback(toChainId);
  const toSigner   = new ethers.Wallet(process.env.PRIVATE_KEY, toProvider);

  // Use actual arrived balance instead of bridge estimate
  const usdcErc20     = new ethers.Contract(toUsdcAddress, ERC20_ABI, toProvider);
  const actualBalance = await usdcErc20.balanceOf(fromAddress);
  console.log(`  Actual USDC on chain ${toChainId}: ${ethers.formatUnits(actualBalance, 6)}`);
  if (actualBalance === 0n) throw new Error('No USDC arrived on destination chain');

  if (pack === 'aave-zaps' && AAVE_POOLS[toChainId]) {
    return await _depositAave(toSigner, toUsdcAddress, toChainId, actualBalance);
  }
  if (pack === 'morpho-zaps') {
    return await _depositERC4626(toSigner, toUsdcAddress, vaultTokenAddress, actualBalance);
  }
  throw new Error(`No direct deposit support for pack="${pack}" on cross-chain fallback`);
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────
// Routing priority:
//   1. Known packs (morpho-zaps, aave-zaps, neverland-zaps) → always direct deposit
//      This avoids LI.FI routing vault share tokens through DEX swaps.
//   2. Cross-chain → LI.FI bridge to USDC on destination, then direct deposit
//   3. Unknown pack, same-chain → LI.FI quote with 0.5% slippage guard

async function depositToVault({ signer, fromChainId, toChainId, fromTokenAddress, vaultTokenAddress, amountWei, depositPack }) {
  const fromAddress = await signer.getAddress();
  const isSameChain = fromChainId === toChainId;
  const pack        = depositPack || '';

  console.log(`\n🏦 Depositing to vault...`);
  console.log(`  From: chain=${fromChainId} token=${fromTokenAddress}`);
  console.log(`  To:   chain=${toChainId} vault=${vaultTokenAddress}`);
  console.log(`  Pack: ${pack || '(unknown)'} | Amount: ${amountWei}`);

  // ── Priority 1: Known packs → direct deposit (never use LI.FI for vault tokens) ──
  if (isSameChain) {
    if ((pack === 'aave-zaps' || pack === 'neverland-zaps') && AAVE_POOLS[toChainId]) {
      return await _depositAave(signer, fromTokenAddress, toChainId, amountWei);
    }
    if (pack === 'morpho-zaps') {
      return await _depositERC4626(signer, fromTokenAddress, vaultTokenAddress, amountWei);
    }
  }

  // ── Priority 2: Cross-chain → LI.FI bridge to USDC, then direct deposit ──
  if (!isSameChain) {
    if (pack === 'aave-zaps' || pack === 'neverland-zaps' || pack === 'morpho-zaps') {
      console.log(`\n🔀 Cross-chain: bridge → direct deposit`);
      return await _depositCrossChain2Step({
        signer, fromChainId, toChainId, fromTokenAddress,
        vaultTokenAddress, amountWei, pack,
      });
    }
  }

  // ── Priority 3: Unknown pack → LI.FI Composer with slippage guard ──
  console.log(`\n🔍 Getting LI.FI quote (slippage: 0.5%)...`);
  let quote       = null;
  let quoteGasUsd = null;

  try {
    quote = await getQuote({
      fromChain:  fromChainId,
      toChain:    toChainId,
      fromToken:  fromTokenAddress,
      toToken:    vaultTokenAddress,
      fromAmount: amountWei,
      fromAddress,
      slippage:   '0.005',
    });
    quoteGasUsd = parseFloat(quote.estimate?.gasCosts?.[0]?.amountUSD || '0');
    console.log(`\n💡 Quote received:`);
    console.log(`  Est. output: ${quote.estimate?.toAmount} ${quote.action?.toToken?.symbol}`);
    console.log(`  Gas est: $${quoteGasUsd}`);
  } catch (e) {
    console.log(`  ⚠️  LI.FI quote failed: ${e.message}`);
  }

  if (!quote) {
    throw new Error(`LI.FI quote unavailable for pack="${pack}" and no direct deposit fallback`);
  }

  await ensureAllowance(
    signer,
    quote.action.fromToken.address,
    quote.estimate.approvalAddress,
    quote.action.fromAmount,
  );

  const tx          = await sendTx(signer, quote.transactionRequest);
  const finalStatus = await pollStatus(tx.hash, fromChainId, toChainId);
  console.log(`\n🏁 Final status: ${finalStatus.status}`);

  if (finalStatus.status === 'DONE' && finalStatus.substatus === 'PARTIAL') {
    console.log('\n⚠️  Bridge succeeded but vault deposit incomplete — attempting recovery...');
    const recovered = await _recoverPartial({ fromAddress, toChainId, vaultTokenAddress, pack });
    if (recovered) return recovered;
  }

  return { tx, quote, finalStatus };
}

// ─── Token Balance ────────────────────────────────────────────────────────────

async function getTokenBalance(provider, tokenAddress, walletAddress) {
  if (tokenAddress === ethers.ZeroAddress) {
    const balance = await provider.getBalance(walletAddress);
    return { balance, symbol: 'ETH', decimals: 18 };
  }
  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const balance = await erc20.balanceOf(walletAddress);
  let symbol = 'USDC', decimals = 6;
  try {
    [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  } catch {}
  return { balance, symbol, decimals };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { getQuote, ensureAllowance, sendTx, pollStatus, depositToVault, getTokenBalance };
