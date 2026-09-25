import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { Contract, JsonRpcProvider, ZeroAddress, formatEther } from 'ethers';
import { hopState } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { getAmountOut } from '../src/math.js';

const config = loadConfig();
if (config.chainId !== 11155111) throw new Error('Expected Sepolia configuration');
const source = JSON.parse(readFileSync('data/uniswap-pools.json', 'utf8'));
const count = Number(process.env.V3_SCAN_TOP || '234');
if (!Number.isSafeInteger(count) || count < 1 || count > source.liquidPairs.length) throw new Error('Invalid V3_SCAN_TOP');
const v2Pairs = source.liquidPairs.slice(0, count);
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const factoryAddress = '0x0227628f3F023bb0B980b67D528571c95c6DaC1c';
const factory = new Contract(factoryAddress, ['function getPool(address,address,uint24) view returns(address)'], provider);
const multicall = new Contract('0xcA11bde05977b3631167028862bE2a173976CA11', [
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[])',
], provider);
const quoter = new Contract('0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3', [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
], provider);
const fees = [100, 500, 3000, 10000];
const lookups = v2Pairs.flatMap((pair, i) => fees.map(fee => ({ i, fee })));
const overlaps = [];
for (let offset = 0; offset < lookups.length; offset += 100) {
  const slice = lookups.slice(offset, offset + 100);
  const calls = slice.map(({ i, fee }) => ({
    target: factoryAddress, allowFailure: true,
    callData: factory.interface.encodeFunctionData('getPool', [config.weth, v2Pairs[i].token, fee]),
  }));
  const results = await multicall.aggregate3.staticCall(calls);
  for (let k = 0; k < results.length; k++) {
    if (!results[k].success) continue;
    const pool = factory.interface.decodeFunctionResult('getPool', results[k].returnData)[0];
    if (pool !== ZeroAddress) overlaps.push({ ...slice[k], pool });
  }
}
console.log(`Found ${overlaps.length} V3 pools for ${v2Pairs.length} liquid V2 WETH pairs`);
const opportunities = [];
let activePools = 0;
let cursor = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (cursor < overlaps.length) {
    const { i, fee, pool } = overlaps[cursor++];
    const v2 = v2Pairs[i];
    try {
      const v3 = new Contract(pool, ['function liquidity() view returns(uint128)'], provider);
      if ((await v3.liquidity()) === 0n) continue;
      activePools++;
      const [buyV2, sellV2] = await Promise.all([
        hopState(provider, v2.address, config.weth, v2.token),
        hopState(provider, v2.address, v2.token, config.weth),
      ]);
      for (const amountIn of config.sizes) {
        const gasCeiling = 600000n * config.maxFeePerGas;
        try {
          const tokenOut = getAmountOut(amountIn, buyV2.reserveIn, buyV2.reserveOut);
          if (tokenOut > 0n) {
            const quote = await quoter.quoteExactInputSingle.staticCall([v2.token, config.weth, tokenOut, fee, 0]);
            if (quote.gasEstimate <= 600000n && quote.sqrtPriceX96After > 4295128740n) {
              const netFloor = quote.amountOut - amountIn - gasCeiling;
              if (netFloor >= config.minNetProfitWei) opportunities.push({ direction: 'V2-to-V3', token: v2.token, v2Pair: v2.address, v3Pool: pool, fee, amountInWeth: formatEther(amountIn), quotedNetFloorWeth: formatEther(netFloor) });
            }
          }
        } catch { /* Pool may not support this quote. */ }
        try {
          const quote = await quoter.quoteExactInputSingle.staticCall([config.weth, v2.token, amountIn, fee, 0]);
          if (quote.gasEstimate > 600000n || quote.sqrtPriceX96After <= 4295128740n) continue;
          const wethOut = getAmountOut(quote.amountOut, sellV2.reserveIn, sellV2.reserveOut);
          const netFloor = wethOut - amountIn - gasCeiling;
          if (netFloor >= config.minNetProfitWei) opportunities.push({ direction: 'V3-to-V2', token: v2.token, v2Pair: v2.address, v3Pool: pool, fee, amountInWeth: formatEther(amountIn), quotedNetFloorWeth: formatEther(netFloor) });
        } catch { /* Pool may not support this quote. */ }
      }
    } catch { /* Ignore a failed pool read. */ }
  }
}));
opportunities.sort((a, b) => Number(b.quotedNetFloorWeth) - Number(a.quotedNetFloorWeth));
const result = { at: new Date().toISOString(), sourceBlock: source.to, v2PairsChecked: v2Pairs.length, v3PoolsFound: overlaps.length, activePools, opportunities };
writeFileSync('data/v3-overlap.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, opportunities: opportunities.slice(0, 20), totalOpportunities: opportunities.length }, null, 2));
console.log('Quoter output is not executable profit proof. Any candidate needs a contract simulation and confirmed receipt.');
