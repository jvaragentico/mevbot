import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, parseEther } from 'ethers';
import { executionGasBudget, privateAttemptExpired, privateBundle, privateRpc, selectQuoteScreens, submitPrivateBundle } from '../src/bnb-execution.js';

test('screening uses the exact submitted gas price and preserves the cap', () => {
  assert.equal(executionGasBudget(600000n, 50000000n, 200000000n), parseEther('0.00003'));
  assert.throws(() => executionGasBudget(600000n, 200000001n, 200000000n));
  assert.throws(() => executionGasBudget(600000n, 0n, 200000000n));
});

test('private bundles have expiry, no allowed reverts, and no disclosure', async () => {
  const wallet = Wallet.createRandom(); // Throwaway fixture, never a live key.
  const tx = { chainId: 56n, type: 0, to: '0x0000000000000000000000000000000000000001', value: 0n, gasPrice: 50000000n, gasLimit: 600000n, nonce: 0, data: '0x1234' };
  const raw = await wallet.signTransaction(tx);
  const bundle = privateBundle(raw, 104);
  assert.deepEqual(bundle.revertingTxHashes, []);
  assert.deepEqual(bundle.hint, {});
  assert.equal(bundle.maxBlockNumber, 104);
  const calls = [];
  const hash = '0x' + 'ab'.repeat(32);
  assert.equal(await submitPrivateBundle(raw, 104, async (...args) => { calls.push(args); return hash; }), hash);
  assert.deepEqual(calls, [['eth_sendMevBundle', [bundle]]]);
  await assert.rejects(submitPrivateBundle(raw, 104, async () => { throw new Error('timeout'); }), /timeout/);
  await assert.rejects(submitPrivateBundle(raw, 104, async () => undefined), /bundle hash/);
  assert.throws(() => privateBundle(raw, 0), /expiry/);
  assert.throws(() => privateBundle(raw, 104.5), /expiry/);
  assert.throws(() => privateBundle('0x', 104));
  for (const change of [{ chainId: 97n }, { value: 1n }]) {
    const invalid = await wallet.signTransaction({ ...tx, ...change });
    assert.throws(() => privateBundle(invalid, 104));
  }
});

test('uncertain private attempts wait for expiry and canonical nonce checks', () => {
  const sent = { submission: 'private_bundle', maxBlockNumber: 104, nonce: 3 };
  assert.equal(privateAttemptExpired(sent, 123, 3), false);
  assert.equal(privateAttemptExpired(sent, 124, 3), true);
  assert.equal(privateAttemptExpired(sent, 124, 4), false);
  assert.equal(privateAttemptExpired(sent, 124, 2), false);
  assert.equal(privateAttemptExpired({ ...sent, submission: 'public' }, 124, 3), false);
  assert.equal(privateAttemptExpired({ ...sent, maxBlockNumber: undefined }, 124, 3), false);
});

test('recurring false upper bounds cannot starve lower-ranked screens', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => i);
  const visited = new Set();
  let cursor = 0;
  for (let tick = 0; tick < 4; tick++) {
    const selection = selectQuoteScreens(candidates, cursor);
    assert.equal(selection.selected[0], 0);
    assert.equal(new Set(selection.selected).size, 4);
    selection.selected.forEach(value => visited.add(value));
    cursor = selection.cursor;
  }
  assert.equal(visited.size, candidates.length);
});

test('private RPC rejects HTTP, JSON-RPC, and malformed responses', async () => {
  const original = globalThis.fetch;
  try {
    for (const body of [{ error: { message: 'rejected' } }, { jsonerror: { message: 'rejected' } }, { jsonrpc: '2.0', id: 1 }]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => body });
      await assert.rejects(privateRpc('eth_chainId', []));
    }
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(privateRpc('eth_chainId', []), /503/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x38' }) });
    assert.equal(await privateRpc('eth_chainId', []), '0x38');
    await assert.rejects(privateRpc('eth_chainId', [], 'http://example.test'), /HTTPS/);
  } finally { globalThis.fetch = original; }
});
