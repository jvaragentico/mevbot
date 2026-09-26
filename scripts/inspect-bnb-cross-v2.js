import { readFileSync } from 'node:fs';
import { Contract, Interface, JsonRpcProvider, ZeroAddress, formatEther, parseEther, parseUnits } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';

// Read-only scout. This does not authorize the live executor to use PancakeSwap.
const PANCAKE_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const provider = new JsonRpcProvider(process.env.BNB_SCAN_RPC_URL || BNB_CHAIN.rpc, undefined, { batchMaxCount: 1 });
if ((await provider.getNetwork()).chainId !== BNB_CHAIN.chainId) throw new Error('Expected BNB Smart Chain');
const source = JSON.parse(readFileSync('data/bnb-routes.json', 'utf8'));
const unique = [...new Map((source.liquidV2Pairs || source.routes).map(route => [route.token.toLowerCase(), route])).values()];
const factory = new Interface(['function getPair(address,address) view returns(address)']);
const pair = new Interface(['function token0() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)']);
const multicall = new Contract(BNB_CHAIN.multicall, ['function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[])'], provider);
async function batch(calls) {
  const result = [];
  for (let i = 0; i < calls.length; i += 100) result.push(...await multicall.aggregate3.staticCall(calls.slice(i, i + 100)));
  return result;
}
const lookups = await batch(unique.map(route => ({ target: PANCAKE_V2_FACTORY, allowFailure: true, callData: factory.encodeFunctionData('getPair', [BNB_CHAIN.wbnb, route.token]) })));
const overlaps = unique.flatMap((route, i) => {
  if (!lookups[i].success) return [];
  const cakePair = factory.decodeFunctionResult('getPair', lookups[i].returnData)[0];
  return cakePair === ZeroAddress ? [] : [{ ...route, cakePair }];
});
const states = await batch(overlaps.flatMap(route => [route.v2Pair, route.cakePair].flatMap(address => ['token0', 'getReserves'].map(method => ({ target: address, allowFailure: true, callData: pair.encodeFunctionData(method) })))));
const sizes = ['0.0001', '0.0005', '0.001', '0.005', '0.01'].map(value => parseEther(value));
const gasCeiling = 600000n * parseUnits('0.2', 'gwei');
function out(amount, reserveIn, reserveOut, feeNumerator, denominator) {
  const net = amount * feeNumerator;
  return net * reserveOut / (reserveIn * denominator + net);
}
function reserves(items, address) {
  if (items.some(item => !item.success)) return null;
  const token0 = pair.decodeFunctionResult('token0', items[0].returnData)[0];
  const [r0, r1] = pair.decodeFunctionResult('getReserves', items[1].returnData);
  const wbnbFirst = token0.toLowerCase() === BNB_CHAIN.wbnb.toLowerCase();
  return { wbnb: wbnbFirst ? r0 : r1, token: wbnbFirst ? r1 : r0, address };
}
const results = [];
let usable = 0;
let lowLiquiditySkipped = 0;
for (let i = 0; i < overlaps.length; i++) {
  const route = overlaps[i];
  const uni = reserves(states.slice(i * 4, i * 4 + 2), route.v2Pair);
  const cake = reserves(states.slice(i * 4 + 2, i * 4 + 4), route.cakePair);
  if (!uni || !cake || !uni.wbnb || !uni.token || !cake.wbnb || !cake.token) continue;
  if (uni.wbnb < parseEther('0.05') || cake.wbnb < parseEther('0.05')) { lowLiquiditySkipped++; continue; }
  usable++;
  for (const direction of ['Uni-to-Pancake', 'Pancake-to-Uni']) {
    for (const amountIn of sizes) {
      const buy = direction === 'Uni-to-Pancake' ? uni : cake;
      const sell = direction === 'Uni-to-Pancake' ? cake : uni;
      const buyFee = direction === 'Uni-to-Pancake' ? [997n, 1000n] : [9975n, 10000n];
      const sellFee = direction === 'Uni-to-Pancake' ? [9975n, 10000n] : [997n, 1000n];
      const tokenOut = out(amountIn, buy.wbnb, buy.token, ...buyFee);
      const wbnbOut = out(tokenOut, sell.token, sell.wbnb, ...sellFee);
      results.push({ token: route.token, uniPair: uni.address, cakePair: cake.address, uniWbnbReserve: formatEther(uni.wbnb), cakeWbnbReserve: formatEther(cake.wbnb), direction, sizeWbnb: formatEther(amountIn), grossWbnb: formatEther(wbnbOut - amountIn), netFloorWbnb: formatEther(wbnbOut - amountIn - gasCeiling) });
    }
  }
}
results.sort((a, b) => Number(b.netFloorWbnb) - Number(a.netFloorWbnb));
console.log(JSON.stringify({ uniqueTokens: unique.length, pancakePairs: overlaps.length, lowLiquiditySkipped, usablePairs: usable, quotedRoutes: results.length, positiveNetFloorCount: results.filter(result => Number(result.netFloorWbnb) > 0).length, qualifyingAtCurrentFloor: results.filter(result => Number(result.netFloorWbnb) >= 0.00005).length, best: results.slice(0, 15) }, null, 2));
