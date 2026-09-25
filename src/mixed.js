import { Contract } from 'ethers';
import { hopState } from './chain.js';
import { getAmountOut } from './math.js';

export const MIXED_ABI = [
  'function owner() view returns(address)',
  'function weth() view returns(address)',
  'function token() view returns(address)',
  'function v2Pair() view returns(address)',
  'function v3Router() view returns(address)',
  'function v3Fee() view returns(uint24)',
  'function executeV3ToV2(uint256,uint256) returns(uint256)',
  'function executeV2ToV3(uint256,uint256) returns(uint256)',
  'error NotProfitable()',
  'event MixedRouteExecuted(uint8 indexed direction,uint256 amountIn,uint256 grossProfit)',
];

export const V3_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

const MIN_SQRT_PLUS_ONE = 4295128740n;
const MAX_SQRT_MINUS_ONE = 1461446703485210103287273052203988822378723970341n;

export async function quoteMixed(provider, { weth, token, v2Pair, fee, direction, sizes, gasCeilingWei, minNetProfitWei, quoterAddress = '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3' }) {
  const quoter = new Contract(quoterAddress, V3_QUOTER_ABI, provider);
  const v2 = await hopState(provider, v2Pair, direction === 'V3-to-V2' ? token : weth, direction === 'V3-to-V2' ? weth : token);
  const candidates = [];
  for (const amountIn of sizes) {
    try {
      let amountOut, v3Gas;
      if (direction === 'V3-to-V2') {
        const quote = await quoter.quoteExactInputSingle.staticCall([weth, token, amountIn, fee, 0]);
        if (quote.sqrtPriceX96After <= MIN_SQRT_PLUS_ONE || quote.sqrtPriceX96After >= MAX_SQRT_MINUS_ONE || quote.gasEstimate > 350000n) continue;
        amountOut = getAmountOut(quote.amountOut, v2.reserveIn, v2.reserveOut);
        v3Gas = quote.gasEstimate;
      } else {
        const tokenOut = getAmountOut(amountIn, v2.reserveIn, v2.reserveOut);
        const quote = await quoter.quoteExactInputSingle.staticCall([token, weth, tokenOut, fee, 0]);
        if (quote.sqrtPriceX96After <= MIN_SQRT_PLUS_ONE || quote.sqrtPriceX96After >= MAX_SQRT_MINUS_ONE || quote.gasEstimate > 350000n) continue;
        amountOut = quote.amountOut;
        v3Gas = quote.gasEstimate;
      }
      const grossProfit = amountOut - amountIn;
      const netFloor = grossProfit - gasCeilingWei;
      if (netFloor >= minNetProfitWei) candidates.push({ amountIn, amountOut, grossProfit, netFloor, v3Gas });
    } catch { /* A revert or empty pool is not a candidate. */ }
  }
  candidates.sort((a, b) => a.netFloor > b.netFloor ? -1 : a.netFloor < b.netFloor ? 1 : 0);
  return candidates;
}
