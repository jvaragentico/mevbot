import { Transaction } from 'ethers';

export const BNB_PRIVATE_RPC = 'https://bsc.blockrazor.xyz/fullprivacy';

export function executionGasBudget(gasLimit, gasPrice, maxGasPrice) {
  if (gasLimit <= 0n || gasPrice <= 0n || gasPrice > maxGasPrice) throw new Error('Execution gas is outside the configured limits');
  return gasLimit * gasPrice;
}

export function privateBundle(rawTransaction, maxBlockNumber) {
  const tx = Transaction.from(rawTransaction);
  if (!tx.isSigned() || tx.chainId !== 56n || !tx.to || tx.value !== 0n) throw new Error('Expected a signed zero-value BNB contract transaction');
  if (!Number.isSafeInteger(maxBlockNumber) || maxBlockNumber <= 0) throw new Error('Invalid bundle expiry');
  return { txs: [rawTransaction], revertingTxHashes: [], maxBlockNumber, hint: {} };
}

export async function privateRpc(method, params, endpoint = BNB_PRIVATE_RPC) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('Private RPC must use HTTPS');
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Private RPC HTTP ${response.status}`);
  const body = await response.json();
  const error = body.error || body.jsonerror;
  if (error) throw new Error(`Private RPC rejected request: ${String(error.message || error).slice(0, 160)}`);
  if (body.id !== 1 || body.jsonrpc !== '2.0' || body.result === undefined) throw new Error('Invalid private RPC response');
  return body.result;
}

export async function submitPrivateBundle(rawTransaction, maxBlockNumber, send = privateRpc) {
  const hash = await send('eth_sendMevBundle', [privateBundle(rawTransaction, maxBlockNumber)]);
  if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('Private RPC did not return a bundle hash');
  return hash;
}

// Wait for canonical receipts beyond the expiry before reusing a nonce. An
// advanced nonce without this receipt is unresolved, not a successful trade.
export function privateAttemptExpired(sent, head, latestNonce, confirmations = 20) {
  return sent.submission === 'private_bundle' && Number.isSafeInteger(sent.maxBlockNumber)
    && Number.isSafeInteger(sent.nonce) && Number.isSafeInteger(head)
    && head >= sent.maxBlockNumber + confirmations && latestNonce === sent.nonce;
}

// Always quote the strongest screen while rotating the other slots. Recurring
// false upper bounds cannot permanently starve less highly ranked directions.
export function selectQuoteScreens(candidates, cursor = 0, limit = 4) {
  if (candidates.length <= limit) return { selected: candidates, cursor: 0 };
  const remaining = candidates.slice(1);
  const selected = [candidates[0]];
  for (let i = 0; i < limit - 1; i++) selected.push(remaining[(cursor + i) % remaining.length]);
  return { selected, cursor: (cursor + limit - 1) % remaining.length };
}
