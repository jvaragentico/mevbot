import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'ethers';
import { confirmedNetProfit, getAmountOut, quoteRoundTrip, quoteRoute, selectOpportunity, selectRouteOpportunity } from '../src/math.js';

test('constant product quote includes both 0.30% pool fees', () => {
  assert.equal(getAmountOut(1_000n, 10_000n, 10_000n), 906n);
  const same = quoteRoundTrip(1_000n, { weth: 10_000n, token: 10_000n }, { weth: 10_000n, token: 10_000n });
  assert.ok(same.grossProfit < 0n);
});

test('selects only size that remains profitable after maximum execution gas', () => {
  const buy = { weth: parseEther('10'), token: parseEther('30000') };
  const sell = { weth: parseEther('12'), token: parseEther('30000') };
  const sizes = [parseEther('0.01'), parseEther('0.1'), parseEther('1')];
  const result = selectOpportunity(sizes, buy, sell, parseEther('0.002'), parseEther('0.001'));
  assert.ok(result);
  assert.ok(result.netFloor >= parseEther('0.001'));
  assert.equal(selectOpportunity(sizes, buy, sell, parseEther('1'), parseEther('0.001')), null);
});

test('confirmed net includes actual gas paid', () => {
  assert.equal(confirmedNetProfit(1_000_000n, 10n, 100n), 999_000n);
  assert.equal(confirmedNetProfit(100n, 10n, 100n), -900n);
});

test('three-hop cycle selection accounts for each pair fee and gas cap', () => {
  const hops = [
    { reserveIn: parseEther('3'), reserveOut: parseEther('30000') },
    { reserveIn: parseEther('10000'), reserveOut: parseEther('100000') },
    { reserveIn: parseEther('100000'), reserveOut: parseEther('100') },
  ];
  const amount = parseEther('0.01');
  assert.ok(quoteRoute(amount, hops).grossProfit > 0n);
  assert.ok(selectRouteOpportunity([amount], hops, parseEther('0.001'), parseEther('0.01')));
});
