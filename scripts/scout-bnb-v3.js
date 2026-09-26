import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Contract, FetchRequest, Interface, JsonRpcProvider, ZeroAddress, formatEther, parseEther } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { loadBnbConfig } from '../src/bnb-config.js';
import { V3_QUOTER_ABI } from '../src/mixed.js';

// Read-only cross-pool discovery. No signer, approvals, flash borrowing, or
// deployments. A quote is only a lead for an executor simulation.
const config = loadBnbConfig();
const request = new FetchRequest(process.env.SCOUT_RPC_URL || config.rpcUrl);
request.timeout = 10000;
const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
const dexes = [
  { name: 'uniswap', factory: BNB_CHAIN.v3Factory, quoter: BNB_CHAIN.v3Quoter, fees: [100, 500, 3000, 10000] },
  { name: 'pancake', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', fees: [100, 500, 2500, 10000] },
];
const factory = new Interface(['function getPool(address,address,uint24) view returns(address)']);
const pool = new Interface(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)', 'function liquidity() view returns(uint128)']);
const quote = new Interface(V3_QUOTER_ABI);
const multicall = new Contract(BNB_CHAIN.multicall, ['function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[])'], provider);
const Q192 = 1n << 192n;
const lower = 4295128740n;
const upper = 1461446703485210103287273052203988822378723970341n;
const start = Date.now();
let block;
let batchErrors = 0;
async function callBatch(calls) {
  try { return [...await multicall.aggregate3.staticCall(calls, { blockTag: block })]; }
  catch (error) {
    batchErrors++;
    const reason = String(error.info?.error?.message || error.shortMessage || error.message);
    if (/missing trie|historical|header not found|timeout|rate limit|429/i.test(reason)) throw new Error(`Pinned-block RPC scan is incomplete: ${reason.slice(0, 160)}`);
    // Some large tick-crossing quotes exhaust the whole Multicall gas budget.
    // Isolate them rather than interpreting a failed batch as no opportunities.
    if (calls.length === 1) return [{ success: false, returnData: '0x' }];
    const mid = Math.floor(calls.length / 2);
    return [...await callBatch(calls.slice(0, mid)), ...await callBatch(calls.slice(mid))];
  }
}
async function batch(calls, chunk = 80) {
  const result = [];
  for (let i = 0; i < calls.length; i += chunk) result.push(...await callBatch(calls.slice(i, i + chunk)));
  return result;
}
function quoteCalls(entries, input, output) {
  return entries.map(entry => ({ target: entry.pool.quoter, allowFailure: true, callData: quote.encodeFunctionData('quoteExactInputSingle', [[input(entry), output(entry), entry.amountIn, entry.pool.fee, 0]]) }));
}
function decodeQuote(result) {
  if (!result.success) return { error: true };
  try {
    const value = quote.decodeFunctionResult('quoteExactInputSingle', result.returnData);
    if (value.sqrtPriceX96After <= lower || value.sqrtPriceX96After >= upper || value.gasEstimate > 350000n || value.amountOut === 0n) return { filtered: true };
    return { amountOut: value.amountOut, gas: value.gasEstimate };
  } catch { return { error: true }; }
}
try {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Expected BNB mainnet');
  const gasPrice = (await provider.getFeeData()).gasPrice;
  if (!gasPrice || gasPrice > config.maxGasPriceWei) throw new Error('Gas price is outside the live cap');
  const gasCeilingWei = config.gasLimit * gasPrice;
  const sizes = (process.env.SCOUT_TRADE_SIZES_NATIVE || '0.000001,0.001,0.01,0.015').split(',').map(value => parseEther(value.trim()));
  if (sizes.some(size => size <= 0n)) throw new Error('Positive scout sizes required');
  const maxInput = sizes.reduce((a, b) => a > b ? a : b);
  const source = await fetch('https://raw.githubusercontent.com/pancakeswap/token-list/main/lists/pancakeswap-extended.json', { signal: AbortSignal.timeout(20000) });
  if (!source.ok) throw new Error(`Token list HTTP ${source.status}`);
  const tokens = (await source.json()).tokens.filter(token => token.chainId === 56 && token.address.toLowerCase() !== BNB_CHAIN.wbnb.toLowerCase());
  const saved = JSON.parse(readFileSync('data/bnb-routes.json', 'utf8'));
  tokens.push(...saved.liquidV2Pairs.map(route => ({ address: route.token, symbol: route.token.slice(0, 10) })));
  const unique = [...new Map(tokens.map(token => [token.address.toLowerCase(), token])).values()];
  block = await provider.getBlockNumber();
  const lookups = unique.flatMap(token => dexes.flatMap(dex => dex.fees.map(fee => ({ token: token.address, symbol: token.symbol, dex: dex.name, quoter: dex.quoter, factory: dex.factory, fee }))));
  const found = await batch(lookups.map(entry => ({ target: entry.factory, allowFailure: true, callData: factory.encodeFunctionData('getPool', [BNB_CHAIN.wbnb, entry.token, entry.fee]) })));
  const pools = lookups.flatMap((entry, i) => {
    if (!found[i].success) return [];
    const address = factory.decodeFunctionResult('getPool', found[i].returnData)[0];
    return address === ZeroAddress ? [] : [{ ...entry, address }];
  });
  // Factory discovery can be slow; start the state/quote snapshot here, so a
  // non-archive RPC has more time before it prunes this state.
  block = await provider.getBlockNumber();
  const states = await batch(pools.flatMap(entry => ['slot0', 'liquidity'].map(method => ({ target: entry.address, allowFailure: true, callData: pool.encodeFunctionData(method) }))));
  const active = pools.flatMap((entry, i) => {
    if (!states[i * 2].success || !states[i * 2 + 1].success) return [];
    const [sqrt,,,,,, unlocked] = pool.decodeFunctionResult('slot0', states[i * 2].returnData);
    const [liquidity] = pool.decodeFunctionResult('liquidity', states[i * 2 + 1].returnData);
    if (!liquidity || !unlocked || sqrt <= lower || sqrt >= upper) return [];
    const wethFirst = BigInt(BNB_CHAIN.wbnb) < BigInt(entry.token);
    return [{ ...entry, rateNum: wethFirst ? sqrt * sqrt : Q192, rateDen: wethFirst ? Q192 : sqrt * sqrt }];
  });
  const groups = new Map();
  for (const entry of active) {
    const group = groups.get(entry.token.toLowerCase()) || [];
    group.push(entry);
    groups.set(entry.token.toLowerCase(), group);
  }
  let directions = 0;
  const leads = [];
  for (const group of groups.values()) for (const buy of group) for (const sell of group) {
    if (buy.address.toLowerCase() === sell.address.toLowerCase()) continue;
    directions++;
    const num = buy.rateNum * sell.rateDen * BigInt(1000000 - buy.fee) * BigInt(1000000 - sell.fee);
    const den = buy.rateDen * sell.rateNum * 1000000000000n;
    const grossUpper = (maxInput * num + den - 1n) / den - maxInput;
    if (grossUpper - gasCeilingWei >= config.minNetProfitWei) leads.push({ buy, sell });
  }
  const buys = [...new Map(leads.map(route => [route.buy.address, route.buy])).values()];
  console.log(JSON.stringify({ phase: 'discovery', block, activePools: active.length, directions, upperBoundLeads: leads.length, buyPoolsToQuote: buys.length }));
  const buyEntries = buys.flatMap(entry => sizes.map(amountIn => ({ pool: entry, amountIn })));
  const buyResults = (await batch(quoteCalls(buyEntries, () => BNB_CHAIN.wbnb, entry => entry.pool.token), 8)).map(decodeQuote);
  const byBuy = new Map();
  buyEntries.forEach((entry, i) => byBuy.set(`${entry.pool.address}:${entry.amountIn}`, buyResults[i]));
  const sells = leads.flatMap(route => sizes.flatMap(amount => {
    const first = byBuy.get(`${route.buy.address}:${amount}`);
    return first?.amountOut ? [{ route, originalInput: amount, first, pool: route.sell, amountIn: first.amountOut }] : [];
  }));
  const sellResults = (await batch(quoteCalls(sells, entry => entry.pool.token, () => BNB_CHAIN.wbnb), 8)).map(decodeQuote);
  let best = null;
  const qualified = [];
  sells.forEach((entry, i) => {
    const second = sellResults[i];
    if (!second.amountOut || entry.first.gas + second.gas > config.gasLimit) return;
    const gross = second.amountOut - entry.originalInput;
    const net = gross - gasCeilingWei;
    const result = { token: entry.pool.token, symbol: entry.pool.symbol, buyDex: entry.route.buy.dex, buyPool: entry.route.buy.address, buyFee: entry.route.buy.fee, sellDex: entry.pool.dex, sellPool: entry.pool.address, sellFee: entry.pool.fee, inputWbnb: formatEther(entry.originalInput), grossWbnb: formatEther(gross), quotedNetWbnb: formatEther(net), quoterGasSum: String(entry.first.gas + second.gas) };
    if (!best || net > best.net) best = { net, result };
    if (net >= config.minNetProfitWei) qualified.push(result);
  });
  const allQuotes = [...buyResults, ...sellResults];
  const result = { at: new Date().toISOString(), block, chainId: 56, tokens: unique.length, activePools: active.length, screenedDirections: directions, upperBoundLeads: leads.length, sizes: sizes.map(formatEther), quoteCalls: allQuotes.length, batchErrors, quoteErrors: allQuotes.filter(item => item.error).length, filteredQuotes: allQuotes.filter(item => item.filtered).length, gasCeilingWbnb: formatEther(gasCeilingWei), minimumNetWbnb: formatEther(config.minNetProfitWei), durationMs: Date.now() - start, best: best?.result || null, qualified, note: 'Quotes are not execution or profit. Failed calls are unknown, not negative quotes. The live executor does not support V3-to-V3; large inputs require additional capital or a tested flash-credit executor. No wallet transactions were submitted.' };
  mkdirSync('data/scouts', { recursive: true });
  writeFileSync('data/scouts/bnb-v3.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ at: new Date().toISOString(), incomplete: true, reason: String(error.shortMessage || error.message).slice(0, 180) }));
  process.exitCode = 1;
} finally { provider.destroy(); }
