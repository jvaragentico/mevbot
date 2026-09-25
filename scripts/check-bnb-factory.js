import { Contract, JsonRpcProvider } from 'ethers';

const provider = new JsonRpcProvider('https://bsc-dataseed.bnbchain.org');
if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Expected BNB Smart Chain');
const factory = new Contract('0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', ['function allPairsLength() view returns(uint256)'], provider);
console.log(JSON.stringify({ chainId: 56, block: await provider.getBlockNumber(), v2Pairs: (await factory.allPairsLength()).toString() }));
