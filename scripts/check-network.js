import 'dotenv/config';
import { JsonRpcProvider, Wallet } from 'ethers';
import MevShareClientPackage from '@flashbots/mev-share-client';

const rpc = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const MevShareClient = MevShareClientPackage.default;
const provider = new JsonRpcProvider(rpc);
const network = await provider.getNetwork();
if (network.chainId !== 11155111n) throw new Error(`Expected Sepolia (11155111), got ${network.chainId}`);
console.log(`Sepolia RPC connected at block ${await provider.getBlockNumber()}`);
const client = MevShareClient.useEthereumSepolia(Wallet.createRandom().connect(provider));
try {
  const info = await client.getEventHistoryInfo();
  console.log(`Flashbots MEV-Share Sepolia event history: ${JSON.stringify(info)}`);
} catch (error) {
  console.error(`Flashbots MEV-Share endpoint check failed: ${error.message}`);
  process.exitCode = 1;
}
