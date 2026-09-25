import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import { ARB_ABI, hopState } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { record } from '../src/journal.js';
import { selectRouteOpportunity } from '../src/math.js';

const config = loadConfig();
if (!config.routePairs || !config.rpcUrl || !config.executorKey || !config.arbContract) throw new Error('Configure route, RPC, executor key, and deployed contract first');
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const wallet = new Wallet(config.executorKey, provider);
const arb = new Contract(config.arbContract, ARB_ABI, wallet);
const states = await Promise.all(config.routePairs.map((pair, i) => hopState(provider, pair, config.routeTokens[i], config.routeTokens[i + 1])));
const gasCeiling = config.gasLimit * config.maxFeePerGas;
const candidate = selectRouteOpportunity(config.sizes, states, gasCeiling, config.minNetProfitWei);
if (!candidate) throw new Error('No configured route size clears the gas ceiling and minimum profit in current reserves');
const minGrossProfit = gasCeiling + config.minNetProfitWei;
const args = [config.routePairs, config.routeTokens, candidate.amountIn, minGrossProfit];
try {
  const grossProfit = await arb.executeRoute.staticCall(...args);
  const gasEstimate = await arb.executeRoute.estimateGas(...args);
  if (gasEstimate > config.gasLimit) throw new Error(`Estimated gas ${gasEstimate} exceeds configured limit ${config.gasLimit}`);
  const netFloor = grossProfit - gasCeiling;
  record('simulation', { chainId: 11155111, amountInWei: candidate.amountIn, grossProfitWei: grossProfit, netFloorWei: netFloor, gasEstimate, message: 'Read-only on-chain call succeeded; no trade submitted' });
  console.log(JSON.stringify({
    amountInWeth: formatEther(candidate.amountIn),
    grossProfitWeth: formatEther(grossProfit),
    conservativeNetFloorWeth: formatEther(netFloor),
    gasEstimate: gasEstimate.toString(),
    gasLimit: config.gasLimit.toString(),
    note: 'This is an eth_call simulation, not a confirmed trade.',
  }, null, 2));
} catch (error) {
  const reason = String(error?.reason ?? error?.shortMessage ?? error?.message ?? error).slice(0, 240);
  record('simulation_failed', { chainId: 11155111, amountInWei: candidate.amountIn, reason, message: `Sepolia execution simulation failed: ${reason}` });
  console.error(`Sepolia execution simulation failed: ${reason}`);
  process.exitCode = 1;
}
