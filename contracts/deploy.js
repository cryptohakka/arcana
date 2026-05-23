require('dotenv').config({ path: '../.env' });
const { ethers } = require('ethers');
const fs = require('fs');

const abi = JSON.parse(fs.readFileSync('./PositionRecorder_sol_PositionRecorder.abi', 'utf8'));
const bytecode = '0x' + fs.readFileSync('./PositionRecorder_sol_PositionRecorder.bin', 'utf8').trim();

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_ARC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log('Deployer:', wallet.address);
  console.log('Balance:', ethers.formatEther(await provider.getBalance(wallet.address)));

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log('Deploying...');
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log('PositionRecorder deployed:', address);

  fs.writeFileSync('./deployed.json', JSON.stringify({ address, abi }, null, 2));
  console.log('Saved to deployed.json');
}

main().catch(console.error);
