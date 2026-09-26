import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { Contract, Interface, JsonRpcProvider, ZeroAddress, formatEther, parseEther } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { loadBnbConfig } from '../src/bnb-config.js';
import { quoteMixed } from '../src/mixed.js';

const config = loadBnbConfig();
const provider = new JsonRpcProvider(process.env.BNB_SCAN_RPC_URL || config.rpcUrl);
if ((await provider.getNetwork()).chainId !== BNB_CHAIN.chainId) throw new Error('Expected BNB Smart Chain');
const factory = new Contract(BNB_CHAIN.v2Factory, ['function allPairsLength() view returns(uint256)', 'function allPairs(uint256) view returns(address)'], provider);
const v3Factory = new Interface(['function getPool(address,address,uint24) view returns(address)']);
const pairInterface = new Interface(['function token0() view returns(address)', 'function token1() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)']);
const liquidityInterface = new Interface(['function liquidity() view returns(uint128)']);
const multicall = new Contract(BNB_CHAIN.multicall, ['function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[])'], provider);
const allPairsLength = Number(await factory.allPairsLength());
if (!Number.isSafeInteger(allPairsLength) || allPairsLength > 100000) throw new Error('Unexpected factory size');
async function batch(calls) {
  const output = [];
  for (let i = 0; i < calls.length; i += 120) {
    const part = calls.slice(i, i + 120);
    const results = await multicall.aggregate3.staticCall(part);
    output.push(...results);
  }
  return output;
}
const pairCalls = Array.from({ length: allPairsLength }, (_, i) => ({ target: BNB_CHAIN.v2Factory, allowFailure: true, callData: factory.interface.encodeFunctionData('allPairs', [i]) }));
const pairResults = await batch(pairCalls);
const pairs = pairResults.map(result => result.success ? factory.interface.decodeFunctionResult('allPairs', result.returnData)[0] : null).filter(Boolean);
console.log(`Enumerated ${pairs.length} of ${allPairsLength} official Uniswap V2 pairs`);
const stateCalls = pairs.flatMap(pair => ['token0', 'token1', 'getReserves'].map(method => ({ target: pair, allowFailure: true, callData: pairInterface.encodeFunctionData(method) })));
const stateResults = await batch(stateCalls);
const liquid = [];
const minimumReserve = parseEther(process.env.BNB_MIN_POOL_WBNB || '0.05');
for (let i = 0; i < pairs.length; i++) {
  const results = stateResults.slice(i * 3, i * 3 + 3);
  if (results.some(result => !result.success)) continue;
  const token0 = pairInterface.decodeFunctionResult('token0', results[0].returnData)[0];
  const token1 = pairInterface.decodeFunctionResult('token1', results[1].returnData)[0];
  if (token0.toLowerCase() !== BNB_CHAIN.wbnb.toLowerCase() && token1.toLowerCase() !== BNB_CHAIN.wbnb.toLowerCase()) continue;
  const reserves = pairInterface.decodeFunctionResult('getReserves', results[2].returnData);
  const wbnbReserve = token0.toLowerCase() === BNB_CHAIN.wbnb.toLowerCase() ? reserves[0] : reserves[1];
  if (wbnbReserve < minimumReserve) continue;
  liquid.push({ v2Pair: pairs[i], token: token0.toLowerCase() === BNB_CHAIN.wbnb.toLowerCase() ? token1 : token0, wbnbReserveWei: wbnbReserve.toString() });
}
liquid.sort((a, b) => BigInt(a.wbnbReserveWei) > BigInt(b.wbnbReserveWei) ? -1 : 1);
const top = liquid.slice(0, Number(process.env.BNB_SCAN_TOP || '1000'));
const fees = [100, 500, 3000, 10000];
const lookups = top.flatMap(pair => fees.map(fee => ({ ...pair, fee })));
const v3Results = await batch(lookups.map(route => ({ target: BNB_CHAIN.v3Factory, allowFailure: true, callData: v3Factory.encodeFunctionData('getPool', [BNB_CHAIN.wbnb, route.token, route.fee]) })));
const overlaps = [];
for (let i = 0; i < lookups.length; i++) {
  if (!v3Results[i].success) continue;
  const v3Pool = v3Factory.decodeFunctionResult('getPool', v3Results[i].returnData)[0];
  if (v3Pool !== ZeroAddress) overlaps.push({ ...lookups[i], v3Pool });
}
const liquidityResults = await batch(overlaps.map(route => ({ target: route.v3Pool, allowFailure: true, callData: liquidityInterface.encodeFunctionData('liquidity') })));
const active = overlaps.filter((_, i) => liquidityResults[i].success && liquidityInterface.decodeFunctionResult('liquidity', liquidityResults[i].returnData)[0] > 0n);
const sizes = config.sizes;
const gasCeilingWei = config.gasLimit * config.maxGasPriceWei;
const minNetProfitWei = config.minNetProfitWei;
const opportunities = [];
const quoteStats = { attempts: 0, valid: 0, rejected: 0, errors: 0, routeErrors: 0 };
const quoteBlock = await provider.getBlockNumber();
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < active.length) {
    const route = active[cursor++];
    for (const direction of ['V3-to-V2', 'V2-to-V3']) {
      try {
        const quotes = await quoteMixed(provider, { weth: BNB_CHAIN.wbnb, token: route.token, v2Pair: route.v2Pair, fee: route.fee, direction, sizes, gasCeilingWei, minNetProfitWei, quoterAddress: BNB_CHAIN.v3Quoter, stats: quoteStats, multicallAddress: BNB_CHAIN.multicall, blockTag: quoteBlock });
        if (quotes.length) opportunities.push({ token: route.token, v2Pair: route.v2Pair, v3Pool: route.v3Pool, fee: route.fee, direction, bestSizeWbnb: formatEther(quotes[0].amountIn), quotedNetFloorWbnb: formatEther(quotes[0].netFloor), wbnbReserve: formatEther(BigInt(route.wbnbReserveWei)) });
      } catch (error) {
        quoteStats.routeErrors++;
        quoteStats.lastError = String(error?.shortMessage ?? error?.message ?? error).slice(0, 180);
      }
    }
  }
}));
opportunities.sort((a, b) => Number(b.quotedNetFloorWbnb) - Number(a.quotedNetFloorWbnb));
if (active.length && !quoteStats.valid) throw new Error(`No valid BNB quotes across ${quoteStats.attempts} attempts; last error: ${quoteStats.lastError || 'none'}`);
const diagnostics = { attempts: quoteStats.attempts, valid: quoteStats.valid, rejected: quoteStats.rejected, errors: quoteStats.errors, routeErrors: quoteStats.routeErrors, bestNetFloorWbnb: quoteStats.bestNetFloorWei === undefined ? null : formatEther(quoteStats.bestNetFloorWei), minimumNetWbnb: formatEther(minNetProfitWei), lastError: quoteStats.lastError || null };
const result = { at: new Date().toISOString(), block: quoteBlock, allPairsLength, wbnbPairsWithLiquidity: liquid.length, v2PairsCheckedForV3: top.length, v3PoolsFound: overlaps.length, activeV3Pools: active.length, diagnostics, liquidV2Pairs: liquid, routes: active, opportunities };
mkdirSync('data', { recursive: true });
writeFileSync('data/bnb-routes.json.tmp', JSON.stringify(result, null, 2));
renameSync('data/bnb-routes.json.tmp', 'data/bnb-routes.json');
console.log(JSON.stringify({ block: result.block, allPairsLength, wbnbPairsWithLiquidity: liquid.length, v2PairsCheckedForV3: top.length, v3PoolsFound: overlaps.length, activeV3Pools: active.length, quotedOpportunities: opportunities.length, diagnostics, top: opportunities.slice(0, 10), savedTo: 'data/bnb-routes.json' }, null, 2));
console.log('Quotes are only leads; each route still needs a deployed executor eth_call before a trade.');
