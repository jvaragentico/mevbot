import 'dotenv/config';
import { JsonRpcProvider, formatEther, parseEther, parseUnits } from 'ethers';
import { hopState, pairState } from '../src/chain.js';
import { selectOpportunity, selectRouteOpportunity } from '../src/math.js';

const { RPC_URL, BUY_PAIR_ADDRESS, SELL_PAIR_ADDRESS, WETH_ADDRESS, TOKEN_ADDRESS, ROUTE_PAIRS, ROUTE_TOKENS } = process.env;
if (![RPC_URL, WETH_ADDRESS, TOKEN_ADDRESS].every(Boolean)) throw new Error('Set RPC_URL, WETH_ADDRESS, and TOKEN_ADDRESS in .env');
if (!ROUTE_PAIRS && ![BUY_PAIR_ADDRESS, SELL_PAIR_ADDRESS].every(Boolean)) throw new Error('Set both pair addresses or ROUTE_PAIRS/ROUTE_TOKENS in .env');
const provider = new JsonRpcProvider(RPC_URL);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const sizes = (process.env.TRADE_SIZES_WETH ?? '0.001,0.002,0.005').split(',').map(s => parseEther(s.trim()));
const gasCeiling = BigInt(process.env.GAS_LIMIT ?? '400000') * parseUnits(process.env.MAX_FEE_GWEI ?? '2', 'gwei');
const minProfit = parseEther(process.env.MIN_NET_PROFIT_WETH ?? '0.00002');
if (ROUTE_PAIRS) {
  const pairs = ROUTE_PAIRS.split(',').map(x => x.trim());
  const tokens = ROUTE_TOKENS.split(',').map(x => x.trim());
  if (tokens.length !== pairs.length + 1) throw new Error('Route token count must be pair count + 1');
  const states = await Promise.all(pairs.map((pair, i) => hopState(provider, pair, tokens[i], tokens[i + 1])));
  const opportunity = selectRouteOpportunity(sizes, states, gasCeiling, minProfit);
  console.log(JSON.stringify({ route: pairs, reserves: states.map(s => ({ inRaw: s.reserveIn.toString(), outRaw: s.reserveOut.toString() })), currentNetFloorWeth: opportunity ? formatEther(opportunity.netFloor) : null, bestSizeWeth: opportunity ? formatEther(opportunity.amountIn) : null }, null, 2));
} else {
  const [buy, sell] = await Promise.all([
    pairState(provider, BUY_PAIR_ADDRESS, WETH_ADDRESS, TOKEN_ADDRESS),
    pairState(provider, SELL_PAIR_ADDRESS, WETH_ADDRESS, TOKEN_ADDRESS),
  ]);
  const opportunity = selectOpportunity(sizes, buy, sell, gasCeiling, minProfit);
  console.log(JSON.stringify({ buyPair: buy.address, sellPair: sell.address, currentNetFloorWeth: opportunity ? formatEther(opportunity.netFloor) : null }, null, 2));
}
