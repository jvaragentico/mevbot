import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import solc from 'solc';

const files = ['AtomicV2Arb.sol', 'AtomicV2V3Arb.sol', 'AtomicVerifiedMixedArb.sol'];
const input = {
  language: 'Solidity',
  sources: Object.fromEntries(files.map(file => [file, { content: readFileSync(`contracts/${file}`, 'utf8') }])),
  settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors?.filter(e => e.severity === 'error') ?? [];
if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
mkdirSync('artifacts', { recursive: true });
for (const file of files) {
  const name = file.slice(0, -4);
  const contract = output.contracts[file][name];
  writeFileSync(`artifacts/${name}.json`, JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2));
  console.log(`Compiled ${name} with solc ${solc.version()}`);
}
