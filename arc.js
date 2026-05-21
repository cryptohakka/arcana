require('dotenv').config();
const { randomBytes } = require('node:crypto');
const {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  pad,
  zeroAddress,
  maxUint256,
  formatUnits,
  parseUnits,
  erc20Abi,
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');
const axios = require('axios');

// ── Arc Testnet chain definition ──────────────────────────────────────────────
const arcTestnet = {
  id: 0x4cef52,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
  rpcUrls: {
    default: { http: [process.env.RPC_ARC || 'https://rpc.testnet.arc-node.thecanteenapp.com'] },
  },
};

// ── Constants ─────────────────────────────────────────────────────────────────
const GATEWAY_WALLET   = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const GATEWAY_MINTER   = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
const GATEWAY_API      = 'https://gateway-api-testnet.circle.com/v1';
const MAX_FEE          = 2_010000n;

const CHAINS = {
  baseSepolia: {
    chain:    baseSepolia,
    usdc:     '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    domainId: 6,
  },
  arcTestnet: {
    chain:    arcTestnet,
    usdc:     '0x3600000000000000000000000000000000000000',
    domainId: 26,
  },
};

// ── ABIs ──────────────────────────────────────────────────────────────────────
const gatewayWalletAbi = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      { name: 'token',  type: 'address' },
      { name: 'value',  type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
];

const gatewayMinterAbi = [
  {
    type: 'function',
    name: 'gatewayMint',
    inputs: [
      { name: 'attestationPayload', type: 'bytes' },
      { name: 'signature',          type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function addressToBytes32(address) {
  return pad(address.toLowerCase(), { size: 32 });
}

function stringify(obj) {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function getAccount() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY not set in .env');
  return privateKeyToAccount(pk);
}

// ── Step 1: Deposit USDC into Gateway Wallet on Base Sepolia ──────────────────
async function depositToGateway(amountUsdc = '2') {
  const account  = getAccount();
  const cfg      = CHAINS.baseSepolia;
  const amountWei = parseUnits(amountUsdc, 6);

  const BASE_SEP_RPC = 'https://sepolia.base.org';
  const publicClient = createPublicClient({ chain: cfg.chain, transport: http(BASE_SEP_RPC) });
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport: http(BASE_SEP_RPC) });

  // Check balance
  const bal = await publicClient.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  console.log(`[arc] USDC balance on Base Sepolia: ${formatUnits(bal, 6)}`);
  if (bal < amountWei) throw new Error(`Insufficient USDC: have ${formatUnits(bal, 6)}, need ${amountUsdc}`);

  // Approve
  console.log(`[arc] Approving ${amountUsdc} USDC...`);
  const approveTx = await walletClient.writeContract({ address: cfg.usdc, abi: erc20Abi, functionName: 'approve', args: [GATEWAY_WALLET, amountWei] });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log(`[arc] Approved: ${approveTx}`);

  // Deposit
  console.log(`[arc] Depositing ${amountUsdc} USDC to Gateway Wallet...`);
  const depositTx = await walletClient.writeContract({ address: GATEWAY_WALLET, abi: gatewayWalletAbi, functionName: 'deposit', args: [cfg.usdc, amountWei] });
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  console.log(`[arc] Deposited: ${depositTx}`);

  return depositTx;
}

// ── Step 2: Transfer USDC from Base Sepolia Gateway balance → Arc Testnet ─────
async function transferToArc(amountUsdc = '1', recipientAddress = null) {
  const account    = getAccount();
  const srcCfg     = CHAINS.baseSepolia;
  const dstCfg     = CHAINS.arcTestnet;
  const recipient  = recipientAddress || account.address;
  const transferVal = parseUnits(amountUsdc, 6);

  // Build burn intent
  const burnIntent = {
    maxBlockHeight: maxUint256,
    maxFee:         MAX_FEE,
    spec: {
      version:              1,
      sourceDomain:         srcCfg.domainId,
      destinationDomain:    dstCfg.domainId,
      sourceContract:       GATEWAY_WALLET,
      destinationContract:  GATEWAY_MINTER,
      sourceToken:          srcCfg.usdc,
      destinationToken:     dstCfg.usdc,
      sourceDepositor:      account.address,
      destinationRecipient: recipient,
      sourceSigner:         account.address,
      destinationCaller:    zeroAddress,
      value:                transferVal,
      salt:                 '0x' + randomBytes(32).toString('hex'),
      hookData:             '0x',
    },
  };

  // EIP-712 typed data
  const EIP712Domain = [
    { name: 'name',    type: 'string' },
    { name: 'version', type: 'string' },
  ];
  const TransferSpec = [
    { name: 'version',              type: 'uint32'  },
    { name: 'sourceDomain',         type: 'uint32'  },
    { name: 'destinationDomain',    type: 'uint32'  },
    { name: 'sourceContract',       type: 'bytes32' },
    { name: 'destinationContract',  type: 'bytes32' },
    { name: 'sourceToken',          type: 'bytes32' },
    { name: 'destinationToken',     type: 'bytes32' },
    { name: 'sourceDepositor',      type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner',         type: 'bytes32' },
    { name: 'destinationCaller',    type: 'bytes32' },
    { name: 'value',                type: 'uint256' },
    { name: 'salt',                 type: 'bytes32' },
    { name: 'hookData',             type: 'bytes'   },
  ];
  const BurnIntent = [
    { name: 'maxBlockHeight', type: 'uint256'      },
    { name: 'maxFee',         type: 'uint256'      },
    { name: 'spec',           type: 'TransferSpec' },
  ];

  const typedData = {
    types:       { EIP712Domain, TransferSpec, BurnIntent },
    domain:      { name: 'GatewayWallet', version: '1' },
    primaryType: 'BurnIntent',
    message: {
      ...burnIntent,
      spec: {
        ...burnIntent.spec,
        sourceContract:       addressToBytes32(burnIntent.spec.sourceContract),
        destinationContract:  addressToBytes32(burnIntent.spec.destinationContract),
        sourceToken:          addressToBytes32(burnIntent.spec.sourceToken),
        destinationToken:     addressToBytes32(burnIntent.spec.destinationToken),
        sourceDepositor:      addressToBytes32(burnIntent.spec.sourceDepositor),
        destinationRecipient: addressToBytes32(burnIntent.spec.destinationRecipient),
        sourceSigner:         addressToBytes32(burnIntent.spec.sourceSigner),
        destinationCaller:    addressToBytes32(burnIntent.spec.destinationCaller),
      },
    },
  };

  // Sign (viem signTypedData needs bigint values)
  console.log(`[arc] Signing burn intent (${amountUsdc} USDC: Base Sepolia → Arc Testnet)...`);
  const signature = await account.signTypedData(typedData);
  console.log('[arc] Signature:', signature);

  // Build API payload (bigints → strings)
  const apiPayload = JSON.parse(stringify([{ burnIntent: typedData.message, signature }]));
  console.log('[arc] Payload:', JSON.stringify(apiPayload, null, 2));

  // Request attestation
  console.log('[arc] Requesting Gateway attestation...');
  const res = await axios.post(
    `${GATEWAY_API}/transfer`,
    apiPayload,
    { headers: { 'Content-Type': 'application/json' } }
  ).catch(e => { throw new Error(JSON.stringify(e.response?.data)); });

  const { attestation, signature: operatorSig } = res.data;
  if (!attestation || !operatorSig) throw new Error('Missing attestation or signature from Gateway API');
  console.log('[arc] Attestation received.');

  // Mint on Arc Testnet
  console.log('[arc] Minting USDC on Arc Testnet...');
  const arcPublicClient = createPublicClient({ chain: arcTestnet, transport: http(process.env.RPC_ARC) });
  const arcWalletClient = createWalletClient({ account, chain: arcTestnet, transport: http(process.env.RPC_ARC) });

  const minter = getContract({
    address: GATEWAY_MINTER,
    abi:     gatewayMinterAbi,
    client:  { public: arcPublicClient, wallet: arcWalletClient },
  });

  const mintTx = await minter.write.gatewayMint([attestation, operatorSig], { account });
  await arcPublicClient.waitForTransactionReceipt({ hash: mintTx });
  console.log(`[arc] Minted on Arc Testnet: ${mintTx}`);

  return mintTx;
}

// ── Query Gateway balance ─────────────────────────────────────────────────────
async function getGatewayBalance(address = null) {
  const account   = getAccount();
  const depositor = address || account.address;

  const res = await axios.post(
    `${GATEWAY_API}/balances`,
    {
      token:   'USDC',
      sources: [
        { domain: CHAINS.baseSepolia.domainId, depositor },
        { domain: CHAINS.arcTestnet.domainId,  depositor },
      ],
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );

  const balances = {};
  for (const b of res.data.balances) {
    const chain = Object.keys(CHAINS).find(k => CHAINS[k].domainId === b.domain) || `domain-${b.domain}`;
    balances[chain] = parseFloat(b.balance);
  }

  
  return balances;
}


// ── Step 3: Transfer USDC from Arc Testnet → Base Sepolia ─────────────────────
async function transferFromArc(amountUsdc = '1', recipientAddress = null) {
  const account     = getAccount();
  const srcCfg      = CHAINS.arcTestnet;
  const dstCfg      = CHAINS.baseSepolia;
  const recipient   = recipientAddress || account.address;
  const transferVal = parseUnits(amountUsdc, 6);


  // Step 1: Verify Gateway Arc balance (deposit from Arc wallet not supported)
  const gatewayBals = await getGatewayBalance();
  const gatewayArcBal = gatewayBals.arcTestnet || 0;
  console.log(`[arc] Gateway Arc balance: ${gatewayArcBal} USDC`);
  if (gatewayArcBal < parseFloat(amountUsdc)) {
    throw new Error(`Insufficient Gateway Arc balance: ${gatewayArcBal} < ${amountUsdc}`);
  }
  console.log(`[arc] Gateway balance sufficient, proceeding with burn intent.`);
  // Step 2: Build + sign burn intent
  const burnIntent = {
    maxBlockHeight: maxUint256,
    maxFee:         MAX_FEE,
    spec: {
      version:              1,
      sourceDomain:         srcCfg.domainId,
      destinationDomain:    dstCfg.domainId,
      sourceContract:       GATEWAY_WALLET,
      destinationContract:  GATEWAY_MINTER,
      sourceToken:          srcCfg.usdc,
      destinationToken:     dstCfg.usdc,
      sourceDepositor:      account.address,
      destinationRecipient: recipient,
      sourceSigner:         account.address,
      destinationCaller:    zeroAddress,
      value:                transferVal,
      salt:                 '0x' + randomBytes(32).toString('hex'),
      hookData:             '0x',
    },
  };

  const EIP712Domain = [
    { name: 'name',    type: 'string' },
    { name: 'version', type: 'string' },
  ];
  const TransferSpec = [
    { name: 'version',              type: 'uint32'  },
    { name: 'sourceDomain',         type: 'uint32'  },
    { name: 'destinationDomain',    type: 'uint32'  },
    { name: 'sourceContract',       type: 'bytes32' },
    { name: 'destinationContract',  type: 'bytes32' },
    { name: 'sourceToken',          type: 'bytes32' },
    { name: 'destinationToken',     type: 'bytes32' },
    { name: 'sourceDepositor',      type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner',         type: 'bytes32' },
    { name: 'destinationCaller',    type: 'bytes32' },
    { name: 'value',                type: 'uint256' },
    { name: 'salt',                 type: 'bytes32' },
    { name: 'hookData',             type: 'bytes'   },
  ];
  const BurnIntent = [
    { name: 'maxBlockHeight', type: 'uint256'      },
    { name: 'maxFee',         type: 'uint256'      },
    { name: 'spec',           type: 'TransferSpec' },
  ];

  const typedData = {
    types:       { EIP712Domain, TransferSpec, BurnIntent },
    domain:      { name: 'GatewayWallet', version: '1' },
    primaryType: 'BurnIntent',
    message: {
      ...burnIntent,
      spec: {
        ...burnIntent.spec,
        sourceContract:       addressToBytes32(burnIntent.spec.sourceContract),
        destinationContract:  addressToBytes32(burnIntent.spec.destinationContract),
        sourceToken:          addressToBytes32(burnIntent.spec.sourceToken),
        destinationToken:     addressToBytes32(burnIntent.spec.destinationToken),
        sourceDepositor:      addressToBytes32(burnIntent.spec.sourceDepositor),
        destinationRecipient: addressToBytes32(burnIntent.spec.destinationRecipient),
        sourceSigner:         addressToBytes32(burnIntent.spec.sourceSigner),
        destinationCaller:    addressToBytes32(burnIntent.spec.destinationCaller),
      },
    },
  };

  console.log(`[arc] Signing burn intent (${amountUsdc} USDC: Arc Testnet → Base Sepolia)...`);
  const signature = await account.signTypedData(typedData);
  const apiPayload = JSON.parse(stringify([{ burnIntent: typedData.message, signature }]));

  // Step 3: Attestation
  console.log('[arc] Requesting Gateway attestation (Arc → Base)...');
  const res = await axios.post(
    `${GATEWAY_API}/transfer`,
    apiPayload,
    { headers: { 'Content-Type': 'application/json' } }
  ).catch(e => { throw new Error(JSON.stringify(e.response?.data)); });

  const { attestation, signature: operatorSig } = res.data;
  if (!attestation || !operatorSig) throw new Error('Missing attestation or signature from Gateway API');
  console.log('[arc] Attestation received.');

  // Step 4: Mint on Base Sepolia
  console.log('[arc] Minting USDC on Base Sepolia...');
  const { baseSepolia } = await import('viem/chains');
  const basePublicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const baseWalletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });

  const mintTx = await baseWalletClient.writeContract({
    address: GATEWAY_MINTER,
    abi: gatewayMinterAbi,
    functionName: 'gatewayMint',
    args: [attestation, operatorSig],
  });
  await basePublicClient.waitForTransactionReceipt({ hash: mintTx });
  console.log(`[arc] Minted on Base Sepolia: ${mintTx}`);
  return mintTx;
}

module.exports = { depositToGateway, transferToArc, transferFromArc, getGatewayBalance, arcTestnet, CHAINS };

// Run directly for testing
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'deposit')  depositToGateway(process.argv[3] || '2').catch(console.error);
  if (cmd === 'transfer') transferToArc(process.argv[3] || '1').catch(console.error);
  if (cmd === 'balance')  getGatewayBalance().catch(console.error);
  if (cmd === 'transfer-back') transferFromArc(process.argv[3] || '1').catch(console.error);
}

// ── Dev-Controlled Wallet operations ─────────────────────────────────────────
const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey:       process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });
}

async function getAgentWalletBalance(walletId) {
  const client = getCircleClient();
  const res = await client.getWalletTokenBalance({ id: walletId || process.env.CIRCLE_WALLET_ID });
  return res.data?.tokenBalances || [];
}

async function sendFromAgentWallet(toAddress, amountUsdc, walletId) {
  const client = getCircleClient();
  const ARC_USDC = '0x3600000000000000000000000000000000000000';
  const tx = await client.createTransaction({
    walletId:           walletId || process.env.CIRCLE_WALLET_ID,
    tokenAddress:       ARC_USDC,
    destinationAddress: toAddress,
    amounts:            [amountUsdc.toString()],
    fee:                { type: 'level', config: { feeLevel: 'MEDIUM' } },
    blockchain:         'ARC-TESTNET',
  });
  return tx.data?.id;
}

module.exports = Object.assign(module.exports, { getAgentWalletBalance, sendFromAgentWallet });

// ── Unified Balance Transfer (Arc App Kit) ────────────────────────────────────
const { AppKit } = require('@circle-fin/app-kit');
const { createViemAdapterFromPrivateKey } = require('@circle-fin/adapter-viem-v2');

function getAppKitAdapter() {
  return createViemAdapterFromPrivateKey({ privateKey: process.env.PRIVATE_KEY });
}

async function unifiedTransferToArc(amountUsdc, recipientAddress = null) {
  const kit = new AppKit();
  const adapter = getAppKitAdapter();
  const recipient = recipientAddress || process.env.WALLET_ADDRESS;
  console.log(`[arc] Unified spend: Base_Sepolia → Arc_Testnet ${amountUsdc} USDC...`);
  const result = await kit.unifiedBalance.spend({
    amount: amountUsdc.toString(),
    token: 'USDC',
    from: [{ adapter }],
    to: { adapter, chain: 'Arc_Testnet', recipientAddress: recipient },
  });
  console.log(`[arc] Minted on Arc Testnet: ${result.txHash}`);
  // Wait for Arc Testnet wallet balance to reflect the mint
  // Wait for Base Sepolia mint to confirm
  await new Promise(r => setTimeout(r, 20000));
}

async function unifiedTransferFromArc(amountUsdc, recipientAddress = null) {
  const kit = new AppKit();
  const adapter = getAppKitAdapter();
  const recipient = recipientAddress || process.env.WALLET_ADDRESS;
  console.log(`[arc] Unified spend: Arc_Testnet → Base_Sepolia ${amountUsdc} USDC...`);
  const result = await kit.unifiedBalance.spend({
    amount: amountUsdc.toString(),
    token: 'USDC',
    from: [{ adapter }],
    to: { adapter, chain: 'Base_Sepolia', recipientAddress: recipient },
  });
  console.log(`[arc] Minted on Base Sepolia: ${result.txHash}`);
  return result.txHash;
}

async function getUnifiedBalance() {
  const kit = new AppKit();
  const adapter = getAppKitAdapter();
  const result = await kit.unifiedBalance.getBalances({
    sources: [{ adapter }],
    networkType: 'testnet',
    includePending: true,
  });
  const breakdown = result.breakdown?.[0]?.breakdown || [];
  return {
    baseSepolia: parseFloat(breakdown.find(b => b.chain === 'Base_Sepolia')?.confirmedBalance || '0'),
    arcTestnet:  parseFloat(breakdown.find(b => b.chain === 'Arc_Testnet')?.confirmedBalance || '0'),
  };
}

module.exports = { ...module.exports, unifiedTransferToArc, unifiedTransferFromArc, getUnifiedBalance };

async function unifiedDeposit(amountUsdc, chain = 'Base_Sepolia') {
  const kit = new AppKit();
  const adapter = getAppKitAdapter();
  console.log(`[arc] Unified deposit: ${chain} → Unified Balance ${amountUsdc} USDC...`);
  const result = await kit.unifiedBalance.deposit({
    from: { adapter, chain },
    amount: amountUsdc.toString(),
    token: 'USDC',
  });
  console.log(`[arc] Deposited to Unified Balance: ${result.txHash}`);
  // Poll until confirmed
  const target = parseFloat(amountUsdc) * 0.9; // 90% threshold
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const balances = await kit.unifiedBalance.getBalances({ sources: [{ adapter }], networkType: 'testnet', includePending: true });
    const b = balances.breakdown?.[0]?.breakdown?.find(x => x.chain === chain);
    const confirmed = parseFloat(b?.confirmedBalance || 0);
    const pending   = parseFloat(b?.pendingBalance || 0);
    console.log(`[arc] deposit status: confirmed=${confirmed} pending=${pending}`);
    if (confirmed >= target) { console.log('[arc] Deposit confirmed.'); break; }
    await new Promise(r => setTimeout(r, 5000));
  }
  return result.txHash;
}

module.exports = { ...module.exports, unifiedDeposit };
