import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, parseEther } from 'ethers';
import { isRelatedToPair, postReservesFromHints } from '../src/chain.js';

const pair = '0x0000000000000000000000000000000000000001';
const weth = '0x0000000000000000000000000000000000000002';
const token = '0x0000000000000000000000000000000000000003';

test('matches pool address without case sensitivity', () => {
  assert.equal(isRelatedToPair({ hash: '0xabc', logs: [{ address: pair.toUpperCase() }] }, pair), true);
  assert.equal(isRelatedToPair({ hash: '0xabc', txs: [{ to: pair.toUpperCase() }] }, pair), true);
  assert.equal(isRelatedToPair({ to: '0x0000000000000000000000000000000000000004' }, pair), false);
});

test('uses last full Sync hint as post-victim reserves', () => {
  const iface = new Interface(['event Sync(uint112 reserve0,uint112 reserve1)']);
  const first = iface.encodeEventLog(iface.getEvent('Sync'), [parseEther('10'), parseEther('30000')]);
  const last = iface.encodeEventLog(iface.getEvent('Sync'), [parseEther('9'), parseEther('33000')]);
  const pending = { logs: [{ address: pair, ...first }, { address: pair, ...last }] };
  const state = postReservesFromHints(pending, pair, weth, weth, token);
  assert.equal(state.weth, parseEther('9'));
  assert.equal(state.token, parseEther('33000'));
  assert.equal(postReservesFromHints({ logs: [{ address: pair, data: '0x', topics: last.topics }] }, pair, weth, weth, token), null);
});
