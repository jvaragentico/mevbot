import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonRpcProvider } from 'ethers';
import { BNB_CHAIN } from '../src/bnb-chain.js';
import { loadBnbConfig } from '../src/bnb-config.js';
import { BNB_BASELINE_PATH, formatUsd8, readBnbValuation } from '../src/bnb-risk.js';

const config = loadBnbConfig();
const provider = new JsonRpcProvider(config.rpcUrl);
if ((await provider.getNetwork()).chainId !== BNB_CHAIN.chainId) throw new Error('Expected BNB Smart Chain');
const value = await readBnbValuation(provider, config.expectedAddress);
const baseline = {
  at: new Date().toISOString(), chainId: Number(BNB_CHAIN.chainId), address: config.expectedAddress,
  nativeWei: String(value.nativeWei), wrappedWei: String(value.wrappedWei),
  priceUsd8: String(value.priceUsd8), priceUpdatedAt: value.priceUpdatedAt,
  priceFeed: value.priceFeed, valueUsd8: String(value.valueUsd8),
};
mkdirSync(dirname(BNB_BASELINE_PATH), { recursive: true });
try { writeFileSync(BNB_BASELINE_PATH, JSON.stringify(baseline, null, 2), { flag: 'wx' }); }
catch (error) { if (error.code === 'EEXIST') throw new Error('BNB baseline already exists; refusing to reset the $15 loss reference'); throw error; }
console.log(`Saved BNB+WBNB baseline: $${formatUsd8(value.valueUsd8)} for ${config.expectedAddress} at ${baseline.at}`);
