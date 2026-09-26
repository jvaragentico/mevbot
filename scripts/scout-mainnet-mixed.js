import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Contract, Interface, JsonRpcProvider, ZeroAddress, formatEther, parseEther } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { loadBnbConfig } from '../src/bnb-config.js';
import { quoteMixed } from '../src/mixed.js';
import { screenMixedRoutes } from '../src/mixed-screen.js';

// Read-only comparison. No signer, deployment, approvals, swaps, or bridging.
const networks = {
  'bnb-pancake-v2': {
    id: 56, rpc: BNB_CHAIN.rpc, weth: BNB_CHAIN.wbnb,
    v2Factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    v2FeeNumerator: 9975n, v2FeeDenominator: 10000n,
    v3Factory: BNB_CHAIN.v3Factory, quoter: BNB_CHAIN.v3Quoter,
    fees: [100, 500, 3000, 10000],
    tokenUrl: 'https://raw.githubusercontent.com/pancakeswap/token-list/main/lists/pancakeswap-extended.json',
  },
  'bnb-pancake-both': {
    id: 56, rpc: BNB_CHAIN.rpc, weth: BNB_CHAIN.wbnb,
    v2Factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    v2FeeNumerator: 9975n, v2FeeDenominator: 10000n,
    v3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    fees: [100, 500, 2500, 10000],
    tokenUrl: 'https://raw.githubusercontent.com/pancakeswap/token-list/main/lists/pancakeswap-extended.json',
  },
  'bnb-pancake': {
    id: 56, rpc: BNB_CHAIN.rpc, weth: BNB_CHAIN.wbnb,
    v2Factory: BNB_CHAIN.v2Factory,
    v3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    fees: [100, 500, 2500, 10000],
    tokenUrl: 'https://raw.githubusercontent.com/pancakeswap/token-list/main/lists/pancakeswap-extended.json',
  },
  base: {
    id: 8453, rpc: 'https://mainnet.base.org', weth: '0x4200000000000000000000000000000000000006',
    v2Factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    v3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', fees: [100, 500, 3000, 10000],
    tokenUrl: 'https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/base.json',
  },
  arbitrum: {
    id: 42161, rpc: 'https://arb1.arbitrum.io/rpc', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    v2Factory: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', fees: [100, 500, 3000, 10000],
    tokenUrl: 'https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/arbitrum.json',
  },
};
const name = process.argv[2] || 'bnb-pancake';
const chain = networks[name];
if (!chain) throw new Error(`Choose ${Object.keys(networks).join(', ')}`);
const config = loadBnbConfig();
const provider = new JsonRpcProvider(process.env.SCOUT_RPC_URL || (chain.id === 56 ? config.rpcUrl : chain.rpc), undefined, { batchMaxCount: 1 });
try {
  if ((await provider.getNetwork()).chainId !== BigInt(chain.id)) throw new Error('Scout RPC chain mismatch');
  const response = await fetch(chain.tokenUrl, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Token list HTTP ${response.status}`);
  const list = await response.json();
  const tokens = (Array.isArray(list) ? list : list.tokens).filter(token => token.chainId === chain.id && token.address.toLowerCase() !== chain.weth.toLowerCase());
  if (chain.id === 56 && existsSync('data/bnb-routes.json')) {
    const saved = JSON.parse(readFileSync('data/bnb-routes.json', 'utf8'));
    tokens.push(...saved.liquidV2Pairs.map(route => ({ address: route.token, symbol: route.token.slice(0, 10) })));
  }
  const unique = [...new Map(tokens.map(token => [token.address.toLowerCase(), token])).values()];
  const factory2 = new Interface(['function getPair(address,address) view returns(address)']);
  const factory3 = new Interface(['function getPool(address,address,uint24) view returns(address)']);
  const pair = new Interface(['function token0() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)']);
  const pool = new Interface(['function liquidity() view returns(uint128)']);
  const multicall = new Contract(BNB_CHAIN.multicall, ['function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[])'], provider);
  async function batch(calls, blockTag) {
    const results = [];
    for (let i = 0; i < calls.length; i += 80) results.push(...await multicall.aggregate3.staticCall(calls.slice(i, i + 80), blockTag === undefined ? {} : { blockTag }));
    return results;
  }
  const pairs = await batch(unique.map(token => ({ target: chain.v2Factory, allowFailure: true, callData: factory2.encodeFunctionData('getPair', [chain.weth, token.address]) })));
  const overlaps = unique.flatMap((token, i) => {
    if (!pairs[i].success) return [];
    const v2Pair = factory2.decodeFunctionResult('getPair', pairs[i].returnData)[0];
    return v2Pair === ZeroAddress ? [] : [{ token: token.address, symbol: token.symbol, v2Pair }];
  });
  const states = await batch(overlaps.flatMap(route => ['token0', 'getReserves'].map(method => ({ target: route.v2Pair, allowFailure: true, callData: pair.encodeFunctionData(method) }))));
  const liquid = overlaps.filter((route, i) => {
    if (!states[i * 2].success || !states[i * 2 + 1].success) return false;
    const first = pair.decodeFunctionResult('token0', states[i * 2].returnData)[0];
    const [r0, r1] = pair.decodeFunctionResult('getReserves', states[i * 2 + 1].returnData);
    return (first.toLowerCase() === chain.weth.toLowerCase() ? r0 : r1) >= parseEther(chain.id === 56 ? '0.05' : '0.001');
  });
  const lookups = liquid.flatMap(route => chain.fees.map(fee => ({ ...route, fee })));
  const pools = await batch(lookups.map(route => ({ target: chain.v3Factory, allowFailure: true, callData: factory3.encodeFunctionData('getPool', [chain.weth, route.token, route.fee]) })));
  const routes = lookups.flatMap((route, i) => {
    if (!pools[i].success) return [];
    const v3Pool = factory3.decodeFunctionResult('getPool', pools[i].returnData)[0];
    return v3Pool === ZeroAddress ? [] : [{ ...route, v3Pool }];
  });
  const liquidity = await batch(routes.map(route => ({ target: route.v3Pool, allowFailure: true, callData: pool.encodeFunctionData('liquidity') })));
  const active = routes.filter((_, i) => liquidity[i].success && pool.decodeFunctionResult('liquidity', liquidity[i].returnData)[0] > 0n);
  const gasPrice = (await provider.getFeeData()).gasPrice;
  if (!gasPrice) throw new Error('Gas price unavailable');
  let extraFee = 0n;
  if (chain.id === 8453) {
    const oracle = new Contract('0x420000000000000000000000000000000000000F', ['function getL1FeeUpperBound(uint256) view returns(uint256)'], provider);
    extraFee = await oracle.getL1FeeUpperBound(600);
  }
  // Arbitrum total fees require transaction-specific estimation. Report only
  // optimistic leads there, never label a gasPrice-only quote a net profit.
  const completeFeeModel = chain.id !== 42161;
  if (chain.id === 56 && gasPrice > config.maxGasPriceWei) throw new Error('Current BNB gas price exceeds the live cap');
  const gasCeilingWei = chain.id === 56 ? config.gasLimit * gasPrice : 600000n * gasPrice + extraFee;
  const minNetProfitWei = chain.id === 56 ? config.minNetProfitWei : parseEther('0.000005');
  const sizes = process.env.SCOUT_TRADE_SIZES_NATIVE ? process.env.SCOUT_TRADE_SIZES_NATIVE.split(',').map(value => parseEther(value.trim())) : chain.id === 56 ? config.sizes : ['0.00000001', '0.0000001', '0.000001', '0.00001', '0.0001', '0.0005', '0.001', '0.005'].map(parseEther);
  if (sizes.some(size => size <= 0n)) throw new Error('Scout sizes must be positive');
  const block = await provider.getBlockNumber();
  const start = Date.now();
  const v2Fees = { v2FeeNumerator: chain.v2FeeNumerator, v2FeeDenominator: chain.v2FeeDenominator };
  const screened = await screenMixedRoutes(provider, { routes: active, weth: chain.weth, multicallAddress: BNB_CHAIN.multicall, maxAmountIn: sizes.reduce((a, b) => a > b ? a : b), gasCeilingWei, minNetProfitWei, blockTag: block, ...v2Fees });
  const stats = { attempts: 0, valid: 0, rejected: 0, errors: 0, routeErrors: 0 };
  const qualified = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < screened.candidates.length) {
      const { route, direction } = screened.candidates[cursor++];
      try {
        const quotes = await quoteMixed(provider, { weth: chain.weth, token: route.token, v2Pair: route.v2Pair, fee: route.fee, direction, sizes, gasCeilingWei, minNetProfitWei, quoterAddress: chain.quoter, multicallAddress: BNB_CHAIN.multicall, blockTag: block, stats, ...v2Fees });
        if (quotes.length) qualified.push({ ...route, direction, amountIn: formatEther(quotes[0].amountIn), gross: formatEther(quotes[0].grossProfit), netFloor: formatEther(quotes[0].netFloor) });
      } catch (error) { stats.routeErrors++; stats.lastError = String(error.shortMessage || error.message).slice(0, 180); }
    }
  }));
  const result = { at: new Date().toISOString(), chain: name, chainId: chain.id, block, tokenSource: chain.tokenUrl, sizes: sizes.map(formatEther), tokens: unique.length, v2Pairs: overlaps.length, liquidV2Pairs: liquid.length, activeV3Overlaps: active.length, screenedDirections: screened.directionsScreened, upperBoundLeads: screened.candidates.length, durationMs: Date.now() - start, feeModelComplete: completeFeeModel, gasCeilingNative: formatEther(gasCeilingWei), extraFeeNative: formatEther(extraFee), minimumNetNative: formatEther(minNetProfitWei), diagnostics: { ...stats, bestNetFloorWei: stats.bestNetFloorWei?.toString() ?? null }, qualified, note: 'Read-only quotes. Larger sizes require capital or a different flash-credit executor. These are not simulated executor results, included trades, or proven profit. Arbitrum fee estimates are incomplete.' };
  mkdirSync('data/scouts', { recursive: true });
  writeFileSync(`data/scouts/${name}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { provider.destroy(); }
