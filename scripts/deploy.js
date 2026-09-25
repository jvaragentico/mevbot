import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { ContractFactory, JsonRpcProvider, Wallet, getAddress } from 'ethers';

const { RPC_URL, EXECUTOR_KEY, WETH_ADDRESS, TOKEN_ADDRESS } = process.env;
if (![RPC_URL, EXECUTOR_KEY, WETH_ADDRESS, TOKEN_ADDRESS].every(Boolean)) throw new Error('Set RPC_URL, EXECUTOR_KEY, WETH_ADDRESS, TOKEN_ADDRESS in .env');
const provider = new JsonRpcProvider(RPC_URL);
const network = await provider.getNetwork();
if (network.chainId !== 11155111n) throw new Error('Deployment is restricted to Sepolia');
const wallet = new Wallet(EXECUTOR_KEY, provider);
const artifact = JSON.parse(readFileSync('artifacts/AtomicV2Arb.json', 'utf8'));
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const contract = await factory.deploy(getAddress(WETH_ADDRESS), getAddress(TOKEN_ADDRESS));
console.log(`Deployment transaction: ${contract.deploymentTransaction().hash}`);
await contract.waitForDeployment();
console.log(`ARB_CONTRACT_ADDRESS=${await contract.getAddress()}`);
