import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, ContractFactory, Interface, parseEther } from 'ethers';
import { getAmountOut } from '../../src/math.js';

function compile() {
  const input = {
    language: 'Solidity',
    sources: {
      'AtomicV2Arb.sol': { content: readFileSync('contracts/AtomicV2Arb.sol', 'utf8') },
      'AtomicV2V3Arb.sol': { content: readFileSync('contracts/AtomicV2V3Arb.sol', 'utf8') },
      'AtomicVerifiedMixedArb.sol': { content: readFileSync('contracts/AtomicVerifiedMixedArb.sol', 'utf8') },
      'MockV2.sol': { content: readFileSync('test/fixtures/MockV2.sol', 'utf8') },
      'MockV3Router.sol': { content: readFileSync('test/fixtures/MockV3Router.sol', 'utf8') },
      'MockFactories.sol': { content: readFileSync('test/fixtures/MockFactories.sol', 'utf8') },
    },
    settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const result = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = result.errors?.filter(e => e.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  return result.contracts;
}

test('atomic trade reverts without edge and realizes positive net WETH after a pool move', async (t) => {
  const evm = ganache.provider({ logging: { quiet: true }, chain: { chainId: 11155111 }, wallet: { defaultBalance: 1000 } });
  t.after(() => evm.disconnect());
  const provider = new BrowserProvider(evm);
  const owner = await provider.getSigner(0);
  const victim = await provider.getSigner(1);
  const contracts = compile();
  async function deploy(file, name, args = []) {
    const artifact = contracts[file][name];
    const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, owner);
    const deployed = await factory.deploy(...args);
    await deployed.waitForDeployment();
    return deployed;
  }
  const weth = await deploy('MockV2.sol', 'MockERC20', ['Wrapped test ETH', 'WETH']);
  const token = await deploy('MockV2.sol', 'MockERC20', ['Test USD', 'TUSD']);
  const buy = await deploy('MockV2.sol', 'MockV2Pair', [weth.target, token.target]);
  const sell = await deploy('MockV2.sol', 'MockV2Pair', [weth.target, token.target]);
  const arb = await deploy('AtomicV2Arb.sol', 'AtomicV2Arb', [weth.target, token.target]);
  await (await weth.mint(owner.address, parseEther('300'))).wait();
  await (await token.mint(owner.address, parseEther('700000'))).wait();
  await (await token.mint(victim.address, parseEther('150000'))).wait();
  for (const pair of [buy, sell]) {
    await (await weth.transfer(pair.target, parseEther('100'))).wait();
    await (await token.transfer(pair.target, parseEther('300000'))).wait();
    await (await pair.sync()).wait();
  }
  await (await weth.approve(arb.target, parseEther('1'))).wait();
  await assert.rejects(arb.execute.staticCall(buy.target, sell.target, parseEther('1'), parseEther('0.01')));

  const victimInput = parseEther('150000');
  const wethOut = getAmountOut(victimInput, parseEther('300000'), parseEther('100'));
  await (await token.connect(victim).transfer(buy.target, victimInput)).wait();
  await (await buy.swap(wethOut, 0, victim.address, '0x')).wait();
  const before = await weth.balanceOf(owner.address);
  const trade = await arb.execute(buy.target, sell.target, parseEther('1'), parseEther('0.01'));
  const receipt = await trade.wait();
  const after = await weth.balanceOf(owner.address);
  const parsed = receipt.logs.map(log => { try { return new Interface(contracts['AtomicV2Arb.sol'].AtomicV2Arb.abi).parseLog(log); } catch { return null; } }).find(e => e?.name === 'ArbExecuted');
  assert.ok(parsed);
  assert.equal(after - before, parsed.args.grossProfit);
  assert.ok(parsed.args.grossProfit - receipt.gasUsed * receipt.gasPrice > 0n);
  assert.ok(receipt.gasUsed < 230000n);
});

test('V3 and V2 legs settle only when both routes return profitable WETH', async (t) => {
  const evm = ganache.provider({ logging: { quiet: true }, chain: { chainId: 11155111 }, wallet: { defaultBalance: 1000 } });
  t.after(() => evm.disconnect());
  const provider = new BrowserProvider(evm);
  const owner = await provider.getSigner(0);
  const contracts = compile();
  async function deploy(file, name, args = []) {
    const artifact = contracts[file][name];
    const instance = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, owner).deploy(...args);
    await instance.waitForDeployment();
    return instance;
  }
  const weth = await deploy('MockV2.sol', 'MockERC20', ['WETH', 'WETH']);
  const token = await deploy('MockV2.sol', 'MockERC20', ['Token', 'TKN']);
  const pair = await deploy('MockV2.sol', 'MockV2Pair', [weth.target, token.target]);
  const router = await deploy('MockV3Router.sol', 'MockV3Router');
  const arb = await deploy('AtomicV2V3Arb.sol', 'AtomicV2V3Arb', [weth.target, token.target, pair.target, router.target, 3000]);
  await (await weth.mint(owner.address, parseEther('1'))).wait();
  await (await weth.mint(pair.target, parseEther('10'))).wait();
  await (await token.mint(pair.target, parseEther('10000'))).wait();
  await (await pair.sync()).wait();
  await (await token.mint(router.target, parseEther('10000'))).wait();
  await (await weth.mint(router.target, parseEther('10'))).wait();
  await (await router.setRate(weth.target, token.target, 2000, 1)).wait();
  await (await router.setRate(token.target, weth.target, 2, 1000)).wait();
  await (await weth.approve(arb.target, parseEther('0.02'))).wait();
  await assert.rejects(arb.executeV3ToV2.staticCall(parseEther('0.01'), parseEther('1')));
  const iface = new Interface(contracts['AtomicV2V3Arb.sol'].AtomicV2V3Arb.abi);
  for (const [direction, method] of [[0n, 'executeV3ToV2'], [1n, 'executeV2ToV3']]) {
    const before = await weth.balanceOf(owner.address);
    const receipt = await (await arb[method](parseEther('0.01'), parseEther('0.005'))).wait();
    const after = await weth.balanceOf(owner.address);
    const event = receipt.logs.map(log => { try { return iface.parseLog(log); } catch { return null; } }).find(e => e?.name === 'MixedRouteExecuted');
    assert.ok(event);
    assert.equal(event.args.direction, direction);
    assert.equal(after - before, event.args.grossProfit);
    assert.ok(event.args.grossProfit - receipt.gasUsed * receipt.gasPrice > 0n);
    assert.ok(receipt.gasUsed < 600000n);
  }
});

test('three-hop V2 cycle pays the owner only after a positive WETH gain', async (t) => {
  const evm = ganache.provider({ logging: { quiet: true }, chain: { chainId: 11155111 }, wallet: { defaultBalance: 1000 } });
  t.after(() => evm.disconnect());
  const provider = new BrowserProvider(evm);
  const owner = await provider.getSigner(0);
  const contracts = compile();
  async function deploy(file, name, args = []) {
    const artifact = contracts[file][name];
    const instance = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, owner).deploy(...args);
    await instance.waitForDeployment();
    return instance;
  }
  const weth = await deploy('MockV2.sol', 'MockERC20', ['WETH', 'WETH']);
  const a = await deploy('MockV2.sol', 'MockERC20', ['A', 'A']);
  const b = await deploy('MockV2.sol', 'MockERC20', ['B', 'B']);
  const first = await deploy('MockV2.sol', 'MockV2Pair', [b.target, weth.target]);
  const second = await deploy('MockV2.sol', 'MockV2Pair', [a.target, b.target]);
  const third = await deploy('MockV2.sol', 'MockV2Pair', [a.target, weth.target]);
  const arb = await deploy('AtomicV2Arb.sol', 'AtomicV2Arb', [weth.target, b.target]);
  await (await weth.mint(owner.address, parseEther('105'))).wait();
  await (await a.mint(owner.address, parseEther('200000'))).wait();
  await (await b.mint(owner.address, parseEther('40000'))).wait();
  for (const [token, pair, quantity] of [
    [b, first, '30000'], [weth, first, '3'],
    [a, second, '100000'], [b, second, '10000'],
    [a, third, '100000'], [weth, third, '100'],
  ]) await (await token.transfer(pair.target, parseEther(quantity))).wait();
  for (const pair of [first, second, third]) await (await pair.sync()).wait();
  await (await weth.approve(arb.target, parseEther('0.01'))).wait();
  const before = await weth.balanceOf(owner.address);
  const tx = await arb.executeRoute(
    [first.target, second.target, third.target],
    [weth.target, b.target, a.target, weth.target],
    parseEther('0.01'), parseEther('0.01'),
  );
  const receipt = await tx.wait();
  const after = await weth.balanceOf(owner.address);
  const iface = new Interface(contracts['AtomicV2Arb.sol'].AtomicV2Arb.abi);
  const event = receipt.logs.map(log => { try { return iface.parseLog(log); } catch { return null; } }).find(e => e?.name === 'RouteExecuted');
  assert.ok(event);
  assert.equal(after - before, event.args.grossProfit);
  assert.ok(event.args.grossProfit - receipt.gasUsed * receipt.gasPrice > 0n);
  assert.ok(receipt.gasUsed < 400000n);
});

test('verified mixed executor checks factories and realizes profit in both directions', async (t) => {
  const evm = ganache.provider({ logging: { quiet: true }, chain: { chainId: 11155111 }, wallet: { defaultBalance: 1000 } });
  t.after(() => evm.disconnect());
  const provider = new BrowserProvider(evm);
  const owner = await provider.getSigner(0);
  const other = await provider.getSigner(1);
  const contracts = compile();
  async function deploy(file, name, args = []) {
    const artifact = contracts[file][name];
    const instance = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, owner).deploy(...args);
    await instance.waitForDeployment();
    return instance;
  }
  const weth = await deploy('MockV2.sol', 'MockERC20', ['WETH', 'WETH']);
  const token = await deploy('MockV2.sol', 'MockERC20', ['Token', 'TKN']);
  const pair = await deploy('MockV2.sol', 'MockV2Pair', [weth.target, token.target]);
  const router = await deploy('MockV3Router.sol', 'MockV3Router');
  const v2Factory = await deploy('MockFactories.sol', 'MockV2Factory');
  const v3Factory = await deploy('MockFactories.sol', 'MockV3Factory');
  const arb = await deploy('AtomicVerifiedMixedArb.sol', 'AtomicVerifiedMixedArb', [weth.target, v2Factory.target, v3Factory.target, router.target]);
  await (await weth.mint(owner.address, parseEther('1'))).wait();
  await (await weth.mint(pair.target, parseEther('10'))).wait();
  await (await token.mint(pair.target, parseEther('10000'))).wait();
  await (await pair.sync()).wait();
  await (await token.mint(router.target, parseEther('10000'))).wait();
  await (await weth.mint(router.target, parseEther('10'))).wait();
  await (await router.setRate(weth.target, token.target, 2000, 1)).wait();
  await (await router.setRate(token.target, weth.target, 2, 1000)).wait();
  await (await weth.approve(arb.target, parseEther('0.02'))).wait();
  const amount = parseEther('0.01');
  await assert.rejects(arb.execute.staticCall(token.target, pair.target, 3000, 0, amount, 1n));
  await (await v2Factory.setPair(weth.target, token.target, pair.target)).wait();
  await (await v3Factory.setPool(weth.target, token.target, 3000, router.target)).wait();
  await assert.rejects(arb.connect(other).execute.staticCall(token.target, pair.target, 3000, 0, amount, 1n));
  await assert.rejects(arb.execute.staticCall(token.target, pair.target, 3000, 0, amount, parseEther('1')));
  const iface = new Interface(contracts['AtomicVerifiedMixedArb.sol'].AtomicVerifiedMixedArb.abi);
  for (const direction of [0, 1]) {
    const before = await weth.balanceOf(owner.address);
    const receipt = await (await arb.execute(token.target, pair.target, 3000, direction, amount, parseEther('0.005'))).wait();
    const after = await weth.balanceOf(owner.address);
    const event = receipt.logs.map(log => { try { return iface.parseLog(log); } catch { return null; } }).find(e => e?.name === 'VerifiedMixedExecuted');
    assert.ok(event);
    assert.equal(after - before, event.args.grossProfit);
    assert.ok(event.args.grossProfit - receipt.gasUsed * receipt.gasPrice > 0n);
    assert.ok(receipt.gasUsed < 600000n);
  }
});
