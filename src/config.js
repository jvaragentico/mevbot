import 'dotenv/config';
import { getAddress, parseEther, parseUnits } from 'ethers';

function address(name, required = true) {
  const value = process.env[name];
  if (!value) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  return getAddress(value);
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig() {
  const network = process.env.NETWORK ?? 'sepolia';
  if (!['sepolia', 'mainnet'].includes(network)) throw new Error('NETWORK must be sepolia or mainnet');
  const chainId = network === 'sepolia' ? 11155111 : 1;
  const mode = process.env.BOT_MODE ?? 'observe';
  if (!['observe', 'live'].includes(mode)) throw new Error('BOT_MODE must be observe or live');
  if (mode === 'live' && network !== 'sepolia') throw new Error('Live trading is restricted to Sepolia during testnet validation');
  const routePairs = process.env.ROUTE_PAIRS ? process.env.ROUTE_PAIRS.split(',').map(value => getAddress(value.trim())) : null;
  const routeTokens = process.env.ROUTE_TOKENS ? process.env.ROUTE_TOKENS.split(',').map(value => getAddress(value.trim())) : null;
  if (!!routePairs !== !!routeTokens) throw new Error('Set ROUTE_PAIRS and ROUTE_TOKENS together');
  if (routePairs && (routePairs.length < 2 || routePairs.length > 4 || routeTokens.length !== routePairs.length + 1)) throw new Error('Route needs 2-4 pairs and one more token than pairs');
  const sizes = (process.env.TRADE_SIZES_WETH ?? '0.001,0.002,0.005').split(',').map(s => parseEther(s.trim()));
  if (sizes.length === 0 || sizes.some(x => x <= 0n)) throw new Error('TRADE_SIZES_WETH must contain positive amounts');
  const maxFeePerGas = parseUnits(process.env.MAX_FEE_GWEI ?? '2', 'gwei');
  const maxPriorityFeePerGas = parseUnits(process.env.MAX_PRIORITY_FEE_GWEI ?? '0.1', 'gwei');
  if (maxPriorityFeePerGas > maxFeePerGas) throw new Error('Priority fee exceeds max fee');
  return {
    network, chainId, mode,
    rpcUrl: process.env.RPC_URL ?? '',
    executorKey: process.env.EXECUTOR_KEY ?? '',
    reputationKey: process.env.FB_REPUTATION_KEY ?? '',
    buyPair: address('BUY_PAIR_ADDRESS', mode === 'live' && !routePairs),
    sellPair: address('SELL_PAIR_ADDRESS', mode === 'live' && !routePairs),
    weth: address('WETH_ADDRESS', mode === 'live'),
    token: address('TOKEN_ADDRESS', mode === 'live'),
    arbContract: address('ARB_CONTRACT_ADDRESS', mode === 'live'),
    routePairs, routeTokens,
    sizes,
    minNetProfitWei: parseEther(process.env.MIN_NET_PROFIT_WETH ?? '0.00002'),
    gasLimit: BigInt(positiveInteger('GAS_LIMIT', 400000)),
    maxFeePerGas, maxPriorityFeePerGas,
    dashboardPort: positiveInteger('DASHBOARD_PORT', 8787),
  };
}
