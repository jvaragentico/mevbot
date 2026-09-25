import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider } from 'ethers';
import { BNB_CHAIN } from './bnb-chain.js';
import { loadBnbConfig } from './bnb-config.js';
import { readEvents } from './journal.js';
import { assessWalletStop, BNB_STOP_PATH, formatUsd8, isBnbStopLatched, loadBnbBaseline, readBnbValuation } from './bnb-risk.js';

const config = loadBnbConfig();
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== BNB_CHAIN.chainId) throw new Error('Expected BNB Smart Chain RPC');
const wbnb = new Contract(BNB_CHAIN.wbnb, [
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
], provider);
const htmlPath = fileURLToPath(new URL('../web/bnb.html', import.meta.url));
const journalPath = 'data/bnb-events.jsonl';
const baseline = loadBnbBaseline(config.expectedAddress);
const reviewStopPath = 'data/bnb-review-stop.json';
let walletCache = { at: 0, value: null };

async function walletStatus() {
  if (walletCache.value && Date.now() - walletCache.at < 15_000) return walletCache.value;
  const [native, wrapped, allowance, block, valuation] = await Promise.allSettled([
    provider.getBalance(config.expectedAddress),
    wbnb.balanceOf(config.expectedAddress),
    config.contractAddress ? wbnb.allowance(config.expectedAddress, config.contractAddress) : Promise.resolve(null),
    provider.getBlockNumber(),
    readBnbValuation(provider, config.expectedAddress),
  ]);
  const value = {
    address: config.expectedAddress, contract: config.contractAddress,
    nativeWei: native.status === 'fulfilled' ? native.value.toString() : null,
    wrappedWei: wrapped.status === 'fulfilled' ? wrapped.value.toString() : null,
    allowanceWei: allowance.status === 'fulfilled' && allowance.value !== null ? allowance.value.toString() : null,
    blockNumber: block.status === 'fulfilled' ? block.value : null,
    valueUsd8: valuation.status === 'fulfilled' ? String(valuation.value.valueUsd8) : null,
    priceUsd8: valuation.status === 'fulfilled' ? String(valuation.value.priceUsd8) : null,
    priceUpdatedAt: valuation.status === 'fulfilled' ? valuation.value.priceUpdatedAt : null,
  };
  walletCache = { at: Date.now(), value };
  return value;
}

function state(wallet) {
  const events = readEvents(journalPath);
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  const receipts = new Map();
  for (const event of events) if (['confirmed', 'receipt_failed'].includes(event.type) && /^0x[0-9a-f]{64}$/i.test(event.txHash || '')) receipts.set(event.txHash.toLowerCase(), event);
  const trades = [...receipts.values()];
  const netWei = trades.reduce((sum, event) => sum + BigInt(event.netProfitWei || '0'), 0n);
  const gasWei = trades.reduce((sum, event) => sum + BigInt(event.gasCostWei || '0'), 0n);
  const latestStart = events.findLast(event => ['startup', 'stopped', 'blocked'].includes(event.type));
  const heartbeat = events.findLast(event => event.type === 'heartbeat');
  const fresh = heartbeat && Date.now() - Date.parse(heartbeat.at) < 60_000;
  const walletStopped = isBnbStopLatched(BNB_STOP_PATH);
  const reviewStopped = existsSync(reviewStopPath);
  const risk = baseline ? {
    baselineUsd: formatUsd8(BigInt(baseline.valueUsd8)),
    limitUsd: formatUsd8(config.maxWalletLossUsd8),
    walletValueUsd: wallet.valueUsd8 ? formatUsd8(BigInt(wallet.valueUsd8)) : null,
    priceUsd: wallet.priceUsd8 ? formatUsd8(BigInt(wallet.priceUsd8)) : null,
    priceUpdatedAt: wallet.priceUpdatedAt,
    ...wallet.valueUsd8 ? (() => {
      const assessed = assessWalletStop({ baselineUsd8: BigInt(baseline.valueUsd8), currentUsd8: BigInt(wallet.valueUsd8), limitUsd8: config.maxWalletLossUsd8, latched: walletStopped });
      return { declineUsd: formatUsd8(assessed.declineUsd8), remainingUsd: formatUsd8(assessed.remainingUsd8), status: reviewStopped ? 'review' : assessed.stopped ? 'stopped' : 'active' };
    })() : { declineUsd: null, remainingUsd: null, status: reviewStopped ? 'review' : walletStopped ? 'stopped' : 'price unavailable' },
    reviewAfterProfitableTrades: config.reviewAfterProfitableTrades,
  } : { status: 'baseline missing', limitUsd: formatUsd8(config.maxWalletLossUsd8), reviewAfterProfitableTrades: config.reviewAfterProfitableTrades };
  let scan = null;
  if (existsSync('data/bnb-routes.json')) {
    try {
      const saved = JSON.parse(readFileSync('data/bnb-routes.json', 'utf8'));
      scan = { at: saved.at, block: saved.block, activeV3Pools: saved.activeV3Pools, quotedOpportunities: saved.opportunities?.length || 0 };
    } catch { /* The scanner may be replacing the file. */ }
  }
  return {
    chainId: 56, status: latestStart?.type === 'startup' && fresh ? (reviewStopped ? 'review' : walletStopped ? 'stopped' : latestStart.mode) : 'offline',
    statusMessage: latestStart?.message || 'No bot activity yet',
    counts, scan, risk, netWei: netWei.toString(), gasWei: gasWei.toString(),
    profitableTrades: trades.filter(event => event.type === 'confirmed' && BigInt(event.netProfitWei || '0') > 0n).length,
    trades: trades.slice(-50).reverse(), events: events.filter(event => event.type !== 'heartbeat').slice(-50).reverse(),
  };
}

createServer(async (req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    const wallet = await walletStatus();
    res.end(JSON.stringify({ ...state(wallet), wallet }));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(await readFile(htmlPath));
  } else { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.env.BNB_DASHBOARD_PORT || 8788), '127.0.0.1', () => {
  console.log(`BNB dashboard: http://127.0.0.1:${process.env.BNB_DASHBOARD_PORT || 8788}`);
});
