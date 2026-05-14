// Vaulthoric — Rebalance
// Withdraws from a current vault position and re-deposits into the best
// available vault, optionally on a different chain.

require('dotenv').config();

const readline = require('readline');
const AUTO_MODE = process.argv.includes('--auto');
const { ethers } = require('ethers');
const { getVaults }  = require('./earn');
const { rankVaults } = require('./scorer');
const {
  getChainName,
  getUsdcAddress,
  getProviderWithFallback,
  suppressRpcNoise,
  recordTx,
} = require('./tools');
const { scanPositions, withdrawAll } = require('./withdraw');

suppressRpcNoise();

function prompt(rl, q) {
  if (AUTO_MODE) {
    // position selection prompts need '1', confirmation prompts need 'y'
    const isSelection = /number|select.*position|select.*target/i.test(q);
    const ans = isSelection ? '1' : 'y';
    console.log(q + ans + ' (auto)');
    return Promise.resolve(ans);
  }
  return new Promise(r => rl.question(q, r));
}

// ─── Instruction Parser ──────────────────────────────────────────────────────

async function parseRebalanceInstruction(instruction) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';
  if (!OPENROUTER_API_KEY || !instruction) return null;

  const axios = require('axios');
  const res   = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model:      OPENROUTER_MODEL,
      max_tokens: 100,
      messages: [
        {
          role:    'system',
          content: `Extract rebalance parameters from the instruction. Return JSON only, no explanation:
{"from": "VAULT_NAME", "to": "VAULT_NAME_or_mode"}

Rules for "from" field:
- Use the source vault name if explicitly mentioned (e.g. "BBQUSDC to safest")
- If no specific source vault is mentioned, use null

Rules for "to" field:
- If destination is a specific vault name or address, use it as-is
- If destination means best risk-adjusted / optimal / balanced → use "best"
- If destination means safest / lowest risk / most stable → use "safest"
- If destination means highest yield / highest APY / most aggressive → use "highest"
- If only a mode word appears with no source vault, "from" is null

Examples:
"CSUSDC to STEAKUSDC" -> {"from":"CSUSDC","to":"STEAKUSDC"}
"BBQUSDC to best" -> {"from":"BBQUSDC","to":"best"}
"BBQUSDC to safest" -> {"from":"BBQUSDC","to":"safest"}
"safest" -> {"from":null,"to":"safest"}
"highest" -> {"from":null,"to":"highest"}
"best" -> {"from":null,"to":"best"}
"USDC to highest yield" -> {"from":"USDC","to":"highest"}
"BBQUSDC to 0x1234..." -> {"from":"BBQUSDC","to":"0x1234..."}`,
        },
        { role: 'user', content: instruction },
      ],
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://vaulthoric.xyz',
        'X-Title':       'Vaulthoric Rebalance',
      },
    }
  );
  const raw = res.data.choices[0].message.content.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ─── Find Better Vault ────────────────────────────────────────────────────────

// scope:
//   'same'  — same-chain only (--auto)
//   'all'   — all chains (address specified)
//   'both'  — same-chain best + cross-chain best (mode specified, interactive)
async function findBetterVault(position, valueUsd, mode = 'best', scope = 'same') {
  const allVaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });

  function sortByMode(ranked) {
    if (mode === 'safest')  return [...ranked].sort((a, b) => (b.stability * b.trust) - (a.stability * a.trust));
    if (mode === 'highest') return [...ranked].sort((a, b) => b.apy - a.apy);
    return ranked; // 'best': risk-adjusted score
  }

  function excludeCurrent(ranked) {
    return ranked.filter(v => v.vault.address.toLowerCase() !== position.vaultAddress.toLowerCase());
  }

  if (scope === 'all') {
    const sameChain  = allVaults.filter(v => v.chainId === position.chainId);
    const crossChain = allVaults.filter(v => v.chainId !== position.chainId);
    const rankedSame  = sortByMode(rankVaults(sameChain,  valueUsd, position.chainId));
    const rankedCross = sortByMode(rankVaults(crossChain, valueUsd, position.chainId));
    const current   = rankedSame.find(v => v.vault.address.toLowerCase() === position.vaultAddress.toLowerCase());
    const bestSame  = excludeCurrent(rankedSame)[0]  || null;
    const bestCross = rankedCross[0] || null;
    return { current, bestSame, bestCross, ranked: rankedSame };
  }

  if (scope === 'both') {
    const sameChain  = allVaults.filter(v => v.chainId === position.chainId);
    const crossChain = allVaults.filter(v => v.chainId !== position.chainId);
    const rankedSame  = sortByMode(rankVaults(sameChain,  valueUsd, position.chainId));
    const rankedCross = sortByMode(rankVaults(crossChain, valueUsd, position.chainId));
    const current   = rankedSame.find(v => v.vault.address.toLowerCase() === position.vaultAddress.toLowerCase());
    const bestSame  = excludeCurrent(rankedSame)[0]  || null;
    const bestCross = rankedCross[0] || null;
    return { current, bestSame, bestCross, ranked: rankedSame };
  }

  // scope === 'same'
  const ranked  = sortByMode(rankVaults(allVaults.filter(v => v.chainId === position.chainId), valueUsd, position.chainId));
  const current = ranked.find(v => v.vault.address.toLowerCase() === position.vaultAddress.toLowerCase());
  const best    = excludeCurrent(ranked)[0] || null;
  return { current, bestSame: best, bestCross: null, ranked };
}

// ─── Wait for USDC ────────────────────────────────────────────────────────────

async function waitForUsdc(chainId, walletAddress, expectedMin, maxWaitMs = 30000) {
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
  const usdcAddr  = getUsdcAddress(chainId);
  const provider  = await getProviderWithFallback(chainId);
  const token     = new ethers.Contract(usdcAddr, ERC20_ABI, provider);

  console.log(`\n⏳ Waiting for USDC to arrive on ${getChainName(chainId)}...`);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const bal = await token.balanceOf(walletAddress);
    const usd = parseFloat(ethers.formatUnits(bal, 6));
    if (usd >= expectedMin * 0.95) {
      console.log(`  💰 ${usd.toFixed(4)} USDC available`);
      return usd;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('USDC did not arrive in time — withdraw may still be pending');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const MODES = ['best', 'safest', 'highest'];

async function main() {
  const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const isAuto         = process.argv.includes('--auto');
  const rawInstruction = process.argv[2] || null;
  // Extract scope: before passing to LLM
  const scopeMatch = rawInstruction?.match(/\bscope:(same|all|both)\b/i);
  const autoScope  = scopeMatch ? scopeMatch[1].toLowerCase() : null;
  const instruction = rawInstruction?.replace(/\bscope:\S+\s*/gi, '').replace(/\bmode\b\s*/gi, '').trim() || null;
  let autoFrom = null;
  let autoTo   = null;

  if (instruction) {
    console.log(`\n📝 Instruction: "${rawInstruction}"`);
    console.log('🧠 Parsing...');
    try {
      const parsed = await parseRebalanceInstruction(instruction);
      autoFrom = parsed?.from || null;
      autoTo   = parsed?.to   || null;
      console.log(`  From: ${autoFrom || 'auto'} | To: ${autoTo || 'best'}${autoScope ? ' | Scope: '+autoScope : ''}`);
    } catch {
      console.log('  ⚠️  Could not parse instruction, switching to interactive mode');
    }
  }

  console.log(`\n🏦 Vaulthoric — Rebalance`);
  console.log(`👛 Wallet: ${walletAddress}`);
  console.log(`${'─'.repeat(50)}`);

  // Step 1: Scan positions
  const positions = await scanPositions(walletAddress);
  if (positions.length === 0) {
    console.log('\n❌ No vault positions found.');
    rl.close(); return;
  }

  const allVaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });

  // Enrich with current APY
  const enriched = positions.map(p => {
    const ranked  = rankVaults(allVaults.filter(v => v.chainId === p.chainId), p.valueUsd, p.chainId);
    const current = ranked.find(v => v.vault.address.toLowerCase() === p.vaultAddress.toLowerCase());
    return { ...p, currentApy: current?.apy || null, ranked, current };
  });

  // Auto-select from position if instruction provided
  let position;
  if (autoFrom) {
    const match = enriched.find(p => p.vaultName.toLowerCase().includes(autoFrom.toLowerCase()));
    if (match) {
      position = match;
      console.log(`\n✅ Auto-selected: ${position.vaultName} ($${position.valueUsd.toFixed(2)}, APY: ${position.currentApy?.toFixed(2)}%)`);
    }
  }

  if (!position) {
    console.log(`\n📊 Your Vault Positions:`);
    enriched.forEach((p, i) => {
      const apy = p.currentApy ? `${p.currentApy.toFixed(2)}%` : 'N/A';
      console.log(`  ${i + 1}. ${p.vaultName.padEnd(12)} (${p.protocol}) | $${p.valueUsd.toFixed(2)} | APY: ${apy} | ${getChainName(p.chainId)}`);
    });

    const pick = await prompt(rl, '\nSelect position to rebalance (number) or q to quit: ');
    if (pick.toLowerCase() === 'q') { rl.close(); return; }

    const idx = parseInt(pick) - 1;
    if (isNaN(idx) || idx < 0 || idx >= enriched.length) {
      console.log('❌ Invalid selection.'); rl.close(); return;
    }
    position = enriched[idx];
  }

  // Determine mode and scope
  const isSpecificTarget = autoTo && !MODES.includes(autoTo);
  const isModeTarget     = autoTo && MODES.includes(autoTo);
  const mode  = isModeTarget ? autoTo : 'best';
  const scope = autoScope || (isAuto ? 'same' : isSpecificTarget ? 'all' : isModeTarget ? 'both' : 'same');

  // Step 2: Find better vault
  const modeLabel = mode === 'safest' ? '🛡️  Safest' : mode === 'highest' ? '🚀 Highest yield' : '⚖️  Best risk-adjusted';
  console.log(`\n🔍 Finding better vault for ${position.vaultName} (mode: ${mode})...`);
  const { current, bestSame, bestCross, ranked } = await findBetterVault(position, position.valueUsd, mode, scope);

  // Resolve target vault
  let best = bestSame;

  if (isSpecificTarget) {
    // アドレスまたは名前で指定されたvaultを全チェーンから探す
    const isAddress = autoTo.startsWith('0x') && autoTo.length >= 10;
    const specified = isAddress
      ? ranked.find(v => v.vault.address.toLowerCase() === autoTo.toLowerCase())
      : ranked.find(v => v.vault.name.toLowerCase().includes(autoTo.toLowerCase()));

    if (specified) {
      best = specified;
      console.log(`  Using specified vault: ${best.vault.name} (${best.vault.address.slice(0,6)}…${best.vault.address.slice(-4)}) on ${getChainName(best.vault.chainId)}`);
    } else {
      console.log(`  ⚠️  "${autoTo}" not found, using best available`);
    }

  } else if (bestCross && (autoScope === 'all' || (isModeTarget && !isAuto))) {
    // scope:all or mode指定 — same/cross候補を比較
    if (isAuto) {
      // auto: APYが高い方を自動選択
      const sameBetter = bestSame && bestSame.apy > bestCross.apy;
      best = sameBetter ? bestSame : bestCross;
      console.log(`  Auto-selected: ${best.vault.name} on ${getChainName(best.vault.chainId)} (APY: ${best.apy.toFixed(2)}%)`);
    } else {
      console.log(`\n${modeLabel} candidates:`);
      if (bestSame) {
        console.log(`  1. [Same-chain ] ${bestSame.vault.name.padEnd(14)} (${bestSame.vault.protocol}) | APY: ${bestSame.apy.toFixed(2)}% | ${getChainName(bestSame.vault.chainId)}`);
      } else {
        console.log(`  1. [Same-chain ] No better vault on same chain`);
      }
      console.log(`  2. [Cross-chain] ${bestCross.vault.name.padEnd(14)} (${bestCross.vault.protocol}) | APY: ${bestCross.apy.toFixed(2)}% | ${getChainName(bestCross.vault.chainId)}`);
      const pick = await prompt(rl, '\nSelect target (1/2) or q to quit: ');
      if (pick.toLowerCase() === 'q') { rl.close(); return; }
      best = pick === '2' ? bestCross : (bestSame || bestCross);
    }
  }

  if (!best) {
    console.log(`✅ No better vault found. ${position.vaultName} is already optimal on ${getChainName(position.chainId)}.`);
    rl.close(); return;
  }

  const improvement  = best.apy - (current?.apy || 0);
  const isCrossChain = best.vault.chainId !== position.chainId;

  if ((!autoTo || MODES.includes(autoTo)) && improvement < 0.1) {
    console.log(`✅ ${position.vaultName} is already the best vault on ${getChainName(position.chainId)} (APY: ${current?.apy.toFixed(2)}%).`);
    rl.close(); return;
  }

  console.log(`\n📋 Rebalance Plan:`);
  console.log(`  Mode : ${modeLabel}`);
  console.log(`  From : ${position.vaultName} (${position.protocol}) — APY: ${current?.apy?.toFixed(2) || 'N/A'}% | ${getChainName(position.chainId)}`);
  console.log(`  To   : ${best.vault.name} (${best.vault.protocol}) — APY: ${best.apy.toFixed(2)}% | ${getChainName(best.vault.chainId)}${isCrossChain ? ' ⚠️  Cross-chain' : ''}`);
  console.log(`  Gain : +${improvement.toFixed(2)}% APY`);
  console.log(`  Value: ~$${position.valueUsd.toFixed(2)}`);

  if (!isAuto) {
    const confirm = await prompt(rl, '\n✅ Proceed with rebalance? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('\n❌ Cancelled.'); rl.close(); return;
    }
  } else {
    console.log('\n🤖 Auto-rebalance: proceeding automatically...');
  }

  // Step 3: Withdraw
  console.log(`\n🔄 Step 1: Withdrawing from ${position.vaultName}...`);
  await withdrawAll(position, { skipRecord: true });

  // Step 4: Wait for USDC on source chain
  await waitForUsdc(position.chainId, walletAddress, position.valueUsd * 0.95);

  // Step 5: Deposit into target vault
  console.log(`\n🚀 Step 2: Depositing into ${best.vault.name}...`);
  rl.close();

  const { depositToVault } = require('./composer');
  const { recordPosition } = require('./tools');

  const ERC20_ABI_MIN = ['function balanceOf(address) view returns (uint256)'];
  const fromProvider  = await getProviderWithFallback(position.chainId);
  const usdcFromAddr  = getUsdcAddress(position.chainId);
  const usdcContract  = new ethers.Contract(usdcFromAddr, ERC20_ABI_MIN, fromProvider);
  const usdcBal       = await usdcContract.balanceOf(walletAddress);
  // signerはfromChain用 — cross-chainでもbridge txはfromChainで送信
  const signer        = new ethers.Wallet(process.env.PRIVATE_KEY, fromProvider);

  try {
    await depositToVault({
      signer,
      fromChainId:       position.chainId,
      toChainId:         best.vault.chainId,
      fromTokenAddress:  usdcFromAddr,
      vaultTokenAddress: best.vault.address,
      amountWei:         usdcBal.toString(),
      depositPack:       best.vault.depositPacks?.[0]?.name || '',
    });
    recordPosition(best.vault, best.vault.chainId);
    recordTx({ type:'rebalance-withdraw', fromVault: position.vaultName, chainId: position.chainId, valueUsd: position.valueUsd, asset: 'USDC', protocol: position.protocol });
    recordTx({ type:'rebalance-deposit', toVault: best.vault.name, chainId: best.vault.chainId, valueUsd: position.valueUsd, asset: 'USDC', protocol: best.vault.protocol });
    console.log(`\n🎉 Rebalance complete! Stay Vaulthoric.`);
    console.log(`\n🤖 Vaulthoric will monitor your position and notify you`);
    console.log(`   if better yield opportunities appear.`);
  } catch (err) {
    console.log(`\n❌ Deposit into ${best.vault.name} failed: ${err.message?.slice(0, 80)}`);
    console.log(`   Your USDC is now idle on ${getChainName(best.vault.chainId)}.`);
    console.log(`   Run: node ask.js "put my USDC into best vault on ${getChainName(best.vault.chainId)}"`);
  }
}

main().catch(e => {
  console.error('\n❌ Error:', e.message);
  process.exit(1);
}).finally(() => process.exit(0));
