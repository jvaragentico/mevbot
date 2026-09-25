import { Contract, JsonRpcProvider, Transaction, Wallet, formatEther, getAddress } from 'ethers';
import MevShareClientPackage from '@flashbots/mev-share-client';
import { isRelatedToPair } from './chain.js';
import { loadConfig } from './config.js';
import { record, readEvents } from './journal.js';
import { MIXED_ABI, quoteMixed } from './mixed.js';

const config = loadConfig();
if (config.chainId !== 11155111) throw new Error('Mixed bot runs only on Sepolia');
const required = ['MIXED_ARB_CONTRACT_ADDRESS', 'MIXED_V3_POOL_ADDRESS', 'EXECUTOR_KEY', 'FB_REPUTATION_KEY'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
const contractAddress = getAddress(process.env.MIXED_ARB_CONTRACT_ADDRESS);
const v3Pool = getAddress(process.env.MIXED_V3_POOL_ADDRESS);
const direction = process.env.MIXED_DIRECTION || 'V3-to-V2';
if (!['V3-to-V2', 'V2-to-V3'].includes(direction)) throw new Error('MIXED_DIRECTION must be V3-to-V2 or V2-to-V3');
const gasLimit = BigInt(process.env.MIXED_GAS_LIMIT || '600000');
if (gasLimit < 200000n || gasLimit > 1000000n) throw new Error('MIXED_GAS_LIMIT must be 200000 to 1000000');
const gasCeiling = gasLimit * config.maxFeePerGas;
const minGrossProfit = gasCeiling + config.minNetProfitWei;
const provider = new JsonRpcProvider(config.rpcUrl);
const executor = new Wallet(config.executorKey, provider);
const auth = new Wallet(config.reputationKey, provider);
const MevShareClient = MevShareClientPackage.default;
const mev = MevShareClient.useEthereumSepolia(auth);
const arb = new Contract(contractAddress, MIXED_ABI, executor);
const method = direction === 'V3-to-V2' ? 'executeV3ToV2' : 'executeV2ToV3';
const pending = new Map();
let token, v2Pair, v3Fee, weth;
let busy = false;
let lastSubmissionBlock = -1;

function failureReason(error) {
  const data = error?.data ?? error?.info?.error?.data;
  if (typeof data === 'string') {
    try {
      const parsed = arb.interface.parseError(data);
      if (parsed) return parsed.name === 'Error' ? String(parsed.args[0]) : parsed.name;
    } catch { /* Revert came from another contract. */ }
  }
  return String(error?.reason ?? error?.shortMessage ?? error?.message ?? error).slice(0, 240);
}

async function preflight() {
  if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
  const [owner, contractWeth, contractToken, contractPair, router, fee] = await Promise.all([
    arb.owner(), arb.weth(), arb.token(), arb.v2Pair(), arb.v3Router(), arb.v3Fee(),
  ]);
  weth = contractWeth; token = contractToken; v2Pair = contractPair; v3Fee = Number(fee);
  if (owner.toLowerCase() !== executor.address.toLowerCase()) throw new Error('Executor is not the mixed contract owner');
  if (weth.toLowerCase() !== config.weth.toLowerCase()) throw new Error('Mixed contract WETH mismatch');
  if (router.toLowerCase() !== '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'.toLowerCase()) throw new Error('Unexpected V3 router');
  const factory = new Contract('0x0227628f3F023bb0B980b67D528571c95c6DaC1c', ['function getPool(address,address,uint24) view returns(address)'], provider);
  if ((await factory.getPool(weth, token, v3Fee)).toLowerCase() !== v3Pool.toLowerCase()) throw new Error('Configured V3 pool does not match official factory');
  const v2 = new Contract(v2Pair, ['function token0() view returns(address)', 'function token1() view returns(address)'], provider);
  const [a, b] = await Promise.all([v2.token0(), v2.token1()]);
  if (![a.toLowerCase(), b.toLowerCase()].includes(weth.toLowerCase()) || ![a.toLowerCase(), b.toLowerCase()].includes(token.toLowerCase())) throw new Error('Configured V2 pair tokens mismatch');
  const wethContract = new Contract(weth, ['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)'], provider);
  const [balance, allowance, ethBalance] = await Promise.all([
    wethContract.balanceOf(executor.address), wethContract.allowance(executor.address, contractAddress), provider.getBalance(executor.address),
  ]);
  const maxSize = config.sizes.reduce((a, b) => a > b ? a : b);
  if (config.mode === 'live' && (balance < maxSize || allowance < maxSize || ethBalance < gasCeiling)) throw new Error('Insufficient WETH, allowance, or Sepolia gas balance for mixed bot');
  if (balance >= config.sizes[0] && allowance >= config.sizes[0]) {
    try { await arb[method].staticCall(config.sizes[0], 0n); }
    catch (error) {
      const reason = failureReason(error);
      if (reason !== 'NotProfitable') throw new Error(`Mixed route execution simulation failed: ${reason}`);
    }
  }
}

function restorePending() {
  const events = readEvents();
  const settled = new Set(events.filter(e => ['confirmed', 'receipt_failed', 'expired'].includes(e.type)).map(e => e.txHash?.toLowerCase()));
  for (const event of events.filter(e => ['bundle_sent', 'tx_sent'].includes(e.type) && e.contract?.toLowerCase() === contractAddress.toLowerCase())) {
    if (!settled.has(event.txHash?.toLowerCase())) pending.set(event.txHash, { amountInWei: event.amountInWei, targetBlock: event.targetBlock, kind: event.type });
  }
}

async function checkReceipts() {
  const blockNumber = await provider.getBlockNumber();
  for (const [txHash, item] of pending) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      pending.delete(txHash);
      const gasCostWei = receipt.gasUsed * receipt.gasPrice;
      if (receipt.status !== 1) {
        record('receipt_failed', { chainId: 11155111, contract: contractAddress, direction, txHash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'Mixed arbitrage reverted' });
        continue;
      }
      const event = receipt.logs.filter(log => log.address.toLowerCase() === contractAddress.toLowerCase()).map(log => {
        try { return arb.interface.parseLog(log); } catch { return null; }
      }).find(parsed => parsed?.name === 'MixedRouteExecuted');
      if (!event) {
        record('receipt_failed', { chainId: 11155111, contract: contractAddress, direction, txHash, blockNumber: receipt.blockNumber, gasCostWei, netProfitWei: -gasCostWei, message: 'MixedRouteExecuted event missing' });
        continue;
      }
      const grossProfitWei = event.args.grossProfit;
      record('confirmed', { chainId: 11155111, contract: contractAddress, direction, txHash, blockNumber: receipt.blockNumber, amountInWei: item.amountInWei, grossProfitWei, gasCostWei, netProfitWei: grossProfitWei - gasCostWei, message: 'Confirmed Sepolia mixed arbitrage receipt' });
    } else if (item.kind === 'bundle_sent' && blockNumber > Number(item.targetBlock) + 10) {
      pending.delete(txHash);
      record('expired', { contract: contractAddress, txHash, message: 'Mixed bundle not included within ten blocks' });
    }
  }
  return blockNumber;
}

async function candidates() {
  return quoteMixed(provider, { weth, token, v2Pair, fee: v3Fee, direction, sizes: config.sizes, gasCeilingWei: gasCeiling, minNetProfitWei: config.minNetProfitWei });
}

async function feeAllowed() {
  const latest = await provider.getBlock('latest');
  const projected = latest.baseFeePerGas ? latest.baseFeePerGas * 9n / 8n + 1n : 0n;
  return projected + config.maxPriorityFeePerGas <= config.maxFeePerGas;
}

async function maybeTradeDirect() {
  if (busy || pending.size || config.mode !== 'live') return;
  busy = true;
  try {
    const block = await provider.getBlockNumber();
    if (block === lastSubmissionBlock || !(await feeAllowed())) return;
    const options = await candidates();
    if (!options.length) return;
    const best = options[0];
    const gross = await arb[method].staticCall(best.amountIn, minGrossProfit);
    const gasEstimate = await arb[method].estimateGas(best.amountIn, minGrossProfit);
    if (gasEstimate > gasLimit) return;
    record('candidate', { contract: contractAddress, direction, amountInWei: best.amountIn, quotedGrossProfitWei: gross, quotedNetFloorWei: gross - gasCeiling, message: 'Direct mixed arbitrage passed Sepolia simulation' });
    const tx = await arb[method](best.amountIn, minGrossProfit, {
      gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    });
    lastSubmissionBlock = block;
    pending.set(tx.hash, { amountInWei: best.amountIn.toString(), kind: 'tx_sent' });
    record('tx_sent', { chainId: 11155111, contract: contractAddress, direction, txHash: tx.hash, amountInWei: best.amountIn, message: 'Submitted direct Sepolia mixed arbitrage' });
  } catch (error) { record('error', { message: `Direct check: ${failureReason(error)}` }); }
  finally { busy = false; }
}

async function handleEvent(event) {
  if (!event?.hash || busy || !(isRelatedToPair(event, v2Pair) || isRelatedToPair(event, v3Pool))) return;
  busy = true;
  try {
    const block = await provider.getBlockNumber();
    record('event_seen', { pendingHash: event.hash, blockNumber: block, message: 'MEV-Share hint touched configured mixed pool' });
    if (block === lastSubmissionBlock || pending.size || !(await feeAllowed())) return;
    const options = await candidates();
    const best = options[0];
    const amountIn = best?.amountIn ?? config.sizes[0];
    record(best ? 'candidate' : 'speculative', { pendingHash: event.hash, contract: contractAddress, direction, amountInWei: amountIn, message: best ? 'Mixed quote clears capped gas' : 'Pending hint omitted enough data for a quote; contract profit guard applies' });
    if (config.mode !== 'live') { lastSubmissionBlock = block; return; }
    const data = arb.interface.encodeFunctionData(method, [amountIn, minGrossProfit]);
    const nonce = await executor.getNonce('latest');
    const signedTx = await executor.signTransaction({
      to: contractAddress, data, nonce, chainId: 11155111, type: 2,
      gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    });
    const txHash = Transaction.from(signedTx).hash;
    const targetBlock = block + 1;
    const response = await mev.sendBundle({
      inclusion: { block: targetBlock, maxBlock: targetBlock + 2 },
      body: [{ hash: event.hash }, { tx: signedTx, canRevert: false }],
    });
    lastSubmissionBlock = block;
    pending.set(txHash, { amountInWei: amountIn.toString(), targetBlock, kind: 'bundle_sent' });
    record('bundle_sent', { chainId: 11155111, contract: contractAddress, direction, pendingHash: event.hash, txHash, targetBlock, bundleHash: response.bundleHash, amountInWei: amountIn, message: 'Submitted mixed backrun to MEV-Share' });
  } catch (error) { record('error', { message: `MEV-Share event: ${failureReason(error)}` }); }
  finally { busy = false; }
}

async function main() {
  await preflight();
  restorePending();
  record('startup', { mode: config.mode, chainId: 11155111, contract: contractAddress, message: `Mixed ${direction} ${config.mode}; executor ${executor.address}` });
  console.log(`Mixed MEV-Share ${direction} ${config.mode}; watching ${v2Pair} and ${v3Pool}`);
  const stream = mev.on('transaction', event => { void handleEvent(event); });
  stream.addEventListener('error', () => record('stream_error', { message: 'MEV-Share stream disconnected; client will retry' }));
  const tick = async () => {
    try { const blockNumber = await checkReceipts(); record('heartbeat', { blockNumber }); await maybeTradeDirect(); }
    catch (error) { record('error', { message: `Heartbeat: ${failureReason(error)}` }); }
  };
  const interval = setInterval(() => { void tick(); }, 12_000);
  process.on('SIGINT', () => { clearInterval(interval); stream.close(); record('stopped', { message: 'Mixed bot stopped' }); process.exit(0); });
  await tick();
}

main().catch(error => { record('blocked', { message: failureReason(error) }); console.error(error); process.exitCode = 1; });
