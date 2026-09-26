import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { JsonRpcProvider, formatEther } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { loadBnbConfig } from '../src/bnb-config.js';
import { localDay, verifyBnbExecution } from '../src/bnb-proof.js';
import { readEvents } from '../src/journal.js';

const config = loadBnbConfig();
const target = existsSync('data/bnb-target.json') ? JSON.parse(readFileSync('data/bnb-target.json', 'utf8')) : { day: localDay(Math.floor(Date.now() / 1000)), count: 5, timeZone: 'Asia/Bangkok' };
const provider = new JsonRpcProvider(config.rpcUrl);
try {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Expected BNB mainnet');
  const head = await provider.getBlockNumber();
  const hashes = [...new Set(readEvents('data/bnb-events.jsonl').filter(event => event.chainId === 56 && event.type === 'confirmed' && /^0x[0-9a-f]{64}$/i.test(event.txHash || '')).map(event => event.txHash.toLowerCase()))];
  const verified = [], rejected = [];
  for (const hash of hashes) {
    try {
      const [transaction, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
      if (!transaction || !receipt) throw new Error('Transaction or receipt unavailable');
      const block = await provider.getBlock(receipt.blockNumber);
      if (!block) throw new Error('Canonical block unavailable');
      verified.push(verifyBnbExecution({ transaction, receipt, block, head, address: config.expectedAddress, executor: config.contractAddress, wbnb: BNB_CHAIN.wbnb, day: target.day }));
    } catch (error) { rejected.push({ txHash: hash, reason: String(error.shortMessage || error.message).slice(0, 180) }); }
  }
  const result = { checkedAt: new Date().toISOString(), target, chainId: 56, address: config.expectedAddress, executor: config.contractAddress, head, status: verified.length >= target.count ? 'achieved' : 'pending', verifiedCount: verified.length, netExecutionWbnb: formatEther(verified.reduce((sum, trade) => sum + BigInt(trade.netProfitWei), 0n)), verified, rejected, note: 'Mainnet receipts and wallet WBNB transfer deltas, minus actual transaction gas. Deployment, wrapping, approval gas and BNB/USD changes are separate.' };
  writeFileSync('data/bnb-target-proof.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { provider.destroy(); }
