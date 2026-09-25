import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, formatEther, getAddress } from 'ethers';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (config.chainId !== 11155111 || !config.executorKey || !config.rpcUrl || !config.weth) throw new Error('Sepolia RPC, WETH, and executor key are required');
const token = getAddress(process.argv[2]);
const v2Pair = getAddress(process.argv[3]);
const fee = Number(process.argv[4]);
if (!Number.isInteger(fee) || fee < 1 || fee >= 1_000_000) throw new Error('Pass a valid V3 fee tier');
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Deployment is restricted to Sepolia');
const wallet = new Wallet(config.executorKey, provider);
const pair = new Contract(v2Pair, ['function token0() view returns(address)', 'function token1() view returns(address)'], provider);
const [a, b] = await Promise.all([pair.token0(), pair.token1()]);
if (![a.toLowerCase(), b.toLowerCase()].includes(token.toLowerCase()) || ![a.toLowerCase(), b.toLowerCase()].includes(config.weth.toLowerCase())) throw new Error('V2 pair does not contain the configured WETH and token');
const v3Factory = new Contract('0x0227628f3F023bb0B980b67D528571c95c6DaC1c', ['function getPool(address,address,uint24) view returns(address)'], provider);
const v3Pool = await v3Factory.getPool(config.weth, token, fee);
if (v3Pool === ZeroAddress) throw new Error('No official Uniswap V3 pool for this pair and fee');
const router = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E';
const artifact = JSON.parse(readFileSync('artifacts/AtomicV2V3Arb.json', 'utf8'));
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const args = [config.weth, token, v2Pair, router, fee];
const transaction = await factory.getDeployTransaction(...args);
const estimate = await provider.estimateGas({ ...transaction, from: wallet.address });
const gasLimit = estimate * 12n / 10n;
const balance = await provider.getBalance(wallet.address);
if (balance < gasLimit * config.maxFeePerGas) throw new Error('Insufficient Sepolia ETH for capped deployment gas');
console.log(`Deploying on Sepolia; pool ${v3Pool}; estimated gas ${estimate}; maximum gas cost ${formatEther(gasLimit * config.maxFeePerGas)} Sepolia ETH`);
const contract = await factory.deploy(...args, {
  gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas,
});
const txHash = contract.deploymentTransaction().hash;
console.log(`Deployment transaction: ${txHash}`);
await contract.waitForDeployment();
console.log(`MIXED_ARB_CONTRACT_ADDRESS=${await contract.getAddress()}`);
