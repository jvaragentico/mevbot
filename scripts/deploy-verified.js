import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { ContractFactory, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (config.chainId !== 11155111 || !config.executorKey || !config.weth) throw new Error('Sepolia executor, RPC, and WETH are required');
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const wallet = new Wallet(config.executorKey, provider);
const artifact = JSON.parse(readFileSync('artifacts/AtomicVerifiedMixedArb.json', 'utf8'));
const args = [
  config.weth,
  '0xF62c03E08ada871A0bEb309762E260a7a6a880E6',
  '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
];
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const estimate = await provider.estimateGas({ ...(await factory.getDeployTransaction(...args)), from: wallet.address });
const gasLimit = estimate * 12n / 10n;
const feeCeiling = gasLimit * config.maxFeePerGas;
if (await provider.getBalance(wallet.address) < feeCeiling) throw new Error('Insufficient Sepolia ETH for deployment');
console.log(`Deploying reusable Sepolia executor; gas estimate ${estimate}; cap ${formatEther(feeCeiling)} ETH`);
const contract = await factory.deploy(...args, {
  gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas,
});
console.log(`Deployment transaction: ${contract.deploymentTransaction().hash}`);
await contract.waitForDeployment();
console.log(`VERIFIED_ARB_CONTRACT_ADDRESS=${await contract.getAddress()}`);
