import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress } from 'ethers';
import { loadConfig } from '../src/config.js';
import { record } from '../src/journal.js';
import { MIXED_ABI, quoteMixed } from '../src/mixed.js';

const config = loadConfig();
if (config.chainId !== 11155111 || !config.executorKey) throw new Error('Sepolia executor key required');
const address = getAddress(process.argv[2]);
const direction = process.argv[3];
if (!['V3-to-V2', 'V2-to-V3'].includes(direction)) throw new Error('Usage: npm run simulate-mixed -- <contract> <V3-to-V2|V2-to-V3>');
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const wallet = new Wallet(config.executorKey, provider);
const arb = new Contract(address, MIXED_ABI, wallet);
const [owner, weth, token, v2Pair, fee] = await Promise.all([arb.owner(), arb.weth(), arb.token(), arb.v2Pair(), arb.v3Fee()]);
if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Executor is not contract owner');
const gasLimit = 600000n;
const gasCeiling = gasLimit * config.maxFeePerGas;
const candidates = await quoteMixed(provider, {
  weth, token, v2Pair, fee: Number(fee), direction, sizes: config.sizes,
  gasCeilingWei: gasCeiling, minNetProfitWei: config.minNetProfitWei,
});
if (!candidates.length) throw new Error('No current quote clears the 600000 gas ceiling and minimum profit');
function reason(error) {
  const data = error?.data ?? error?.info?.error?.data;
  if (typeof data === 'string') {
    try {
      const parsed = arb.interface.parseError(data);
      if (parsed) return parsed.name === 'Error' ? String(parsed.args[0]) : parsed.name;
    } catch { /* External contract revert. */ }
  }
  return String(error?.reason ?? error?.shortMessage ?? error?.message ?? error).slice(0, 240);
}
const method = direction === 'V3-to-V2' ? 'executeV3ToV2' : 'executeV2ToV3';
let passed = false;
for (const candidate of candidates) {
  const minGrossProfit = gasCeiling + config.minNetProfitWei;
  try {
    const grossProfit = await arb[method].staticCall(candidate.amountIn, minGrossProfit);
    const gasEstimate = await arb[method].estimateGas(candidate.amountIn, minGrossProfit);
    if (gasEstimate > gasLimit) throw new Error(`Estimated gas ${gasEstimate} exceeds cap ${gasLimit}`);
    passed = true;
    const result = {
      chainId: 11155111, contract: address, direction,
      amountInWei: candidate.amountIn, grossProfitWei: grossProfit,
      conservativeNetFloorWei: grossProfit - gasCeiling, gasEstimate,
      message: 'Deployed contract eth_call and estimateGas passed; no trade submitted',
    };
    record('simulation', result);
    console.log(JSON.stringify({
      amountInWeth: formatEther(candidate.amountIn),
      grossProfitWeth: formatEther(grossProfit),
      conservativeNetFloorWeth: formatEther(grossProfit - gasCeiling),
      gasEstimate: gasEstimate.toString(),
      gasLimit: gasLimit.toString(),
      note: 'Read-only Sepolia execution simulation, not a confirmed trade.',
    }, null, 2));
  } catch (error) {
    const message = reason(error);
    record('simulation_failed', { chainId: 11155111, contract: address, direction, amountInWei: candidate.amountIn, message });
    console.error(`${formatEther(candidate.amountIn)} WETH: ${message}`);
  }
}
if (!passed) process.exitCode = 1;
