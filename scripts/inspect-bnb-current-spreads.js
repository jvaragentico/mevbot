import { readFileSync } from 'node:fs';
import { JsonRpcProvider, formatEther, parseEther, parseUnits } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { quoteMixed } from '../src/mixed.js';

const source = JSON.parse(readFileSync('data/bnb-routes.json', 'utf8'));
const provider = new JsonRpcProvider(process.env.BNB_SCAN_RPC_URL || BNB_CHAIN.rpc);
const sizes = ['0.0001', '0.0005', '0.001', '0.005', '0.01'].map(parseEther);
const gasCeilingWei = 600000n * parseUnits('0.2', 'gwei');
const results = [];
for (const route of source.routes) {
  for (const direction of ['V3-to-V2', 'V2-to-V3']) {
    const quotes = await quoteMixed(provider, {
      weth: BNB_CHAIN.wbnb, token: route.token, v2Pair: route.v2Pair, fee: route.fee,
      direction, sizes, gasCeilingWei, minNetProfitWei: -parseEther('100'),
      quoterAddress: BNB_CHAIN.v3Quoter,
    });
    if (quotes.length) results.push({ token: route.token, fee: route.fee, direction, bestSize: formatEther(quotes[0].amountIn), netFloor: formatEther(quotes[0].netFloor) });
  }
}
results.sort((a, b) => Number(b.netFloor) - Number(a.netFloor));
console.log(JSON.stringify({ routes: source.routes.length, quotedDirections: results.length, best: results.slice(0, 12) }, null, 2));
