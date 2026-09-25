import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress } from 'ethers';
import { loadConfig } from '../src/config.js';
import { record } from '../src/journal.js';
import { MIXED_ABI, quoteMixed } from '../src/mixed.js';

const config = loadConfig();
if (config.chainId !== 11155111 || !config.executorKey) throw new Error('Sepolia executor key required');
const address = getAddress(process.argv[2]);
const direction = process.argv[3];
if (!['V3-to-V2', 'V2-to-V3'].includes(direction) || process.argv[4] !== '--execute') {
  throw new Error('Usage: npm run trade-mixed -- <contract> <V3-to-V2|V2-to-V3> --execute');
}
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const wallet = new Wallet(config.executorKey, provider);
const arb = new Contract(address, MIXED_ABI, wallet);
const [owner, wethAddress, token, v2Pair, fee] = await Promise.all([arb.owner(), arb.weth(), arb.token(), arb.v2Pair(), arb.v3Fee()]);
if (owner.toLowerCase() !== wallet.address.toLowerCase() || wethAddress.toLowerCase() !== config.weth.toLowerCase()) throw new Error('Contract owner or WETH mismatch');
const weth = new Contract(wethAddress, [
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
], provider);
const gasLimit = 600000n;
const gasCeiling = gasLimit * config.maxFeePerGas;
const candidates = await quoteMixed(provider, {
  weth: wethAddress, token, v2Pair, fee: Number(fee), direction, sizes: config.sizes,
  gasCeilingWei: gasCeiling, minNetProfitWei: config.minNetProfitWei,
});
if (!candidates.length) throw new Error('No current quote clears capped gas and minimum net WETH');
const candidate = candidates[0];
const [balance, allowance, ethBalance] = await Promise.all([
  weth.balanceOf(wallet.address), weth.allowance(wallet.address, address), provider.getBalance(wallet.address),
]);
if (balance < candidate.amountIn || allowance < candidate.amountIn || ethBalance < gasCeiling) throw new Error('Insufficient WETH, allowance, or Sepolia gas balance');
const method = direction === 'V3-to-V2' ? 'executeV3ToV2' : 'executeV2ToV3';
const minGrossProfit = gasCeiling + config.minNetProfitWei;
const simulatedGross = await arb[method].staticCall(candidate.amountIn, minGrossProfit);
const gasEstimate = await arb[method].estimateGas(candidate.amountIn, minGrossProfit);
if (gasEstimate > gasLimit) throw new Error(`Estimated gas ${gasEstimate} exceeds cap ${gasLimit}`);
console.log(`Sepolia simulation passed: ${formatEther(candidate.amountIn)} WETH input; ${formatEther(simulatedGross - gasCeiling)} WETH conservative net floor; gas estimate ${gasEstimate}`);
const tx = await arb[method](candidate.amountIn, minGrossProfit, {
  gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas,
});
record('tx_sent', { chainId: 11155111, contract: address, direction, txHash: tx.hash, amountInWei: candidate.amountIn, message: 'Submitted direct Sepolia arbitrage transaction' });
console.log(`Transaction submitted: ${tx.hash}`);
let receipt;
try { receipt = await tx.wait(1); }
catch (error) { receipt = error?.receipt; if (!receipt) throw error; }
if (!receipt) throw new Error('Transaction receipt unavailable; check tx hash on Sepolia explorer');
const gasCostWei = receipt.gasUsed * receipt.gasPrice;
if (receipt.status !== 1) {
  record('receipt_failed', { chainId: 11155111, contract: address, direction, txHash: tx.hash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'Arbitrage transaction reverted' });
  throw new Error(`Transaction reverted: ${tx.hash}`);
}
const event = receipt.logs.filter(log => log.address.toLowerCase() === address.toLowerCase()).map(log => {
  try { return arb.interface.parseLog(log); } catch { return null; }
}).find(item => item?.name === 'MixedRouteExecuted');
if (!event) {
  record('receipt_failed', { chainId: 11155111, contract: address, direction, txHash: tx.hash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'MixedRouteExecuted event missing' });
  throw new Error(`Trade event missing from successful receipt: ${tx.hash}`);
}
const grossProfitWei = event.args.grossProfit;
const netProfitWei = grossProfitWei - gasCostWei;
record('confirmed', { chainId: 11155111, contract: address, direction, txHash: tx.hash, blockNumber: receipt.blockNumber, amountInWei: candidate.amountIn, grossProfitWei, gasCostWei, netProfitWei, message: 'Confirmed Sepolia arbitrage receipt' });
console.log(JSON.stringify({ txHash: tx.hash, blockNumber: receipt.blockNumber, grossProfitWeth: formatEther(grossProfitWei), gasCostEth: formatEther(gasCostWei), netProfitWethEquivalent: formatEther(netProfitWei), gasUsed: receipt.gasUsed.toString() }, null, 2));
