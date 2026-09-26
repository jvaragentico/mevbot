import { Contract, Interface } from 'ethers';
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

export async function quoteMixed(provider, { weth, token, v2Pair, fee, direction, sizes, gasCeilingWei, minNetProfitWei, quoterAddress = '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3', stats, blockTag, multicallAddress, v2FeeNumerator = 997n, v2FeeDenominator = 1000n }) {
  const v2Out = (amount, state) => getAmountOut(amount, state.reserveIn, state.reserveOut, v2FeeNumerator, v2FeeDenominator);
  const quoter = new Contract(quoterAddress, V3_QUOTER_ABI, provider);
  const overrides = blockTag === undefined ? {} : { blockTag };
  const v2 = await hopState(provider, v2Pair, direction === 'V3-to-V2' ? token : weth, direction === 'V3-to-V2' ? weth : token, overrides);
  let batchResults;
  const quoteInterface = new Interface(V3_QUOTER_ABI);
  if (multicallAddress) {
    const multicall = new Contract(multicallAddress, ['function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[])'], provider);
    const calls = sizes.map(amountIn => {
      const args = direction === 'V3-to-V2' ? [weth, token, amountIn, fee, 0] : [token, weth, v2Out(amountIn, v2), fee, 0];
      return { target: quoterAddress, allowFailure: true, callData: quoteInterface.encodeFunctionData('quoteExactInputSingle', [args]) };
    });
    batchResults = await multicall.aggregate3.staticCall(calls, overrides);
  }
  async function readQuote(index, args) {
    if (!batchResults) return quoter.quoteExactInputSingle.staticCall(args, overrides);
    if (!batchResults[index].success) throw new Error('V3 quote reverted');
    return quoteInterface.decodeFunctionResult('quoteExactInputSingle', batchResults[index].returnData);
  }
  const candidates = [];
  for (let index = 0; index < sizes.length; index++) {
    const amountIn = sizes[index];
    if (stats) stats.attempts = (stats.attempts || 0) + 1;
    try {
      let amountOut, v3Gas;
      if (direction === 'V3-to-V2') {
        const quote = await readQuote(index, [weth, token, amountIn, fee, 0]);
        if (quote.sqrtPriceX96After <= MIN_SQRT_PLUS_ONE || quote.sqrtPriceX96After >= MAX_SQRT_MINUS_ONE || quote.gasEstimate > 350000n) {
          if (stats) stats.rejected = (stats.rejected || 0) + 1;
          continue;
        }
        amountOut = v2Out(quote.amountOut, v2);
        v3Gas = quote.gasEstimate;
      } else {
        const tokenOut = v2Out(amountIn, v2);
        const quote = await readQuote(index, [token, weth, tokenOut, fee, 0]);
        if (quote.sqrtPriceX96After <= MIN_SQRT_PLUS_ONE || quote.sqrtPriceX96After >= MAX_SQRT_MINUS_ONE || quote.gasEstimate > 350000n) {
          if (stats) stats.rejected = (stats.rejected || 0) + 1;
          continue;
        }
        amountOut = quote.amountOut;
        v3Gas = quote.gasEstimate;
      }
      const grossProfit = amountOut - amountIn;
      const netFloor = grossProfit - gasCeilingWei;
      if (stats) {
        stats.valid = (stats.valid || 0) + 1;
        if (stats.bestNetFloorWei === undefined || netFloor > stats.bestNetFloorWei) stats.bestNetFloorWei = netFloor;
      }
      if (netFloor >= minNetProfitWei) candidates.push({ amountIn, amountOut, grossProfit, netFloor, v3Gas });
    } catch (error) {
      if (stats) {
        stats.errors = (stats.errors || 0) + 1;
        stats.lastError = String(error?.shortMessage ?? error?.message ?? error).slice(0, 180);
      }
      // A reverted quote is not a candidate; diagnostics keep it visible.
    }
  }
  candidates.sort((a, b) => a.netFloor > b.netFloor ? -1 : a.netFloor < b.netFloor ? 1 : 0);
  return candidates;
}
