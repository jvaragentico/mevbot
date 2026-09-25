import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWalletStop, parseUsd8, usd8FromBnbWei } from '../src/bnb-risk.js';

test('wallet stop counts BNB price movement and gas against the fixed USD baseline', () => {
  const baselineUsd8 = parseUsd8('22');
  const limitUsd8 = parseUsd8('15');
  const before = assessWalletStop({ baselineUsd8, currentUsd8: parseUsd8('7.25'), limitUsd8, pendingGasUsd8: parseUsd8('0.30') });
  assert.equal(before.stopped, false);
  assert.equal(before.maySend, false);
  assert.equal(before.remainingUsd8, parseUsd8('0.25'));
  const atLimit = assessWalletStop({ baselineUsd8, currentUsd8: parseUsd8('7'), limitUsd8 });
  assert.equal(atLimit.stopped, true);
  assert.equal(atLimit.maySend, false);
  const recovered = assessWalletStop({ baselineUsd8, currentUsd8: parseUsd8('20'), limitUsd8, latched: true });
  assert.equal(recovered.maySend, false);
  assert.equal(usd8FromBnbWei(1000000000000000000n, parseUsd8('780')), parseUsd8('780'));
});
