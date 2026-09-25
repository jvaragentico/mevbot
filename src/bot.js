import { Contract, JsonRpcProvider, Transaction, Wallet, formatEther } from 'ethers';
import MevShareClientPackage from '@flashbots/mev-share-client';
import { ARB_ABI, ERC20_ABI, hopState, isRelatedToPair, pairState, parseArbProfit, postReservesFromHints } from './chain.js';
import { loadConfig } from './config.js';
import { record, readEvents } from './journal.js';
import { confirmedNetProfit, quoteRoundTrip, quoteRoute, selectOpportunity, selectRouteOpportunity } from './math.js';

const config = loadConfig();
const MevShareClient = MevShareClientPackage.default;
const required = config.routePairs ? ['rpcUrl', 'weth', 'token', 'arbContract'] : ['rpcUrl', 'buyPair', 'sellPair', 'weth', 'token', 'arbContract'];
const missing = required.filter(key => !config[key]);
if (config.mode === 'live') missing.push(...['executorKey', 'reputationKey'].filter(key => !config[key]));
if (missing.length) {
  const message = `Missing configuration: ${missing.join(', ')}`;
  record('blocked', { message });
  console.error(message);
  process.exit(1);
}

const provider = new JsonRpcProvider(config.rpcUrl);
const executor = config.executorKey ? new Wallet(config.executorKey, provider) : null;
const authSigner = config.reputationKey ? new Wallet(config.reputationKey, provider) : Wallet.createRandom().connect(provider);
const mev = config.network === 'sepolia' ? MevShareClient.useEthereumSepolia(authSigner) : MevShareClient.useEthereumMainnet(authSigner);
const arb = new Contract(config.arbContract, ARB_ABI, provider);
const weth = new Contract(config.weth, ERC20_ABI, provider);
const pending = new Map();
let buyPairState;
let sellPairState;
let routeStates;
let lastSubmittedBlock = -1;
let busy = false;

function failureReason(error) {
  const data = error?.data ?? error?.info?.error?.data;
  if (typeof data === 'string') {
    try {
      const parsed = arb.interface.parseError(data);
      if (parsed) return parsed.name === 'Error' ? String(parsed.args[0]) : parsed.name;
    } catch { /* Revert came from an external pool. */ }
  }
  return String(error?.reason ?? error?.shortMessage ?? error?.message ?? error).slice(0, 240);
}

async function validateExecutableRoute() {
  const amountIn = config.sizes[0];
  const quotedGross = config.routePairs
    ? quoteRoute(amountIn, routeStates).grossProfit
    : quoteRoundTrip(amountIn, buyPairState, sellPairState).grossProfit;
  try {
    if (config.routePairs) {
      await arb.connect(executor).executeRoute.staticCall(config.routePairs, config.routeTokens, amountIn, 0n);
    } else {
      await arb.connect(executor).execute.staticCall(config.buyPair, config.sellPair, amountIn, 0n);
    }
  } catch (error) {
    const reason = failureReason(error);
    if (reason === 'NotProfitable' && quotedGross <= 0n) return;
    throw new Error(`Configured pools failed a Sepolia execution simulation: ${reason}`);
  }
}

function restorePending() {
  const settled = new Set(readEvents().filter(e => ['confirmed', 'receipt_failed', 'expired'].includes(e.type)).map(e => e.txHash));
  for (const e of readEvents().filter(e => e.type === 'bundle_sent')) {
    if (!settled.has(e.txHash)) pending.set(e.txHash, { targetBlock: e.targetBlock, amountInWei: e.amountInWei });
  }
}

async function preflight() {
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) throw new Error(`RPC chain ID ${network.chainId} does not match ${config.chainId}`);
  if (config.routePairs) {
    if (new Set(config.routePairs.map(x => x.toLowerCase())).size !== config.routePairs.length) throw new Error('Route pairs must be distinct');
    if (config.routeTokens[0] !== config.weth || config.routeTokens.at(-1) !== config.weth || config.routeTokens[1] !== config.token) throw new Error('Route must start/end in WETH and first output must match TOKEN_ADDRESS');
    routeStates = await Promise.all(config.routePairs.map((pair, i) => hopState(provider, pair, config.routeTokens[i], config.routeTokens[i + 1])));
    buyPairState = await pairState(provider, config.routePairs[0], config.weth, config.token);
  } else {
    if (config.buyPair === config.sellPair) throw new Error('BUY_PAIR_ADDRESS and SELL_PAIR_ADDRESS must differ');
    [buyPairState, sellPairState] = await Promise.all([
      pairState(provider, config.buyPair, config.weth, config.token),
      pairState(provider, config.sellPair, config.weth, config.token),
    ]);
  }
  const [owner, arbWeth, arbToken] = await Promise.all([arb.owner(), arb.weth(), arb.token()]);
  if (arbWeth.toLowerCase() !== config.weth.toLowerCase() || arbToken.toLowerCase() !== config.token.toLowerCase()) throw new Error('Arbitrage contract tokens do not match configuration');
  if (executor) {
    const maxSize = config.sizes.reduce((a, b) => a > b ? a : b);
    const [balance, allowance, ethBalance] = await Promise.all([
      weth.balanceOf(executor.address), weth.allowance(executor.address, config.arbContract), provider.getBalance(executor.address),
    ]);
    if (config.mode === 'live') {
      if (owner.toLowerCase() !== executor.address.toLowerCase()) throw new Error('Executor is not the contract owner');
      if (balance < maxSize) throw new Error(`Need at least ${formatEther(maxSize)} WETH in executor wallet`);
      if (allowance < maxSize) throw new Error(`Approve the arbitrage contract for at least ${formatEther(maxSize)} WETH`);
      if (ethBalance < config.gasLimit * config.maxFeePerGas) throw new Error('Insufficient Sepolia ETH for capped execution gas');
    }
    if (balance >= config.sizes[0] && allowance >= config.sizes[0]) await validateExecutableRoute();
  }
}

async function checkReceipts() {
  const block = await provider.getBlockNumber();
  for (const [txHash, submission] of pending) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      pending.delete(txHash);
      if (receipt.status !== 1) {
        const gasCostWei = receipt.gasUsed * receipt.gasPrice;
        record('receipt_failed', { chainId: config.chainId, txHash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'Execution reverted' });
        continue;
      }
      const grossProfit = parseArbProfit(receipt, config.arbContract);
      if (grossProfit === null) {
        const gasCostWei = receipt.gasUsed * receipt.gasPrice;
        record('receipt_failed', { chainId: config.chainId, txHash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'ArbExecuted event missing' });
        continue;
      }
      const netProfit = confirmedNetProfit(grossProfit, receipt.gasUsed, receipt.gasPrice);
      record('confirmed', {
        chainId: config.chainId, txHash, blockNumber: receipt.blockNumber,
        grossProfitWei: grossProfit, gasCostWei: receipt.gasUsed * receipt.gasPrice,
        netProfitWei: netProfit, amountInWei: submission.amountInWei,
      });
    } else if (block > Number(submission.targetBlock) + 10) {
      pending.delete(txHash);
      record('expired', { txHash, message: 'Bundle not included within ten blocks' });
    }
  }
  return block;
}

async function handleEvent(event) {
  const watchedPair = config.routePairs?.[0] ?? config.buyPair;
  if (!event?.hash || !isRelatedToPair(event, watchedPair) || busy) return;
  busy = true;
  try {
    const block = await provider.getBlockNumber();
    record('event_seen', { pendingHash: event.hash, blockNumber: block, message: 'Pending transaction touched buy pair' });
    if (lastSubmittedBlock === block) return;
    // The stream can hide amounts. If a full Sync hint is absent, a capped speculative
    // bundle is safe because the on-chain executor reverts unless profit clears gas.
    const hinted = postReservesFromHints(event, watchedPair, buyPairState.token0, config.weth, config.token);
    let candidate;
    if (config.routePairs) {
      routeStates = await Promise.all(config.routePairs.map((pair, i) => hopState(provider, pair, config.routeTokens[i], config.routeTokens[i + 1])));
      buyPairState = await pairState(provider, watchedPair, config.weth, config.token);
      if (hinted) routeStates[0] = { ...routeStates[0], reserveIn: hinted.weth, reserveOut: hinted.token };
    } else {
      [buyPairState, sellPairState] = await Promise.all([
        pairState(provider, config.buyPair, config.weth, config.token),
        pairState(provider, config.sellPair, config.weth, config.token),
      ]);
    }
    const nextBlock = await provider.getBlock('latest');
    const projectedBaseFee = nextBlock.baseFeePerGas ? nextBlock.baseFeePerGas * 9n / 8n + 1n : 0n;
    if (projectedBaseFee + config.maxPriorityFeePerGas > config.maxFeePerGas) {
      record('skipped', { pendingHash: event.hash, reason: 'Configured fee cap below projected next base fee' });
      return;
    }
    const gasCeilingWei = config.gasLimit * config.maxFeePerGas;
    candidate = config.routePairs
      ? selectRouteOpportunity(config.sizes, routeStates, gasCeilingWei, config.minNetProfitWei)
      : selectOpportunity(config.sizes, hinted ?? buyPairState, sellPairState, gasCeilingWei, config.minNetProfitWei);
    if (hinted && !candidate) {
      record('skipped', { pendingHash: event.hash, reason: 'No positive net quote at configured sizes' });
      return;
    }
    const amountIn = candidate?.amountIn ?? config.sizes[0];
    if (candidate) record('candidate', { pendingHash: event.hash, amountInWei: amountIn, quotedGrossProfitWei: candidate.grossProfit, quotedNetFloorWei: candidate.netFloor, message: 'Positive quote after gas ceiling' });
    else record('speculative', { pendingHash: event.hash, amountInWei: amountIn, message: 'Pool hint omitted reserves; contract profit guard remains active' });
    if (config.mode !== 'live') { lastSubmittedBlock = block; return; }
    const minGrossProfit = gasCeilingWei + config.minNetProfitWei;
    const data = config.routePairs
      ? arb.interface.encodeFunctionData('executeRoute', [config.routePairs, config.routeTokens, amountIn, minGrossProfit])
      : arb.interface.encodeFunctionData('execute', [config.buyPair, config.sellPair, amountIn, minGrossProfit]);
    const nonce = await executor.getNonce('latest');
    const signedTx = await executor.signTransaction({
      to: config.arbContract, data, nonce, chainId: config.chainId, type: 2,
      gasLimit: config.gasLimit, maxFeePerGas: config.maxFeePerGas,
      maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    });
    const txHash = Transaction.from(signedTx).hash;
    const targetBlock = block + 1;
    const response = await mev.sendBundle({
      inclusion: { block: targetBlock, maxBlock: targetBlock + 2 },
      body: [{ hash: event.hash }, { tx: signedTx, canRevert: false }],
    });
    lastSubmittedBlock = block;
    pending.set(txHash, { targetBlock, amountInWei: amountIn.toString() });
    record('bundle_sent', { pendingHash: event.hash, txHash, targetBlock, bundleHash: response.bundleHash, amountInWei: amountIn, message: 'Submitted to MEV-Share' });
  } catch (error) {
    record('error', { message: error.message ?? String(error) });
    console.error(error);
  } finally { busy = false; }
}

async function main() {
  await preflight();
  restorePending();
  record('startup', { mode: config.mode, chainId: config.chainId, message: `${config.network} ${config.mode}; executor ${executor?.address ?? 'disabled'}` });
  console.log(`MEV-Share ${config.network} ${config.mode}; monitoring ${config.routePairs?.[0] ?? config.buyPair}`);
  const stream = mev.on('transaction', event => { void handleEvent(event); });
  stream.addEventListener('error', () => record('stream_error', { message: 'MEV-Share stream disconnected; client will retry' }));
  const interval = setInterval(() => {
    void checkReceipts().then(blockNumber => record('heartbeat', { blockNumber })).catch(error => record('error', { message: error.message }));
  }, 12_000);
  process.on('SIGINT', () => { clearInterval(interval); stream.close(); record('stopped', { message: 'Bot stopped' }); process.exit(0); });
  record('heartbeat', { blockNumber: await checkReceipts() });
}

main().catch(error => { record('blocked', { message: error.message ?? String(error) }); console.error(error); process.exitCode = 1; });
