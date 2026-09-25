import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet, parseEther } from 'ethers';

const { RPC_URL, EXECUTOR_KEY, WETH_ADDRESS, ARB_CONTRACT_ADDRESS } = process.env;
if (![RPC_URL, EXECUTOR_KEY, WETH_ADDRESS, ARB_CONTRACT_ADDRESS].every(Boolean)) throw new Error('Set RPC_URL, EXECUTOR_KEY, WETH_ADDRESS, ARB_CONTRACT_ADDRESS in .env');
const provider = new JsonRpcProvider(RPC_URL);
const network = await provider.getNetwork();
if (network.chainId !== 11155111n) throw new Error('Wallet preparation is restricted to Sepolia');
const wallet = new Wallet(EXECUTOR_KEY, provider);
const weth = new Contract(WETH_ADDRESS, [
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
], wallet);
const sizes = (process.env.TRADE_SIZES_WETH ?? '0.001,0.002,0.005').split(',').map(s => parseEther(s.trim()));
const maxSize = sizes.reduce((a, b) => a > b ? a : b);
const balance = await weth.balanceOf(wallet.address);
if (balance < maxSize) {
  const need = maxSize - balance;
  console.log(`Wrapping ${need} wei of Sepolia ETH into WETH`);
  const tx = await weth.deposit({ value: need });
  await tx.wait();
  console.log(`Wrap confirmed: ${tx.hash}`);
}
const allowance = await weth.allowance(wallet.address, ARB_CONTRACT_ADDRESS);
if (allowance < maxSize) {
  const tx = await weth.approve(ARB_CONTRACT_ADDRESS, maxSize);
  await tx.wait();
  console.log(`Approval confirmed: ${tx.hash}`);
}
console.log('Executor WETH balance and approval are sufficient for the configured largest trade.');
