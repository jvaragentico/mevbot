import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'ethers';
import { getAmountOut } from '../src/math.js';
import { mixedUpperBound } from '../src/mixed-screen.js';

const Q96 = 1n << 96n;
test('PancakeSwap fee-aware upper bound matches marginal product', () => {
  const amountIn = parseEther('1');
  const result = mixedUpperBound({ amountIn, reserveWeth: amountIn, reserveToken: amountIn, sqrtPriceX96: Q96, wethIsV3Token0: true, fee: 500, direction: 'V3-to-V2', v2FeeNumerator: 9975n, v2FeeDenominator: 10000n });
  assert.equal(result, amountIn * 9975n * 999500n / (10000n * 1000000n) - amountIn);
});
test('mixed screen rejects an equal-price route after both pool fees', () => {
  for (const direction of ['V3-to-V2', 'V2-to-V3']) {
    const result = mixedUpperBound({ amountIn: parseEther('0.01'), reserveWeth: parseEther('100'), reserveToken: parseEther('100'), sqrtPriceX96: Q96, wethIsV3Token0: true, fee: 500, direction });
    assert.ok(result < 0n);
  }
});
test('spot upper bound exceeds attainable curve profit for both token orderings', () => {
  for (const amountIn of ['0.0001', '0.01', '1'].map(parseEther)) {
    const v3In = parseEther('100');
    const v3Out = parseEther('400');
    const tokenOut = amountIn * 9995n * v3Out / (v3In * 10000n + amountIn * 9995n);
    const actualProfit = getAmountOut(tokenOut, parseEther('100'), parseEther('30')) - amountIn;
    const common = { amountIn, reserveWeth: parseEther('30'), reserveToken: parseEther('100'), fee: 500, direction: 'V3-to-V2' };
    const forward = mixedUpperBound({ ...common, sqrtPriceX96: Q96 * 2n, wethIsV3Token0: true });
    const inverse = mixedUpperBound({ ...common, sqrtPriceX96: Q96 / 2n, wethIsV3Token0: false });
    assert.equal(forward, inverse);
    assert.ok(forward >= actualProfit);
    assert.ok(forward > 0n);
  }
});
