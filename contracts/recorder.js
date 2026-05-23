const { ethers } = require('ethers');
const { address, abi } = require('./contracts/deployed.json');

let _recorder = null;

function getRecorder() {
  if (_recorder) return _recorder;
  const provider = new ethers.JsonRpcProvider(process.env.RPC_ARC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  _recorder = new ethers.Contract(address, abi, wallet);
  return _recorder;
}

async function recordOpen(eoa, amount, vault, regime) {
  try {
    const r = getRecorder();
    const amountWei = ethers.parseUnits(amount.toFixed(6), 6);
    const tx = await r.recordOpen(eoa, amountWei, vault, regime);
    console.log(`[recorder] PositionOpened tx: ${tx.hash}`);
    return tx.hash;
  } catch(e) {
    console.error('[recorder] recordOpen failed:', e.message?.slice(0,80));
    return null;
  }
}

async function recordClose(eoa, reason) {
  try {
    const r = getRecorder();
    const tx = await r.recordClose(eoa, reason);
    console.log(`[recorder] PositionClosed tx: ${tx.hash}`);
    return tx.hash;
  } catch(e) {
    console.error('[recorder] recordClose failed:', e.message?.slice(0,80));
    return null;
  }
}

module.exports = { recordOpen, recordClose };
