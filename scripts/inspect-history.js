import 'dotenv/config';
import { JsonRpcProvider, Wallet } from 'ethers';
import ClientPackage from '@flashbots/mev-share-client';

const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
const client = ClientPackage.default.useEthereumSepolia(Wallet.createRandom().connect(provider));
const info = await client.getEventHistoryInfo();
const events = await client.getEventHistory({ blockStart: info.maxBlock - 1000, blockEnd: info.maxBlock, limit: 20 });
for (const event of events) {
  console.log(JSON.stringify({ block: event.block, hash: event.hint?.hash, logs: event.hint?.logs?.map(l => ({ address: l.address, topic0: l.topics?.[0], dataLength: l.data?.length })) }));
}
