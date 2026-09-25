import 'dotenv/config';
import { Contract, JsonRpcProvider, ZeroAddress, getAddress } from 'ethers';
import { pairState } from '../src/chain.js';

const factoryAddress = getAddress(process.argv[2] ?? '0xF62c03E08ada871A0bEb309762E260a7a6a880E6');
const token = getAddress(process.argv[3] ?? process.env.TOKEN_ADDRESS ?? '');
const weth = getAddress(process.env.WETH_ADDRESS ?? '');
const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const factory = new Contract(factoryAddress, ['function getPair(address,address) view returns (address)'], provider);
const pairAddress = await factory.getPair(weth, token);
if (pairAddress === ZeroAddress) {
  console.log('No WETH/token pair at this factory.');
} else {
  const state = await pairState(provider, pairAddress, weth, token);
  console.log(JSON.stringify({ factory: factoryAddress, pair: pairAddress, wethReserveWei: state.weth.toString(), tokenReserveRaw: state.token.toString() }, null, 2));
}
