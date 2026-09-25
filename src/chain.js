import { Contract, Interface, getAddress, id } from 'ethers';

export const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)',
];
export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
export const ARB_ABI = [
  'function owner() view returns (address)',
  'function weth() view returns (address)',
  'function token() view returns (address)',
  'function execute(address,address,uint256,uint256) returns (uint256)',
  'function executeRoute(address[],address[],uint256,uint256) returns (uint256)',
  'error NotProfitable()',
  'event ArbExecuted(address indexed buyPair,address indexed sellPair,uint256 amountIn,uint256 grossProfit)',
  'event RouteExecuted(bytes32 indexed routeHash,uint256 amountIn,uint256 grossProfit)',
];
const syncInterface = new Interface(['event Sync(uint112 reserve0,uint112 reserve1)']);
const syncTopic = id('Sync(uint112,uint112)').toLowerCase();

export async function pairState(provider, address, weth, token) {
  const pair = new Contract(address, PAIR_ABI, provider);
  const [token0, token1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
  if (getAddress(token0) !== getAddress(weth) && getAddress(token0) !== getAddress(token)) throw new Error(`Unexpected token0 in ${address}`);
  if (getAddress(token1) !== getAddress(weth) && getAddress(token1) !== getAddress(token)) throw new Error(`Unexpected token1 in ${address}`);
  if (getAddress(token0) === getAddress(token1)) throw new Error(`Invalid pair ${address}`);
  return {
    address: getAddress(address), token0: getAddress(token0), token1: getAddress(token1),
    weth: getAddress(token0) === getAddress(weth) ? reserves[0] : reserves[1],
    token: getAddress(token0) === getAddress(token) ? reserves[0] : reserves[1],
  };
}

export async function hopState(provider, address, input, output) {
  const pair = new Contract(address, PAIR_ABI, provider);
  const [token0, token1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
  const a = getAddress(token0), b = getAddress(token1);
  if (!((a === getAddress(input) && b === getAddress(output)) || (a === getAddress(output) && b === getAddress(input)))) {
    throw new Error(`Pair ${address} does not contain ${input} and ${output}`);
  }
  return {
    address: getAddress(address), token0: a, token1: b,
    reserveIn: a === getAddress(input) ? reserves[0] : reserves[1],
    reserveOut: a === getAddress(input) ? reserves[1] : reserves[0],
  };
}

export function isRelatedToPair(pending, pairAddress) {
  const target = pairAddress.toLowerCase();
  return pending.to?.toLowerCase() === target
    || (pending.txs ?? []).some(tx => tx.to?.toLowerCase() === target)
    || (pending.logs ?? []).some(log => log.address?.toLowerCase() === target);
}

export function postReservesFromHints(pending, pairAddress, token0, weth, token) {
  const target = pairAddress.toLowerCase();
  const log = [...(pending.logs ?? [])].reverse().find(l =>
    l.address?.toLowerCase() === target && l.topics?.[0]?.toLowerCase() === syncTopic && typeof l.data === 'string' && l.data.length === 130
  );
  if (!log) return null;
  try {
    const parsed = syncInterface.parseLog(log);
    if (!parsed) return null;
    return {
      weth: token0.toLowerCase() === weth.toLowerCase() ? parsed.args.reserve0 : parsed.args.reserve1,
      token: token0.toLowerCase() === token.toLowerCase() ? parsed.args.reserve0 : parsed.args.reserve1,
    };
  } catch { return null; }
}

export function parseArbProfit(receipt, arbAddress) {
  const iface = new Interface(ARB_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== arbAddress.toLowerCase()) continue;
    try {
      const event = iface.parseLog(log);
      if (event?.name === 'ArbExecuted' || event?.name === 'RouteExecuted') return event.args.grossProfit;
    } catch { /* Unrelated contract event. */ }
  }
  return null;
}
