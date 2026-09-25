import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from '../src/journal.js';

test('quotes and sent bundles never establish readiness', () => {
  const state = snapshot([{ type: 'candidate' }, { type: 'bundle_sent' }]);
  assert.equal(state.ready, false);
  assert.equal(state.proofCount, 0);
});

test('requires five distinct positive net Sepolia confirmations', () => {
  const trade = (chainId, netProfitWei, digit) => ({ type: 'confirmed', chainId, netProfitWei, txHash: `0x${digit.repeat(64)}` });
  const state = snapshot([trade(11155111, '12', '1'), trade(1, '20', '2'), trade(11155111, '-1', '3'), trade(11155111, '3', '4'), trade(11155111, '3', '5'), trade(11155111, '3', '6'), trade(11155111, '3', '7')]);
  assert.equal(state.ready, true);
  assert.equal(state.proofCount, 5);
  assert.equal(state.cumulativeNetWei, '23');
  assert.equal(snapshot([trade(11155111, '12', '1'), trade(11155111, '12', '1')]).ready, false);
  assert.equal(snapshot([trade(11155111, '12', '1'), trade(11155111, '3', '4'), trade(11155111, '3', '5'), trade(11155111, '3', '6')]).ready, false);
  assert.equal(snapshot([trade(11155111, '1', '1'), trade(11155111, '1', '2'), trade(11155111, '1', '3'), trade(11155111, '1', '4'), trade(11155111, '1', '5'), { type: 'receipt_failed', chainId: 11155111, txHash: `0x${'6'.repeat(64)}`, netProfitWei: '-6' }]).ready, false);
});
