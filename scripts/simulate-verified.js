import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress, parseEther } from 'ethers';
import { loadConfig } from '../src/config.js';
import { record } from '../src/journal.js';

const config = loadConfig();
if (config.chainId !== 11155111 || !config.executorKey) throw new Error('Sepolia executor required');
const address = getAddress(process.env.VERIFIED_ARB_CONTRACT_ADDRESS || process.argv[2]);
const artifact = JSON.parse(readFileSync('artifacts/AtomicVerifiedMixedArb.json', 'utf8'));
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const wallet = new Wallet(config.executorKey, provider);
const arb = new Contract(address, artifact.abi, wallet);
if ((await arb.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Executor is not contract owner');
if ((await arb.weth()).toLowerCase() !== config.weth.toLowerCase()) throw new Error('WETH mismatch');
const source = JSON.parse(readFileSync('data/v3-overlap.json', 'utf8'));
const gasLimit = 600000n;
const gasCeiling = gasLimit * config.maxFeePerGas;
const minGrossProfit = gasCeiling + config.minNetProfitWei;
const unique = new Map();
for (const item of source.opportunities) {
  const key = `${item.token.toLowerCase()}:${item.v2Pair.toLowerCase()}:${item.fee}:${item.direction}`;
  if (!unique.has(key)) unique.set(key, { ...item, sizes: [] });
  unique.get(key).sizes.push(item.amountInWeth);
}
let passed = 0;
for (const route of unique.values()) {
  const direction = route.direction === 'V3-to-V2' ? 0 : 1;
  for (const size of route.sizes) {
    const amountIn = parseEther(size);
    try {
      const grossProfitWei = await arb.execute.staticCall(route.token, route.v2Pair, route.fee, direction, amountIn, minGrossProfit);
      const gasEstimate = await arb.execute.estimateGas(route.token, route.v2Pair, route.fee, direction, amountIn, minGrossProfit);
      if (gasEstimate > gasLimit) throw new Error(`Gas estimate ${gasEstimate} exceeds cap`);
      passed++;
      const result = { route, amountInWeth: size, grossProfitWeth: formatEther(grossProfitWei), netFloorWeth: formatEther(grossProfitWei - gasCeiling), gasEstimate: gasEstimate.toString() };
      record('simulation', { chainId: 11155111, contract: address, token: route.token, v2Pair: route.v2Pair, direction: route.direction, amountInWei: amountIn, grossProfitWei, conservativeNetFloorWei: grossProfitWei - gasCeiling, gasEstimate, message: 'Verified mixed Sepolia eth_call and gas estimate passed; no trade sent' });
      console.log(JSON.stringify({ status: 'PASS', ...result }));
    } catch (error) {
      let message = String(error?.reason ?? error?.shortMessage ?? error?.message ?? error);
      const data = error?.data ?? error?.info?.error?.data;
      if (typeof data === 'string') {
        try { const parsed = arb.interface.parseError(data); if (parsed) message = parsed.name === 'Error' ? String(parsed.args[0]) : parsed.name; } catch { /* External revert. */ }
      }
      message = message.slice(0, 220);
      record('simulation_failed', { chainId: 11155111, contract: address, token: route.token, v2Pair: route.v2Pair, direction: route.direction, amountInWei: amountIn, message });
      console.log(JSON.stringify({ status: 'FAIL', token: route.token, direction: route.direction, amountInWeth: size, message }));
    }
  }
}
console.log(`Executable profitable Sepolia simulations: ${passed}. These are not confirmed trades.`);
if (!passed) process.exitCode = 1;
