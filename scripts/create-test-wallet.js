import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Wallet } from 'ethers';

if (existsSync('.env')) throw new Error('.env already exists; refusing to overwrite private keys');
const executor = Wallet.createRandom();
const reputation = Wallet.createRandom();
let example = readFileSync('.env.example', 'utf8');
example = example.replace(/^EXECUTOR_KEY=$/m, `EXECUTOR_KEY=${executor.privateKey}`);
example = example.replace(/^FB_REPUTATION_KEY=$/m, `FB_REPUTATION_KEY=${reputation.privateKey}`);
writeFileSync('.env', example, { flag: 'wx', mode: 0o600 });
console.log(`Sepolia funding address: ${executor.address}`);
console.log('Private keys are saved only in ignored .env. Keep a backup and never paste them into chat.');
