import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Contract, Interface, JsonRpcProvider, formatEther, id, zeroPadValue } from 'ethers';

const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const factory = '0xF62c03E08ada871A0bEb309762E260a7a6a880E6';
const weth = process.env.WETH_ADDRESS || '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const lookback = Number(process.env.LOOKBACK_BLOCKS || '1000000');
if (!Number.isSafeInteger(lookback) || lookback < 1 || lookback > 3000000) throw new Error('LOOKBACK_BLOCKS must be 1 to 3,000,000');
const to = await provider.getBlockNumber();
const from = Math.max(0, to - lookback);
const topic = id('PairCreated(address,address,address,uint256)');
const wethTopic = zeroPadValue(weth, 32);
const iface = new Interface(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256)']);
const windows = [];
for (let start = from; start <= to; start += 49_999) windows.push([start, Math.min(to, start + 49_998)]);
let cursor = 0;
const logs = [];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < windows.length) {
    const [start, end] = windows[cursor++];
    const [first, second] = await Promise.all([
      provider.getLogs({ address: factory, fromBlock: start, toBlock: end, topics: [topic, wethTopic] }),
      provider.getLogs({ address: factory, fromBlock: start, toBlock: end, topics: [topic, null, wethTopic] }),
    ]);
    logs.push(...first, ...second);
  }
}));
console.log(`Scanned ${from}-${to}: ${logs.length} Uniswap V2 WETH pairs created`);

const pairs = logs.map(log => {
  const event = iface.parseLog(log);
  return { address: event.args.pair, token0: event.args.token0, token: event.args.token0.toLowerCase() === weth.toLowerCase() ? event.args.token1 : event.args.token0 };
});
const active = [];
const reserveInterface = new Interface(['function getReserves() view returns(uint112,uint112,uint32)']);
const multicall = new Contract('0xcA11bde05977b3631167028862bE2a173976CA11', [
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[])',
], provider);
for (let offset = 0; offset < pairs.length; offset += 100) {
  const slice = pairs.slice(offset, offset + 100);
  const calls = slice.map(pair => ({ target: pair.address, allowFailure: true, callData: reserveInterface.encodeFunctionData('getReserves') }));
  const results = await multicall.aggregate3.staticCall(calls);
  for (let i = 0; i < results.length; i++) {
    if (!results[i].success) continue;
    const reserves = reserveInterface.decodeFunctionResult('getReserves', results[i].returnData);
    const pair = slice[i];
    const wethReserve = pair.token0.toLowerCase() === weth.toLowerCase() ? reserves[0] : reserves[1];
    if (wethReserve >= 10n ** 16n) active.push({ address: pair.address, token: pair.token, wethReserveWei: wethReserve.toString(), wethReserve: formatEther(wethReserve) });
  }
}
active.sort((a, b) => BigInt(a.wethReserveWei) > BigInt(b.wethReserveWei) ? -1 : 1);
mkdirSync('data', { recursive: true });
writeFileSync('data/uniswap-pools.json', JSON.stringify({ at: new Date().toISOString(), from, to, pairsChecked: pairs.length, liquidPairs: active }, null, 2));
console.log(JSON.stringify({ pairsChecked: pairs.length, liquidPairCount: active.length, savedTo: 'data/uniswap-pools.json', top20: active.slice(0, 20) }, null, 2));
