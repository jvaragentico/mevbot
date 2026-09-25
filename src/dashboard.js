import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { loadConfig } from './config.js';
import { snapshot } from './journal.js';

const config = loadConfig();
const monitoredContract = process.env.VERIFIED_ARB_CONTRACT_ADDRESS ? getAddress(process.env.VERIFIED_ARB_CONTRACT_ADDRESS) : config.arbContract;
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));
const executorAddress = config.executorKey ? new Wallet(config.executorKey).address : null;
const provider = config.rpcUrl ? new JsonRpcProvider(config.rpcUrl) : null;
const weth = provider && config.weth ? new Contract(config.weth, [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
], provider) : null;
let walletCache = { at: 0, value: { address: executorAddress, ethBalanceWei: null } };

async function walletStatus() {
  if (!executorAddress || !provider) return walletCache.value;
  if (Date.now() - walletCache.at < 15_000) return walletCache.value;
  try {
    const [eth, block, wethBalance, allowance] = await Promise.allSettled([
      provider.getBalance(executorAddress),
      provider.getBlockNumber(),
      weth ? weth.balanceOf(executorAddress) : Promise.resolve(null),
      weth && monitoredContract ? weth.allowance(executorAddress, monitoredContract) : Promise.resolve(null),
    ]);
    walletCache = { at: Date.now(), value: {
      address: executorAddress,
      ethBalanceWei: eth.status === 'fulfilled' ? eth.value.toString() : null,
      wethBalanceWei: wethBalance.status === 'fulfilled' && wethBalance.value !== null ? wethBalance.value.toString() : null,
      wethAllowanceWei: allowance.status === 'fulfilled' && allowance.value !== null ? allowance.value.toString() : null,
      blockNumber: block.status === 'fulfilled' ? block.value : null,
      arbContract: monitoredContract,
    } };
  } catch (error) {
    walletCache = { at: Date.now(), value: { address: executorAddress, ethBalanceWei: null, error: error.message } };
  }
  return walletCache.value;
}

const server = createServer(async (req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...snapshot(), wallet: await walletStatus() }));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(await readFile(htmlPath));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});
server.listen(config.dashboardPort, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${config.dashboardPort}`);
});
