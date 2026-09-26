import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { getAddress, parseEther, parseUnits } from 'ethers';
import { BNB_CHAIN } from './bnb-chain.js';

const localFile = '.env.bnb.local';
if (existsSync(localFile)) dotenv.config({ path: localFile, override: true });

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

export function loadBnbConfig() {
  const mode = process.env.BNB_BOT_MODE || process.env.BOT_MODE || 'observe';
  if (!['observe', 'live'].includes(mode)) throw new Error('BNB_BOT_MODE must be observe or live');
  const rpcUrl = process.env.BNB_RPC_URL || process.env.RPC_URL || BNB_CHAIN.rpc;
  const sizes = (process.env.BNB_TRADE_SIZES_WBNB || '0.00000001,0.0000001,0.000001,0.00001,0.0001,0.0005,0.001,0.005,0.01').split(',').map(value => parseEther(value.trim()));
  if (!sizes.length || sizes.some(value => value <= 0n)) throw new Error('BNB_TRADE_SIZES_WBNB must contain positive sizes');
  const expectedAddress = getAddress(process.env.BNB_EXPECTED_EXECUTOR_ADDRESS || '0x8041Cc720aBC7DA28B056439aa2932Dbb879c408');
  const contractAddress = process.env.BNB_ARB_CONTRACT_ADDRESS ? getAddress(process.env.BNB_ARB_CONTRACT_ADDRESS) : null;
  return {
    mode, rpcUrl, expectedAddress, contractAddress,
    executorKey: process.env.EXECUTOR_KEY || '', sizes,
    maxGasPriceWei: parseUnits(process.env.BNB_MAX_GAS_GWEI || '0.2', 'gwei'),
    gasLimit: BigInt(positiveNumber('BNB_GAS_LIMIT', 600000)),
    minNetProfitWei: parseEther(process.env.BNB_MIN_NET_PROFIT_WBNB || '0.00005'),
    nativeReserveWei: parseEther(process.env.BNB_GAS_RESERVE_BNB || '0.005'),
    maxDailyGasWei: parseEther(process.env.BNB_MAX_DAILY_GAS_BNB || '0.002'),
    maxWalletLossUsd8: parseUnits(process.env.BNB_MAX_WALLET_LOSS_USD || '15', 8),
    reviewAfterProfitableTrades: positiveNumber('BNB_REVIEW_AFTER_PROFITABLE_TRADES', 5),
    tickMs: positiveNumber('BNB_TICK_MS', 1000),
    maxQuoteAgeBlocks: positiveNumber('BNB_MAX_QUOTE_AGE_BLOCKS', 4),
    rescanHours: positiveNumber('BNB_RESCAN_HOURS', 6),
  };
}
