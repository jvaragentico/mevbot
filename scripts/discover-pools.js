import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet, ZeroAddress, formatEther, getAddress, id } from 'ethers';
import ClientPackage from '@flashbots/mev-share-client';
import { pairState } from '../src/chain.js';

const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const weth = getAddress(process.env.WETH_ADDRESS || '0xfff9976782d46cc05630d1f6ebab18b2324d6b14');
const client = ClientPackage.default.useEthereumSepolia(Wallet.createRandom().connect(provider));
const info = await client.getEventHistoryInfo();
const events = [];
for (let offset = 0; offset < 5000; offset += 500) {
  const page = await client.getEventHistory({ blockStart: info.maxBlock - 10000, blockEnd: info.maxBlock, limit: 500, offset });
  events.push(...page);
  if (page.length < 500) break;
}
console.log(`Scanned ${events.length} MEV-Share hints from the latest 10,000 blocks`);
const swapTopic = id('Swap(address,uint256,uint256,uint256,uint256,address)').toLowerCase();
const addresses = [...new Set(events.flatMap(event => event.hint?.logs ?? []).filter(log => log.topics?.[0]?.toLowerCase() === swapTopic).map(log => log.address.toLowerCase()))].slice(0, 80);
const factory = new Contract('0xF62c03E08ada871A0bEb309762E260a7a6a880E6', ['function getPair(address,address) view returns(address)'], provider);
for (const address of addresses) {
  try {
    const pair = new Contract(address, ['function token0() view returns(address)', 'function token1() view returns(address)', 'function factory() view returns(address)'], provider);
    const [a, b, sourceFactory] = await Promise.all([pair.token0(), pair.token1(), pair.factory()]);
    if (a.toLowerCase() !== weth.toLowerCase() && b.toLowerCase() !== weth.toLowerCase()) continue;
    const token = a.toLowerCase() === weth.toLowerCase() ? b : a;
    const officialPair = await factory.getPair(weth, token);
    const state = await pairState(provider, address, weth, token);
    let officialWeth = null;
    if (officialPair !== ZeroAddress && officialPair.toLowerCase() !== address) {
      officialWeth = formatEther((await pairState(provider, officialPair, weth, token)).weth);
    }
    console.log(JSON.stringify({ token, activePair: address, activeFactory: sourceFactory, activeWeth: formatEther(state.weth), uniswapPair: officialPair, uniswapWeth: officialWeth }));
  } catch { /* Event address may not be a V2 pair. */ }
}
