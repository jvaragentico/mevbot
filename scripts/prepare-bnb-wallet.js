import { Contract, JsonRpcProvider, MaxUint256, Wallet, formatEther, parseEther } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { loadBnbConfig } from '../src/bnb-config.js';
import { assessWalletStop, loadBnbBaseline, readBnbValuation, usd8FromBnbWei } from '../src/bnb-risk.js';

const config = loadBnbConfig();
if (!config.executorKey || !config.contractAddress) throw new Error('Import the BNB wallet and deploy the executor first');
const execute = process.argv[2] === '--execute';
if (process.argv[2] && !execute) throw new Error('Usage: npm run prepare-bnb-wallet -- [--execute]');
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== BNB_CHAIN.chainId) throw new Error('Expected BNB Smart Chain');
const wallet = new Wallet(config.executorKey, provider);
if (wallet.address.toLowerCase() !== config.expectedAddress.toLowerCase()) throw new Error('Private key does not match selected BNB wallet');
const wbnb = new Contract(BNB_CHAIN.wbnb, [
  'function deposit() payable',
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
], wallet);
const target = parseEther(process.env.BNB_WRAP_TARGET_WBNB || '0.015');
const [native, wrapped, allowance, feeData] = await Promise.all([
  provider.getBalance(wallet.address), wbnb.balanceOf(wallet.address), wbnb.allowance(wallet.address, config.contractAddress), provider.getFeeData(),
]);
const needed = target > wrapped ? target - wrapped : 0n;
const gasPrice = feeData.gasPrice;
if (!gasPrice || gasPrice > config.maxGasPriceWei) throw new Error('BNB gas price exceeds configured cap');
const setupGasCeiling = 150000n * gasPrice;
if (native < needed + config.nativeReserveWei + setupGasCeiling) throw new Error('Wrapping would leave too little native BNB for gas');
const baseline = loadBnbBaseline(config.expectedAddress);
if (!baseline) throw new Error('Set the fixed BNB wallet USD baseline before preparation');
const value = await readBnbValuation(provider, config.expectedAddress);
const risk = assessWalletStop({ baselineUsd8: BigInt(baseline.valueUsd8), currentUsd8: value.valueUsd8, limitUsd8: config.maxWalletLossUsd8, pendingGasUsd8: usd8FromBnbWei(setupGasCeiling, value.priceUsd8) });
if (!risk.maySend) throw new Error('Preparation could exceed the $15 wallet loss budget');
console.log(JSON.stringify({ wallet: wallet.address, nativeBnb: formatEther(native), currentWbnb: formatEther(wrapped), wrapBnb: formatEther(needed), gasReserveBnb: formatEther(config.nativeReserveWei), approvalNeeded: allowance < target, execute }, null, 2));
if (!execute) process.exit(0);
if (needed > 0n) {
  const tx = await wbnb.deposit({ value: needed, gasPrice });
  await tx.wait(1);
  console.log(`Wrapped BNB: ${tx.hash}`);
}
if (allowance < target) {
  const tx = await wbnb.approve(config.contractAddress, MaxUint256, { gasPrice });
  await tx.wait(1);
  console.log(`Approved immutable executor: ${tx.hash}`);
}
console.log('BNB wallet is prepared for the configured WBNB trade sizes.');
