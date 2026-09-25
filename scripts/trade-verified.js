import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress, parseEther } from 'ethers';
import { loadConfig } from '../src/config.js';
import { record } from '../src/journal.js';

const config = loadConfig();
if (config.chainId !== 11155111 || !config.executorKey) throw new Error('Sepolia executor required');
const token = getAddress(process.argv[2]);
const amountIn = parseEther(process.argv[3]);
const execute = process.argv[4] === '--execute';
if (amountIn <= 0n || (process.argv[4] && !execute)) throw new Error('Usage: npm run trade-verified -- <token> <WETH-size> [--execute]');
const address = getAddress(process.env.VERIFIED_ARB_CONTRACT_ADDRESS);
const source = JSON.parse(readFileSync('data/v3-overlap.json', 'utf8'));
const route = source.opportunities.find(x => x.token.toLowerCase() === token.toLowerCase());
if (!route) throw new Error('Token is not in the latest scanned opportunity file');
const direction = route.direction === 'V3-to-V2' ? 0 : 1;
const artifact = JSON.parse(readFileSync('artifacts/AtomicVerifiedMixedArb.json', 'utf8'));
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const wallet = new Wallet(config.executorKey, provider);
const arb = new Contract(address, artifact.abi, wallet);
const [owner, wethAddress, v2Factory, v3Factory, v3Router] = await Promise.all([
  arb.owner(), arb.weth(), arb.v2Factory(), arb.v3Factory(), arb.v3Router(),
]);
if (owner.toLowerCase() !== wallet.address.toLowerCase() || wethAddress.toLowerCase() !== config.weth.toLowerCase()) throw new Error('Owner or WETH mismatch');
if (v2Factory.toLowerCase() !== '0xF62c03E08ada871A0bEb309762E260a7a6a880E6'.toLowerCase() || v3Factory.toLowerCase() !== '0x0227628f3F023bb0B980b67D528571c95c6DaC1c'.toLowerCase() || v3Router.toLowerCase() !== '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'.toLowerCase()) throw new Error('Unexpected factory or router');
const weth = new Contract(wethAddress, [
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
], provider);
const gasLimit = 600000n;
const gasCeiling = gasLimit * config.maxFeePerGas;
const minGrossProfit = gasCeiling + config.minNetProfitWei;
const [balance, allowance, ethBalance, latest] = await Promise.all([
  weth.balanceOf(wallet.address), weth.allowance(wallet.address, address), provider.getBalance(wallet.address), provider.getBlock('latest'),
]);
if (balance < amountIn || allowance < amountIn || ethBalance < gasCeiling) throw new Error('Insufficient WETH, allowance, or gas ETH');
if ((latest.baseFeePerGas ?? 0n) * 9n / 8n + config.maxPriorityFeePerGas > config.maxFeePerGas) throw new Error('Projected base fee exceeds cap');
const args = [token, route.v2Pair, route.fee, direction, amountIn, minGrossProfit];
const gross = await arb.execute.staticCall(...args);
const estimate = await arb.execute.estimateGas(...args);
if (estimate > gasLimit) throw new Error(`Gas estimate ${estimate} exceeds cap ${gasLimit}`);
console.log(JSON.stringify({ status: 'simulated', token, direction: route.direction, sizeWeth: formatEther(amountIn), grossProfitWeth: formatEther(gross), netFloorWeth: formatEther(gross - gasCeiling), gasEstimate: estimate.toString(), execute }, null, 2));
if (!execute) process.exit(0);
const tx = await arb.execute(...args, {
  gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas,
});
record('tx_sent', { chainId: 11155111, contract: address, token, direction: route.direction, txHash: tx.hash, amountInWei: amountIn, message: 'Submitted verified mixed Sepolia arbitrage' });
console.log(`Transaction submitted: ${tx.hash}`);
let receipt;
try { receipt = await tx.wait(1); }
catch (error) { receipt = error?.receipt; if (!receipt) throw error; }
if (!receipt) throw new Error(`No receipt for ${tx.hash}`);
const gasCostWei = receipt.gasUsed * receipt.gasPrice;
if (receipt.status !== 1) {
  record('receipt_failed', { chainId: 11155111, contract: address, token, direction: route.direction, txHash: tx.hash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'Verified mixed trade reverted' });
  throw new Error(`Trade reverted: ${tx.hash}`);
}
const event = receipt.logs.filter(log => log.address.toLowerCase() === address.toLowerCase()).map(log => {
  try { return arb.interface.parseLog(log); } catch { return null; }
}).find(item => item?.name === 'VerifiedMixedExecuted');
if (!event) throw new Error(`VerifiedMixedExecuted missing from ${tx.hash}`);
const grossProfitWei = event.args.grossProfit;
const netProfitWei = grossProfitWei - gasCostWei;
record('confirmed', { chainId: 11155111, contract: address, token, direction: route.direction, txHash: tx.hash, blockNumber: receipt.blockNumber, amountInWei: amountIn, grossProfitWei, gasCostWei, netProfitWei, message: 'Confirmed Sepolia verified mixed arbitrage receipt' });
console.log(JSON.stringify({ txHash: tx.hash, blockNumber: receipt.blockNumber, grossProfitWeth: formatEther(grossProfitWei), gasCostEth: formatEther(gasCostWei), netProfitWethEquivalent: formatEther(netProfitWei), gasUsed: receipt.gasUsed.toString() }, null, 2));
if (netProfitWei <= 0n) process.exitCode = 1;
