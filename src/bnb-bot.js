import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import { BNB_CHAIN } from './bnb-chain.js';
import { loadBnbConfig } from './bnb-config.js';
import { record as writeEvent, readEvents } from './journal.js';
import { quoteMixed } from './mixed.js';
import { assessWalletStop, formatUsd8, isBnbStopLatched, latchBnbStop, loadBnbBaseline, readBnbValuation, usd8FromBnbWei } from './bnb-risk.js';

const config = loadBnbConfig();
const journalPath = 'data/bnb-events.jsonl';
const record = (type, fields = {}) => writeEvent(type, { chainId: 56, ...fields }, journalPath);
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== BNB_CHAIN.chainId) throw new Error('Expected BNB Smart Chain RPC');
const wallet = config.executorKey ? new Wallet(config.executorKey, provider) : null;
if (wallet && wallet.address.toLowerCase() !== config.expectedAddress.toLowerCase()) throw new Error('BNB key does not match the selected public wallet');
if (config.mode === 'live' && (!wallet || !config.contractAddress)) throw new Error('Live BNB bot needs a matching local key and deployed executor');
const baseline = loadBnbBaseline(config.expectedAddress);
if (config.mode === 'live' && !baseline) throw new Error('Live BNB bot needs a fixed USD wallet baseline; run npm run set-bnb-baseline first');
const reviewStopPath = 'data/bnb-review-stop.json';
const artifact = JSON.parse(readFileSync('artifacts/AtomicVerifiedMixedArb.json', 'utf8'));
const arb = config.contractAddress ? new Contract(config.contractAddress, artifact.abi, wallet || provider) : null;
const wbnb = new Contract(BNB_CHAIN.wbnb, ['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)'], provider);
let routes = [];
let routeCursor = 0;
let busy = false;
let lastSubmissionBlock = -1;
let lastRouteLoad = 0;
let routeMtimeMs = 0;
let lastFundingNotice = 0;
let nextScanAt = Date.now() + config.rescanHours * 3_600_000;
let scanning = false;
let lastRiskNotice = 0;
let lastValuation = 0;
let lastPendingNotice = 0;
let lastHeartbeatAt = 0;

function unsettledTransactions() {
  const sent = new Map();
  const settled = new Set();
  for (const event of readEvents(journalPath)) {
    if (event.chainId !== 56 || !/^0x[0-9a-f]{64}$/i.test(event.txHash || '')) continue;
    const hash = event.txHash.toLowerCase();
    if (event.type === 'tx_sent') sent.set(hash, event);
    if (['confirmed', 'receipt_failed'].includes(event.type)) settled.add(hash);
  }
  return [...sent].filter(([hash]) => !settled.has(hash)).map(([, event]) => event);
}

function recordBnbReceipt(sent, receipt) {
  const gasCostWei = receipt.gasUsed * receipt.gasPrice;
  if (receipt.status !== 1) {
    record('receipt_failed', { txHash: sent.txHash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'BNB arbitrage reverted' });
    return;
  }
  const event = receipt.logs.filter(log => log.address.toLowerCase() === config.contractAddress.toLowerCase()).map(log => {
    try { return arb.interface.parseLog(log); } catch { return null; }
  }).find(item => item?.name === 'VerifiedMixedExecuted');
  if (!event) {
    record('receipt_failed', { txHash: sent.txHash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'BNB profit event missing' });
    return;
  }
  const gross = event.args.grossProfit;
  record('confirmed', { txHash: sent.txHash, contract: config.contractAddress, token: sent.token, direction: sent.direction, blockNumber: receipt.blockNumber, amountInWei: sent.amountInWei, grossProfitWei: gross, gasCostWei, netProfitWei: gross - gasCostWei, message: 'Confirmed BNB arbitrage receipt' });
  reviewStopped();
}

async function reconcilePending() {
  const pending = unsettledTransactions();
  for (const sent of pending) {
    const receipt = await provider.getTransactionReceipt(sent.txHash);
    if (receipt) recordBnbReceipt(sent, receipt);
  }
  const remaining = unsettledTransactions();
  if (remaining.length && Date.now() - lastPendingNotice > 3_600_000) {
    lastPendingNotice = Date.now();
    record('pending_tx', { txHash: remaining[0].txHash, message: `${remaining.length} BNB transaction receipt(s) unresolved; new trades paused` });
  }
  return remaining.length === 0;
}

function profitableReceiptCount() {
  const byHash = new Map();
  for (const event of readEvents(journalPath)) {
    if (event.chainId === 56 && ['confirmed', 'receipt_failed'].includes(event.type) && /^0x[0-9a-f]{64}$/i.test(event.txHash || '')) byHash.set(event.txHash.toLowerCase(), event);
  }
  return [...byHash.values()].filter(event => event.type === 'confirmed' && BigInt(event.netProfitWei || '0') > 0n).length;
}

function reviewStopped() {
  if (existsSync(reviewStopPath)) return true;
  const count = profitableReceiptCount();
  if (count < config.reviewAfterProfitableTrades) return false;
  writeFileSync(reviewStopPath, JSON.stringify({ at: new Date().toISOString(), profitableReceipts: count, limit: config.reviewAfterProfitableTrades }, null, 2), { flag: 'wx' });
  record('review_stop', { message: `Paused after ${count} profitable BNB receipts for review` });
  return true;
}

async function checkWalletRisk(gasCeilingWei = 0n) {
  if (!baseline) return true;
  if (isBnbStopLatched() || reviewStopped()) return false;
  const value = await readBnbValuation(provider, config.expectedAddress);
  const risk = assessWalletStop({
    baselineUsd8: BigInt(baseline.valueUsd8), currentUsd8: value.valueUsd8,
    limitUsd8: config.maxWalletLossUsd8,
    pendingGasUsd8: usd8FromBnbWei(gasCeilingWei, value.priceUsd8),
  });
  if (Date.now() - lastValuation > 60_000) {
    lastValuation = Date.now();
    record('wallet_value', { valueUsd8: value.valueUsd8, priceUsd8: value.priceUsd8, remainingUsd8: risk.remainingUsd8, message: `BNB+WBNB $${formatUsd8(value.valueUsd8)}; $${formatUsd8(risk.remainingUsd8)} to stop` });
  }
  if (risk.stopped) {
    latchBnbStop({ address: config.expectedAddress, currentUsd8: value.valueUsd8, baselineUsd8: BigInt(baseline.valueUsd8), limitUsd8: config.maxWalletLossUsd8, reason: '$15 wallet value drop' });
    record('wallet_stop', { message: `Trading stopped: wallet BNB+WBNB value fell $${formatUsd8(risk.declineUsd8)} from baseline` });
    return false;
  }
  if (!risk.maySend && Date.now() - lastRiskNotice > 3_600_000) {
    lastRiskNotice = Date.now();
    record('risk_limit', { message: 'Remaining USD wallet loss room is smaller than the next transaction gas ceiling' });
  }
  return risk.maySend;
}

function refreshRoutes() {
  if (!existsSync('data/bnb-routes.json')) throw new Error('Run npm run scan-bnb-routes first');
  const mtimeMs = statSync('data/bnb-routes.json').mtimeMs;
  lastRouteLoad = Date.now();
  if (mtimeMs === routeMtimeMs) return;
  const source = JSON.parse(readFileSync('data/bnb-routes.json', 'utf8'));
  if (!Array.isArray(source.routes)) throw new Error('Invalid BNB route file');
  routes = source.routes;
  routeMtimeMs = mtimeMs;
  record('route_scan', { routeCount: routes.length, sourceBlock: source.block, message: `Monitoring ${routes.length} active V2/V3 pool overlaps` });
}

function maybeRescan() {
  if (scanning || Date.now() < nextScanAt) return;
  scanning = true;
  nextScanAt = Date.now() + config.rescanHours * 3_600_000;
  const env = { ...process.env };
  delete env.EXECUTOR_KEY;
  delete env.FB_REPUTATION_KEY;
  delete env.BNB_WALLET_KEY_IMPORT;
  delete env.RPC_URL;
  const child = spawn(process.execPath, ['scripts/scan-bnb-routes.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', error => { scanning = false; record('scan_error', { message: String(error.message).slice(0, 180) }); });
  child.on('exit', code => { scanning = false; record(code === 0 ? 'scan_complete' : 'scan_error', { message: `Scheduled BNB pool scan exited ${code}` }); });
}

function gasSpentToday() {
  const day = new Date().toISOString().slice(0, 10);
  return readEvents(journalPath).filter(e => e.at?.startsWith(day) && ['confirmed', 'receipt_failed'].includes(e.type)).reduce((sum, e) => sum + BigInt(e.gasCostWei || '0'), 0n);
}

async function preflight() {
  if (!arb) return;
  const [owner, weth, v2Factory, v3Factory, v3Router] = await Promise.all([arb.owner(), arb.weth(), arb.v2Factory(), arb.v3Factory(), arb.v3Router()]);
  if (owner.toLowerCase() !== config.expectedAddress.toLowerCase() || weth.toLowerCase() !== BNB_CHAIN.wbnb.toLowerCase() || v2Factory.toLowerCase() !== BNB_CHAIN.v2Factory.toLowerCase() || v3Factory.toLowerCase() !== BNB_CHAIN.v3Factory.toLowerCase() || v3Router.toLowerCase() !== BNB_CHAIN.v3Router.toLowerCase()) throw new Error('Deployed executor configuration mismatch');
}

async function checkRoute(route, gasCeilingWei) {
  for (const direction of ['V3-to-V2', 'V2-to-V3']) {
    const candidates = await quoteMixed(provider, {
      weth: BNB_CHAIN.wbnb, token: route.token, v2Pair: route.v2Pair, fee: route.fee,
      direction, sizes: config.sizes, gasCeilingWei, minNetProfitWei: config.minNetProfitWei,
      quoterAddress: BNB_CHAIN.v3Quoter,
    });
    if (candidates.length) return { route, direction, candidate: candidates[0] };
  }
  return null;
}

async function maybeTrade(found, gasPrice) {
  const { route, direction, candidate } = found;
  const gasCeilingWei = config.gasLimit * gasPrice;
  if (gasSpentToday() + gasCeilingWei > config.maxDailyGasWei) {
    record('risk_limit', { message: 'Daily BNB gas budget reached; bot remains online and checks again after UTC midnight' });
    return;
  }
  const [nativeBalance, wrappedBalance, allowance] = await Promise.all([
    provider.getBalance(config.expectedAddress), wbnb.balanceOf(config.expectedAddress), wbnb.allowance(config.expectedAddress, config.contractAddress),
  ]);
  if (nativeBalance < config.nativeReserveWei + gasCeilingWei || wrappedBalance < candidate.amountIn || allowance < candidate.amountIn) {
    if (Date.now() - lastFundingNotice > 3_600_000) {
      lastFundingNotice = Date.now();
      record('funding_needed', { message: `Need native gas reserve, WBNB input, and executor allowance; BNB ${formatEther(nativeBalance)}, WBNB ${formatEther(wrappedBalance)}` });
    }
    return;
  }
  const args = [route.token, route.v2Pair, route.fee, direction === 'V3-to-V2' ? 0 : 1, candidate.amountIn, gasCeilingWei + config.minNetProfitWei];
  const grossProfitWei = await arb.execute.staticCall(...args);
  const estimate = await arb.execute.estimateGas(...args);
  if (estimate > config.gasLimit) return;
  record('candidate', { token: route.token, v2Pair: route.v2Pair, direction, amountInWei: candidate.amountIn, simulatedGrossProfitWei: grossProfitWei, netFloorWei: grossProfitWei - gasCeilingWei, message: 'Fresh BNB contract simulation passed' });
  const currentBlock = await provider.getBlockNumber();
  if (currentBlock === lastSubmissionBlock) return;
  if (!await checkWalletRisk(gasCeilingWei) || reviewStopped()) return;
  const tx = await arb.execute(...args, { gasLimit: config.gasLimit, gasPrice });
  lastSubmissionBlock = currentBlock;
  const sent = record('tx_sent', { txHash: tx.hash, nonce: tx.nonce, contract: config.contractAddress, token: route.token, direction, amountInWei: candidate.amountIn, message: 'Submitted BNB mixed arbitrage' });
  let receipt;
  try { receipt = await tx.wait(1); }
  catch (error) { receipt = error?.receipt; if (!receipt) throw error; }
  if (!receipt) return;
  recordBnbReceipt(sent, receipt);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (Date.now() - lastRouteLoad > 60_000) refreshRoutes();
    maybeRescan();
    const blockNumber = await provider.getBlockNumber();
    if (Date.now() - lastHeartbeatAt > 25_000) {
      lastHeartbeatAt = Date.now();
      record('heartbeat', { blockNumber });
    }
    if (!await reconcilePending()) return;
    if (config.mode === 'live' && !await checkWalletRisk(config.gasLimit * config.maxGasPriceWei)) return;
    const gasPrice = (await provider.getFeeData()).gasPrice;
    if (!gasPrice || gasPrice > config.maxGasPriceWei) return;
    const gasCeilingWei = config.gasLimit * config.maxGasPriceWei;
    for (let i = 0; i < Math.min(4, routes.length); i++) {
      const route = routes[routeCursor++ % routes.length];
      try {
        const found = await checkRoute(route, gasCeilingWei);
        if (!found) continue;
        if (config.mode === 'observe') {
          record('candidate', { token: route.token, v2Pair: route.v2Pair, direction: found.direction, amountInWei: found.candidate.amountIn, quotedNetFloorWei: found.candidate.netFloor, message: 'BNB reserve and V3 quote cleared capped gas; observe mode' });
          continue;
        }
        await maybeTrade(found, gasPrice);
        break;
      } catch (error) { record('route_error', { token: route.token, message: String(error?.shortMessage ?? error?.message ?? error).slice(0, 220) }); }
    }
  } catch (error) { record('error', { message: String(error?.shortMessage ?? error?.message ?? error).slice(0, 220) }); }
  finally { busy = false; }
}

refreshRoutes();
await preflight();
record('startup', { mode: config.mode, wallet: config.expectedAddress, contract: config.contractAddress, message: `BNB ${config.mode} bot started; pauses after ${config.reviewAfterProfitableTrades} profitable BNB receipts` });
console.log(`BNB ${config.mode} bot watching ${routes.length} V2/V3 pool overlaps; wallet ${config.expectedAddress}`);
process.on('SIGINT', () => { record('stopped', { message: 'BNB bot stopped' }); process.exit(0); });
setInterval(() => { void tick(); }, config.tickMs);
await tick();
