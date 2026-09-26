import { Interface } from 'ethers';

const execution = new Interface(['event VerifiedMixedExecuted(address indexed token,address indexed v2Pair,uint24 fee,uint8 direction,uint256 amountIn,uint256 grossProfit)']);
const erc20 = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function localDay(timestamp, timeZone = 'Asia/Bangkok') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Independent receipt accounting: the executor event must agree with the
// wallet's actual WBNB transfers, and native gas is deducted from that delta.
export function verifyBnbExecution({ transaction, receipt, block, head, address, executor, wbnb, day, confirmations = 20 }) {
  if (BigInt(transaction.chainId) !== 56n || !equal(transaction.from, address) || !equal(transaction.to, executor) || BigInt(transaction.value) !== 0n) throw new Error('Unexpected execution transaction');
  if (receipt.status !== 1 || !equal(receipt.hash, transaction.hash) || !equal(receipt.blockHash, block.hash) || receipt.blockNumber !== block.number) throw new Error('Receipt is failed or not canonical');
  if (head - receipt.blockNumber + 1 < confirmations) throw new Error('Receipt needs more confirmations');
  if (localDay(block.timestamp) !== day) throw new Error('Receipt is outside the target day in Asia/Bangkok');
  const matches = receipt.logs.filter(log => equal(log.address, executor)).map(log => {
    try { return execution.parseLog(log); } catch { return null; }
  }).filter(event => event?.name === 'VerifiedMixedExecuted');
  if (matches.length !== 1) throw new Error('Expected one executor profit event');
  let wrappedDelta = 0n;
  for (const log of receipt.logs.filter(log => equal(log.address, wbnb))) {
    let transfer;
    try { transfer = erc20.parseLog(log); } catch { continue; }
    if (transfer?.name !== 'Transfer') continue;
    if (equal(transfer.args.from, address)) wrappedDelta -= transfer.args.value;
    if (equal(transfer.args.to, address)) wrappedDelta += transfer.args.value;
  }
  const gross = matches[0].args.grossProfit;
  if (gross !== wrappedDelta) throw new Error('Profit event does not match wallet WBNB transfers');
  const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice);
  const net = wrappedDelta - gasCost;
  if (net <= 0n) throw new Error('Execution was not profitable after gas');
  return { txHash: receipt.hash, chainId: 56, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, day, confirmations: head - block.number + 1, amountInWei: String(matches[0].args.amountIn), grossProfitWei: String(gross), walletWbnbDeltaWei: String(wrappedDelta), gasCostWei: String(gasCost), netProfitWei: String(net) };
}
