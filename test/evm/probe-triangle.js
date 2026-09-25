import ganache from 'ganache';
import { BrowserProvider, Contract, formatEther, parseEther } from 'ethers';
import { getAmountOut } from '../../src/math.js';

const rpc = process.env.FORK_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const evm = ganache.provider({ fork: { url: rpc }, logging: { quiet: true }, wallet: { defaultBalance: 1000 } });
try {
  const provider = new BrowserProvider(evm);
  const signer = await provider.getSigner(0);
  const route = [
    { pair: '0x81649680e1179adcff5fa3a4b92ff2950dabf484', from: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14', to: '0x40459bB62bB1fc145783AEdE406344de4b1B8838' },
    { pair: '0x58948448d3a1b84f2fb4bF6d8825e121bE3A39E0', from: '0x40459bB62bB1fc145783AEdE406344de4b1B8838', to: '0x408b47C20fF5E6cf387D85Bd6671A8921E616FE0' },
    { pair: '0x3b42751Df3d9c8E5bd868c7D965DDaFcbdE815CE', from: '0x408b47C20fF5E6cf387D85Bd6671A8921E616FE0', to: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' },
  ];
  const erc20 = ['function deposit() payable', 'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)'];
  const pairAbi = ['function token0() view returns(address)', 'function token1() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)', 'function swap(uint256,uint256,address,bytes)'];
  const weth = new Contract(route[0].from, erc20, signer);
  const amountIn = parseEther('0.001');
  await (await weth.deposit({ value: amountIn })).wait();
  let amount = amountIn;
  for (const hop of route) {
    const pair = new Contract(hop.pair, pairAbi, signer);
    const [token0, reserves] = await Promise.all([pair.token0(), pair.getReserves()]);
    const inIsZero = token0.toLowerCase() === hop.from.toLowerCase();
    const reserveIn = inIsZero ? reserves[0] : reserves[1];
    const reserveOut = inIsZero ? reserves[1] : reserves[0];
    const out = getAmountOut(amount, reserveIn, reserveOut);
    const inputToken = new Contract(hop.from, erc20, signer);
    await (await inputToken.transfer(hop.pair, amount)).wait();
    const trade = await pair.swap(inIsZero ? 0 : out, inIsZero ? out : 0, signer.address, '0x');
    await trade.wait();
    amount = out;
    console.log(`Swap ${hop.from} -> ${hop.to}: ${out} raw units`);
  }
  const finalBalance = await weth.balanceOf(signer.address);
  console.log(`Fork round trip: input ${formatEther(amountIn)} WETH; output ${formatEther(finalBalance)} WETH; gross gain ${formatEther(finalBalance - amountIn)} WETH`);
} finally { evm.disconnect(); }
