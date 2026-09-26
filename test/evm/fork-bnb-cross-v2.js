import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, Contract, ContractFactory, formatEther, parseEther, parseUnits } from 'ethers';
import { BNB_CHAIN } from '../../src/bnb-chain.js';

// Uses a throwaway Ganache account on a private fork. Never imports the live wallet.
const evm = ganache.provider({ fork: { url: process.env.BNB_FORK_URL || BNB_CHAIN.rpc }, logging: { quiet: true }, wallet: { defaultBalance: 100 } });
const provider = new BrowserProvider(evm);
try {
  const owner = await provider.getSigner(0);
  const source = readFileSync('contracts/AtomicV2Arb.sol', 'utf8');
  const input = { language: 'Solidity', sources: { 'AtomicV2Arb.sol': { content: source } }, settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = compiled.errors?.filter(item => item.severity === 'error') || [];
  if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join('\n'));
  const artifact = compiled.contracts['AtomicV2Arb.sol'].AtomicV2Arb;
  const token = process.argv[2] || '0xD939A056C59d112876D508b5ecBF98FAfB6AD978';
  const uniPair = process.argv[3] || '0xE99784C626de4d7eDB7391Fffe737C1A6eEDf62B';
  const cakePair = process.argv[4] || '0x82078A2AEAd249eB799492ff5B55220c39ffeE0D';
  const amountIn = parseEther(process.argv[5] || '0.005');
  const wbnb = new Contract(BNB_CHAIN.wbnb, ['function deposit() payable', 'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)'], owner);
  const arb = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, owner).deploy(BNB_CHAIN.wbnb, token);
  await arb.waitForDeployment();
  await (await wbnb.deposit({ value: parseEther('0.02') })).wait();
  await (await wbnb.approve(arb.target, amountIn)).wait();
  const before = await wbnb.balanceOf(owner.address);
  try {
    const gross = await arb.execute.staticCall(uniPair, cakePair, amountIn, 1n);
    const gas = await arb.execute.estimateGas(uniPair, cakePair, amountIn, 1n);
    const gasCeiling = gas * parseUnits('0.2', 'gwei');
    const receipt = await (await arb.execute(uniPair, cakePair, amountIn, 1n)).wait();
    const after = await wbnb.balanceOf(owner.address);
    console.log(JSON.stringify({ forkBlock: await provider.getBlockNumber(), amountInWbnb: formatEther(amountIn), simulatedGrossWbnb: formatEther(gross), receiptGrossWbnb: formatEther(after - before), gasEstimate: String(gas), gasUsed: String(receipt.gasUsed), netAtCappedGasWbnb: formatEther(after - before - gasCeiling), success: receipt.status === 1 }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ forkBlock: await provider.getBlockNumber(), amountInWbnb: formatEther(amountIn), executable: false, reason: String(error?.shortMessage ?? error?.message ?? error).slice(0, 180) }, null, 2));
  }
} finally {
  evm.disconnect();
}
