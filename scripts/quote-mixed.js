import { JsonRpcProvider, formatEther, getAddress } from 'ethers';
import { loadConfig } from '../src/config.js';
import { quoteMixed } from '../src/mixed.js';

const config = loadConfig();
if (config.chainId !== 11155111) throw new Error('Expected Sepolia configuration');
const token = getAddress(process.argv[2]);
const v2Pair = getAddress(process.argv[3]);
const fee = Number(process.argv[4]);
const direction = process.argv[5];
if (!Number.isInteger(fee) || !['V3-to-V2', 'V2-to-V3'].includes(direction)) throw new Error('Usage: npm run quote-mixed -- <token> <v2-pair> <fee> <V3-to-V2|V2-to-V3>');
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('Expected Sepolia RPC');
const candidates = await quoteMixed(provider, {
  weth: config.weth, token, v2Pair, fee, direction, sizes: config.sizes,
  gasCeilingWei: 600000n * config.maxFeePerGas,
  minNetProfitWei: config.minNetProfitWei,
});
console.log(JSON.stringify({ direction, token, v2Pair, fee, candidates: candidates.map(c => ({
  amountInWeth: formatEther(c.amountIn), quotedGrossWeth: formatEther(c.grossProfit),
  quotedNetFloorWeth: formatEther(c.netFloor), v3GasEstimate: c.v3Gas.toString(),
})), note: 'Quote only. The deployed executor must pass eth_call and estimateGas before trading.' }, null, 2));
