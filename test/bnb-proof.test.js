import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { localDay, verifyBnbExecution } from '../src/bnb-proof.js';

test('mainnet proof uses canonical receipts and wallet transfers after gas', () => {
  const address = '0x0000000000000000000000000000000000000001';
  const executor = '0x0000000000000000000000000000000000000002';
  const wbnb = '0x0000000000000000000000000000000000000003';
  const event = new Interface(['event VerifiedMixedExecuted(address indexed token,address indexed v2Pair,uint24 fee,uint8 direction,uint256 amountIn,uint256 grossProfit)']);
  const erc20 = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log = (iface, name, args, source) => ({ address: source, ...iface.encodeEventLog(iface.getEvent(name), args) });
  const transaction = { chainId: 56n, hash: '0xabc', from: address, to: executor, value: 0n };
  const receipt = { status: 1, hash: '0xabc', blockHash: '0xdef', blockNumber: 100, gasUsed: 100n, gasPrice: 2n, logs: [
    log(event, 'VerifiedMixedExecuted', [address, executor, 500, 0, 1000n, 300n], executor),
    log(erc20, 'Transfer', [address, executor, 1000n], wbnb),
    log(erc20, 'Transfer', [executor, address, 1300n], wbnb),
  ] };
  const args = { transaction, receipt, block: { number: 100, hash: '0xdef', timestamp: 1790370000 }, head: 119, address, executor, wbnb, day: localDay(1790370000) };
  assert.equal(verifyBnbExecution(args).netProfitWei, '100');
  assert.throws(() => verifyBnbExecution({ ...args, transaction: { ...transaction, chainId: 97n } }), /Unexpected/);
  assert.throws(() => verifyBnbExecution({ ...args, receipt: { ...receipt, gasPrice: 4n } }), /not profitable/);
  assert.throws(() => verifyBnbExecution({ ...args, receipt: { ...receipt, logs: receipt.logs.slice(0, 2) } }), /does not match/);
  assert.throws(() => verifyBnbExecution({ ...args, head: 101 }), /confirmations/);
  assert.throws(() => verifyBnbExecution({ ...args, day: '2026-09-25' }), /target day/);
});
test('target dates use the user timezone across UTC midnight boundaries', () => {
  assert.equal(localDay(Date.parse('2026-09-25T18:00:00Z') / 1000), '2026-09-26');
});
