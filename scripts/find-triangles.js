import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { Contract, JsonRpcProvider, ZeroAddress, formatEther } from 'ethers';
import { hopState } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { selectRouteOpportunity } from '../src/math.js';

const config = loadConfig();
if (config.chainId !== 11155111) throw new Error('Expected Sepolia configuration');
const top = Number(process.env.TRIANGLE_TOP || '40');
if (!Number.isSafeInteger(top) || top < 2 || top > 300) throw new Error('TRIANGLE_TOP must be 2 to 300');
const source = JSON.parse(readFileSync('data/uniswap-pools.json', 'utf8'));
const wethPairs = source.liquidPairs.slice(0, top);
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const factoryAddress = '0xF62c03E08ada871A0bEb309762E260a7a6a880E6';
const factory = new Contract(factoryAddress, ['function getPair(address,address) view returns(address)'], provider);
const multicall = new Contract('0xcA11bde05977b3631167028862bE2a173976CA11', [
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[])',
], provider);
const states = await Promise.all(wethPairs.map(pool => hopState(provider, pool.address, config.weth, pool.token)));
const requests = [];
for (let i = 0; i < wethPairs.length; i++) for (let j = i + 1; j < wethPairs.length; j++) requests.push([i, j]);
const opportunities = [];
let crossPairs = 0;
for (let offset = 0; offset < requests.length; offset += 100) {
  const slice = requests.slice(offset, offset + 100);
  const calls = slice.map(([i, j]) => ({
    target: factoryAddress,
    allowFailure: true,
    callData: factory.interface.encodeFunctionData('getPair', [wethPairs[i].token, wethPairs[j].token]),
  }));
  const results = await multicall.aggregate3.staticCall(calls);
  for (let k = 0; k < results.length; k++) {
    if (!results[k].success) continue;
    const crossAddress = factory.interface.decodeFunctionResult('getPair', results[k].returnData)[0];
    if (crossAddress === ZeroAddress) continue;
    crossPairs++;
    const [i, j] = slice[k];
    const a = wethPairs[i], b = wethPairs[j];
    for (const [first, second] of [[a, b], [b, a]]) {
      try {
        const hops = [
          states[first === a ? i : j],
          await hopState(provider, crossAddress, first.token, second.token),
          await hopState(provider, second.address, second.token, config.weth),
        ];
        const candidate = selectRouteOpportunity(config.sizes, hops, config.gasLimit * config.maxFeePerGas, config.minNetProfitWei);
        if (candidate) opportunities.push({
          pairs: [first.address, crossAddress, second.address],
          tokens: [config.weth, first.token, second.token, config.weth],
          amountInWeth: formatEther(candidate.amountIn),
          quotedNetFloorWeth: formatEther(candidate.netFloor),
          quotedGrossWeth: formatEther(candidate.grossProfit),
        });
      } catch { /* A failed pool read does not establish an opportunity. */ }
    }
  }
}
opportunities.sort((a, b) => Number(b.quotedNetFloorWeth) - Number(a.quotedNetFloorWeth));
const result = { at: new Date().toISOString(), sourceBlock: source.to, wethPairsConsidered: wethPairs.length, crossPairs, quotedOpportunities: opportunities };
writeFileSync('data/triangles.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, quotedOpportunities: opportunities.slice(0, 20), totalQuotedOpportunities: opportunities.length }, null, 2));
console.log('These are reserve-only quotes. Token behavior and contract execution must be simulated on Sepolia before trading.');
