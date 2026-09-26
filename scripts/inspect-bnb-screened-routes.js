import { readFileSync } from 'node:fs';
import { JsonRpcProvider, formatEther, parseEther } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { loadBnbConfig } from '../src/bnb-config.js';
import { screenMixedRoutes } from '../src/mixed-screen.js';
import { quoteMixed } from '../src/mixed.js';

const config = loadBnbConfig();
const provider = new JsonRpcProvider(config.rpcUrl);
try {
  const routes = JSON.parse(readFileSync('data/bnb-routes.json', 'utf8')).routes;
  const sizes = ['0.00000001','0.0000001','0.000001','0.00001','0.0001','0.0005','0.001','0.005','0.01'].map(parseEther);
  const blockTag = await provider.getBlockNumber();
  const gasCeilingWei = config.gasLimit * config.maxGasPriceWei;
  const screens = await screenMixedRoutes(provider, { routes, weth: BNB_CHAIN.wbnb, multicallAddress: BNB_CHAIN.multicall, maxAmountIn: sizes.at(-1), gasCeilingWei, minNetProfitWei: config.minNetProfitWei, blockTag });
  const results = [];
  let batchMatchesSequential = null;
  for (const screen of screens.candidates) {
    const route = screen.route;
    const args = { weth: BNB_CHAIN.wbnb, token: route.token, v2Pair: route.v2Pair, fee: route.fee, direction: screen.direction, sizes, gasCeilingWei, minNetProfitWei: -parseEther('1'), quoterAddress: BNB_CHAIN.v3Quoter, blockTag };
    const start = Date.now();
    const quotes = await quoteMixed(provider, { ...args, multicallAddress: BNB_CHAIN.multicall });
    const durationMs = Date.now() - start;
    if (batchMatchesSequential === null) {
      const sequential = await quoteMixed(provider, args);
      batchMatchesSequential = quotes.length === sequential.length && quotes.every((quote, i) => quote.amountIn === sequential[i].amountIn && quote.amountOut === sequential[i].amountOut);
      if (!batchMatchesSequential) throw new Error('Batched quote differs from direct quote at the same block');
    }
    if (quotes.length) results.push({ token: route.token, fee: route.fee, direction: screen.direction, durationMs, bestSizeWbnb: formatEther(quotes[0].amountIn), grossWbnb: formatEther(quotes[0].grossProfit), netFloorWbnb: formatEther(quotes[0].netFloor), qualifies: quotes[0].netFloor >= config.minNetProfitWei });
  }
  results.sort((a,b) => Number(b.netFloorWbnb)-Number(a.netFloorWbnb));
  console.log(JSON.stringify({ blockTag, routesScreened: routes.length, fullQuoteDirections: screens.candidates.length, batchMatchesSequential, qualifyingDirections: results.filter(result=>result.qualifies).length, results }, null, 2));
} finally { provider.destroy(); }
