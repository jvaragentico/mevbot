import { Wallet } from 'ethers';

const raw = process.env.BNB_WALLET_KEY_IMPORT;
if (!raw || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error('Private key must be 32 hexadecimal bytes');
const wallet = new Wallet(raw.startsWith('0x') ? raw : `0x${raw}`);
console.log(wallet.address);
