import { Contract, Interface } from 'ethers';

const Q192 = 1n << 192n;
const pair = new Interface(['function token0() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)']);
const pool = new Interface(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)']);
const MULTICALL_ABI = ['function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[])'];

// Both pool curves move against the swap. Their fee-adjusted marginal rate is
// therefore an upper bound on output for any positive input, before slippage.
export function mixedUpperBound({ amountIn, reserveWeth, reserveToken, sqrtPriceX96, wethIsV3Token0, fee, direction }) {
  if (!['V3-to-V2', 'V2-to-V3'].includes(direction)) throw new Error('Invalid mixed direction');
  if (amountIn <= 0n || reserveWeth <= 0n || reserveToken <= 0n || sqrtPriceX96 <= 0n || fee <= 0 || fee >= 1_000_000) return null;
  const square = sqrtPriceX96 * sqrtPriceX96;
  const buyV3 = direction === 'V3-to-V2';
  const v3Forward = buyV3 === wethIsV3Token0;
  const v3Num = v3Forward ? square : Q192;
  const v3Den = v3Forward ? Q192 : square;
  const v2Num = buyV3 ? reserveWeth : reserveToken;
  const v2Den = buyV3 ? reserveToken : reserveWeth;
  const numerator = v3Num * v2Num * 997n * (1_000_000n - BigInt(fee));
  const denominator = v3Den * v2Den * 1000n * 1_000_000n;
  // Round up: the screen must not reject an opportunity due to integer rounding.
  const maxOutput = (amountIn * numerator + denominator - 1n) / denominator;
  return maxOutput - amountIn;
}

export async function screenMixedRoutes(provider, { routes, weth, multicallAddress, maxAmountIn, gasCeilingWei, minNetProfitWei, blockTag }) {
  const multicall = new Contract(multicallAddress, MULTICALL_ABI, provider);
  const calls = routes.flatMap(route => [
    { target: route.v2Pair, allowFailure: true, callData: pair.encodeFunctionData('token0') },
    { target: route.v2Pair, allowFailure: true, callData: pair.encodeFunctionData('getReserves') },
    { target: route.v3Pool, allowFailure: true, callData: pool.encodeFunctionData('slot0') },
  ]);
  const results = [];
  for (let i = 0; i < calls.length; i += 120) results.push(...await multicall.aggregate3.staticCall(calls.slice(i, i + 120), { blockTag }));
  const candidates = [];
  let invalidRoutes = 0;
  let bestUpperNetWei = null;
  for (let i = 0; i < routes.length; i++) {
    const state = results.slice(i * 3, i * 3 + 3);
    if (state.some(item => !item.success)) { invalidRoutes++; continue; }
    try {
      const route = routes[i];
      const token0 = pair.decodeFunctionResult('token0', state[0].returnData)[0];
      const [r0, r1] = pair.decodeFunctionResult('getReserves', state[1].returnData);
      const [sqrtPriceX96,,,,,, unlocked] = pool.decodeFunctionResult('slot0', state[2].returnData);
      if (!r0 || !r1 || !sqrtPriceX96 || !unlocked) { invalidRoutes++; continue; }
      const wethFirst = token0.toLowerCase() === weth.toLowerCase();
      const reserveWeth = wethFirst ? r0 : r1;
      const reserveToken = wethFirst ? r1 : r0;
      const wethIsV3Token0 = BigInt(weth) < BigInt(route.token);
      for (const direction of ['V3-to-V2', 'V2-to-V3']) {
        const upperGrossWei = mixedUpperBound({ amountIn: maxAmountIn, reserveWeth, reserveToken, sqrtPriceX96, wethIsV3Token0, fee: route.fee, direction });
        if (upperGrossWei === null) continue;
        const upperNetWei = upperGrossWei - gasCeilingWei;
        if (bestUpperNetWei === null || upperNetWei > bestUpperNetWei) bestUpperNetWei = upperNetWei;
        if (upperNetWei >= minNetProfitWei) candidates.push({ route, direction, upperGrossWei, upperNetWei });
      }
    } catch { invalidRoutes++; }
  }
  candidates.sort((a, b) => a.upperNetWei > b.upperNetWei ? -1 : a.upperNetWei < b.upperNetWei ? 1 : 0);
  return { candidates, invalidRoutes, directionsScreened: (routes.length - invalidRoutes) * 2, bestUpperNetWei };
}
