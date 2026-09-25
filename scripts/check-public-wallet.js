import { Contract, JsonRpcProvider, formatEther, formatUnits, getAddress } from 'ethers';

const address = getAddress(process.argv[2]);
const networks = [
  { name: 'Ethereum', chainId: 1n, rpc: 'https://ethereum-rpc.publicnode.com', native: 'ETH', tokens: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  ] },
  { name: 'BNB Smart Chain', chainId: 56n, rpc: 'https://bsc-dataseed.bnbchain.org', native: 'BNB', tokens: [
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    '0x55d398326f99059ff775485246999027b3197955',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    '0xe9e7cea3dedca5984780bafc599bd69add087d56',
  ] },
];
for (const network of networks) {
  try {
    const provider = new JsonRpcProvider(network.rpc);
    const chain = await provider.getNetwork();
    if (chain.chainId !== network.chainId) throw new Error(`Unexpected chain ${chain.chainId}`);
    const [nativeBalance, block, tokens] = await Promise.all([
      provider.getBalance(address), provider.getBlockNumber(), Promise.all(network.tokens.map(async tokenAddress => {
        const token = new Contract(tokenAddress, ['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)'], provider);
        try {
          const [balance, decimals, symbol] = await Promise.all([token.balanceOf(address), token.decimals(), token.symbol()]);
          return { tokenAddress, symbol, balance: formatUnits(balance, decimals) };
        } catch (error) { return { tokenAddress, error: String(error?.shortMessage ?? error?.message ?? error).slice(0, 80) }; }
      })),
    ]);
    console.log(JSON.stringify({ network: network.name, chainId: Number(network.chainId), block, address, native: `${formatEther(nativeBalance)} ${network.native}`, tokens }));
  } catch (error) {
    console.error(JSON.stringify({ network: network.name, error: String(error?.shortMessage ?? error?.message ?? error).slice(0, 160) }));
    process.exitCode = 1;
  }
}
