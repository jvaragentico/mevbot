import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Contract, parseUnits } from 'ethers';
import { BNB_CHAIN } from './bnb-chain.js';

export const BNB_USD_FEED = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
export const BNB_BASELINE_PATH = 'data/bnb-baseline.json';
export const BNB_STOP_PATH = 'data/bnb-stop.json';
const ORACLE_ABI = [
  'function decimals() view returns(uint8)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
];
const WBNB_ABI = ['function balanceOf(address) view returns(uint256)'];
const USD_SCALE = 100000000n;

export function usd8FromBnbWei(bnbWei, priceUsd8) {
  return bnbWei * priceUsd8 / 1000000000000000000n;
}

export function assessWalletStop({ baselineUsd8, currentUsd8, limitUsd8, pendingGasUsd8 = 0n, latched = false }) {
  const declineUsd8 = baselineUsd8 - currentUsd8;
  const remainingUsd8 = limitUsd8 - declineUsd8;
  return {
    declineUsd8,
    remainingUsd8,
    stopped: latched || declineUsd8 >= limitUsd8,
    maySend: !latched && remainingUsd8 > pendingGasUsd8,
  };
}

export function loadBnbBaseline(expectedAddress, path = BNB_BASELINE_PATH) {
  if (!existsSync(path)) return null;
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  if (baseline.chainId !== Number(BNB_CHAIN.chainId) || baseline.address?.toLowerCase() !== expectedAddress.toLowerCase() || baseline.priceFeed?.toLowerCase() !== BNB_USD_FEED.toLowerCase() || !/^\d+$/.test(baseline.valueUsd8 || '')) {
    throw new Error('BNB wallet baseline is invalid or belongs to another wallet');
  }
  return baseline;
}

export function isBnbStopLatched(path = BNB_STOP_PATH) { return existsSync(path); }

export function latchBnbStop({ address, currentUsd8, baselineUsd8, limitUsd8, reason }, path = BNB_STOP_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), chainId: Number(BNB_CHAIN.chainId), address, currentUsd8: String(currentUsd8), baselineUsd8: String(baselineUsd8), limitUsd8: String(limitUsd8), reason }, null, 2), { flag: 'wx' });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export async function readBnbValuation(provider, address) {
  const oracle = new Contract(BNB_USD_FEED, ORACLE_ABI, provider);
  const wbnb = new Contract(BNB_CHAIN.wbnb, WBNB_ABI, provider);
  const [nativeWei, wrappedWei, round, decimals] = await Promise.all([
    provider.getBalance(address), wbnb.balanceOf(address), oracle.latestRoundData(), oracle.decimals(),
  ]);
  const answer = BigInt(round[1]);
  const updatedAt = BigInt(round[3]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (answer <= 0n || updatedAt <= 0n || updatedAt > now || now - updatedAt > 7200n) throw new Error('BNB/USD price feed is stale or invalid');
  if (decimals > 18n) throw new Error('BNB/USD price feed decimals are invalid');
  const priceUsd8 = decimals <= 8n ? answer * 10n ** (8n - decimals) : answer / 10n ** (decimals - 8n);
  if (priceUsd8 <= 0n) throw new Error('BNB/USD price feed is invalid');
  const totalWei = nativeWei + wrappedWei;
  return {
    address, nativeWei, wrappedWei, totalWei, priceUsd8,
    valueUsd8: usd8FromBnbWei(totalWei, priceUsd8),
    priceUpdatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
    priceFeed: BNB_USD_FEED,
  };
}

export function formatUsd8(value) {
  const negative = value < 0n;
  const positive = negative ? -value : value;
  return `${negative ? '-' : ''}${positive / USD_SCALE}.${String(positive % USD_SCALE).padStart(8, '0')}`;
}

export function parseUsd8(value) { return parseUnits(String(value), 8); }
