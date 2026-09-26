import { readFileSync } from 'node:fs';
import { JsonRpcProvider, formatEther } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { loadBnbConfig } from '../src/bnb-config.js';
import { screenMixedRoutes } from '../src/mixed-screen.js';

const config = loadBnbConfig();
const provider = new JsonRpcProvider(config.rpcUrl);
try {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Expected BNB Chain');
  const { routes } = JSON.parse(readFileSync('data/bnb-routes.json', 'utf8'));
  const timings = [];
  let qualifyingSnapshots = 0;
  let bestUpperNetWei = null;
  let invalidRoutes = 0;
  const samples = Number(process.argv[2] || 10);
  for (let i = 0; i < samples; i++) {
    const blockTag = await provider.getBlockNumber();
    const start = Date.now();
    const result = await screenMixedRoutes(provider, { routes, weth: BNB_CHAIN.wbnb, multicallAddress: BNB_CHAIN.multicall, maxAmountIn: config.sizes.reduce((a, b) => a > b ? a : b), gasCeilingWei: config.gasLimit * config.maxGasPriceWei, minNetProfitWei: config.minNetProfitWei, blockTag });
    timings.push(Date.now() - start);
    if (result.candidates.length) qualifyingSnapshots++;
    invalidRoutes += result.invalidRoutes;
    if (result.bestUpperNetWei !== null && (bestUpperNetWei === null || result.bestUpperNetWei > bestUpperNetWei)) bestUpperNetWei = result.bestUpperNetWei;
    if (i + 1 < samples) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ samples, routesPerSnapshot: routes.length, directionsPerSnapshot: routes.length * 2, p50SnapshotMs: timings[Math.floor(timings.length * 0.5)], p95SnapshotMs: timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))], qualifyingSnapshots, invalidRoutes, bestUpperNetWbnb: bestUpperNetWei === null ? null : formatEther(bestUpperNetWei) }, null, 2));
} finally { provider.destroy(); }
