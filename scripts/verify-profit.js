import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Interface, JsonRpcProvider, formatEther } from 'ethers';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (config.chainId !== 11155111) throw new Error('Verification is restricted to Sepolia');
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const specializedAbi = JSON.parse(readFileSync('artifacts/AtomicV2V3Arb.json', 'utf8')).abi;
const verifiedAbi = JSON.parse(readFileSync('artifacts/AtomicVerifiedMixedArb.json', 'utf8')).abi;
const specializedInterface = new Interface(specializedAbi);
const verifiedInterface = new Interface(verifiedAbi);
const proof = JSON.parse(readFileSync('proof/sepolia-five.json', 'utf8'));
if (proof.chainId !== 11155111) throw new Error('Unexpected proof chain');
const distinct = new Map();
for (const entry of proof.transactions) {
  if (!/^0x[0-9a-f]{64}$/i.test(entry.txHash ?? '') || !/^0x[0-9a-f]{40}$/i.test(entry.contract ?? '') || distinct.has(entry.txHash.toLowerCase())) throw new Error('Invalid or duplicate proof transaction');
  distinct.set(entry.txHash.toLowerCase(), entry);
}
const verified = [];
for (const saved of distinct.values()) {
  const [receipt, tx] = await Promise.all([provider.getTransactionReceipt(saved.txHash), provider.getTransaction(saved.txHash)]);
  if (!receipt || receipt.status !== 1 || !tx || tx.to?.toLowerCase() !== saved.contract.toLowerCase() || receipt.blockNumber !== saved.blockNumber) throw new Error(`Receipt mismatch: ${saved.txHash}`);
  const parsed = receipt.logs.filter(log => log.address.toLowerCase() === saved.contract.toLowerCase()).map(log => {
    for (const iface of [verifiedInterface, specializedInterface]) {
      try {
        const event = iface.parseLog(log);
        if (['VerifiedMixedExecuted', 'MixedRouteExecuted'].includes(event?.name)) return event;
      } catch { /* This ABI does not contain the event. */ }
    }
    return null;
  }).find(Boolean);
  if (!parsed) throw new Error(`Profit event missing: ${saved.txHash}`);
  const grossProfitWei = parsed.args.grossProfit;
  const gasCostWei = receipt.gasUsed * receipt.gasPrice;
  const netProfitWei = grossProfitWei - gasCostWei;
  if (netProfitWei.toString() !== saved.expectedNetProfitWei || netProfitWei <= 0n) throw new Error(`Profit mismatch: ${saved.txHash}`);
  verified.push({ txHash: saved.txHash, blockNumber: receipt.blockNumber, netProfitWethEquivalent: formatEther(netProfitWei) });
}
const cumulativeNetWei = verified.reduce((sum, result) => sum + BigInt(distinct.get(result.txHash.toLowerCase()).expectedNetProfitWei), 0n);
const result = { chainId: 11155111, verifiedProfitableTransactions: verified.length, cumulativeNetWethEquivalent: formatEther(cumulativeNetWei), ready: verified.length >= 5 && cumulativeNetWei > 0n, transactions: verified };
console.log(JSON.stringify(result, null, 2));
if (!result.ready) process.exitCode = 1;
