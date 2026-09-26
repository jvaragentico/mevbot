# MEV-Share arbitrage bot

This repository contains an owner controlled atomic WETH arbitrage executor, a Flashbots MEV-Share searcher, route scanners, execution scripts, and a local dashboard. The executor trades between official Uniswap V2 and V3 Sepolia pools and reverts unless it receives the input WETH plus a configured profit floor. The MEV-Share searcher listens for transaction hints and can submit backrun bundles; direct trades can also be sent when a current pool spread clears the gas cap.

## Validation status

**Five distinct Sepolia arbitrage transactions were confirmed with positive WETH equivalent profit after receipt gas.** Run `npm run verify-profit` to reread their onchain receipts and compare them with the committed [proof manifest](proof/sepolia-five.json). At the time of validation, their cumulative execution net was **0.030675430861903638 WETH equivalent**. The dashboard shows the count and links to each receipt.

These five were **direct arbitrage transactions**, not included MEV-Share backrun bundles. This establishes testnet execution of the atomic strategy; it does not establish Flashbots bundle inclusion or mainnet profitability. Sepolia assets have no monetary value. Deployment, wrapping, and approval gas are setup costs and are excluded from the execution net.

The reusable Sepolia executor is `0x25D1B4DDBEE82b4dcBA86074017AB442425C9826`. One earlier profitable trade used specialized executor `0xe50b6A27d4697C9767aE32606d5f6d2176A46CB1`. The executor wallet is `0xfB86fE279cDBbA943D53ba0CB5650c3fc1dF6949`.

## Run

```powershell
npm install
npm test
npm install --prefix test/evm
npm run test:evm
npm run compile
npm run verify-profit
npm run dashboard
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). The dashboard is read only, binds to localhost, refreshes every three seconds, and reads the append only `data/events.jsonl` journal. The `verify-profit` command independently validates each committed proof entry against its Sepolia receipt, target contract, emitted profit, and paid gas. The journal and wallet keys remain local and are ignored by Git.

`npm run bot:mixed` starts the MEV-Share watcher in the default observe mode. It monitors a configured V2/V3 route and records hints, quotes, receipts, and heartbeat events. `BOT_MODE=live` is restricted to Sepolia and enables capped direct trades and bundle submissions. Its backrun path has not yet produced a confirmed included bundle. The separate `npm run bot` command handles two to four hop V2 routes; the initial MotoSwap candidate was rejected in a preflight simulation because its pair forbade the swap.

## Reproduce a route check

Set `RPC_URL`, `EXECUTOR_KEY`, `FB_REPUTATION_KEY`, `WETH_ADDRESS`, and `VERIFIED_ARB_CONTRACT_ADDRESS` in a local `.env` file. Never commit or share private keys. `npm run wallet` creates keys only when `.env` does not already exist. The executor wallet needs Sepolia ETH for gas and WETH for inputs; [ethereum.org lists Sepolia faucets](https://ethereum.org/developers/docs/networks/#sepolia).

```powershell
npm run check-network
npm run scan-uniswap-pools
npm run scan-v3-overlap
npm run simulate-verified
npm run trade-verified -- <token-address> <WETH-input>
```

The trade command without `--execute` calls the deployed contract using the current Sepolia state and estimates gas. Adding `--execute` repeats that preflight and sends one capped transaction only if the contract's gross profit floor covers the maximum gas fee plus `MIN_NET_PROFIT_WETH`. A successful simulation is not a confirmed profit; the command waits for a receipt and records actual gross WETH, gas paid in Sepolia ETH, and execution net. The contract uses the [official Uniswap V2 Sepolia factory](https://developers.uniswap.org/docs/protocols/v2/deployments), [V3 factory and SwapRouter02](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments), and validates each route's pools through those factories.

The implementation follows the [Flashbots MEV-Share searcher documentation](https://docs.flashbots.net/flashbots-mev-share/searchers/getting-started) and [limit order setup tutorial](https://docs.flashbots.net/flashbots-mev-share/searchers/tutorials/limit-order/setup) for stream and bundle integration. Testnet liquidity, token behavior, and order flow change; historical receipts do not guarantee a future edge.

## Continuous BNB Chain operation

The separate BNB bot scans official Uniswap V2/V3 WBNB pools and runs locally in live mode for wallet `0x8041Cc720aBC7DA28B056439aa2932Dbb879c408`. It has its own [local runbook](RUNBOOK-BNB.md) and [dashboard](http://127.0.0.1:8788/). Its owner-only executor is deployed at `0xBE1fe3d3e68d23729F64970672b78bB200F20117`; the wallet has WBNB and native BNB for gas. The bot stops sending trades after a $15 decline from its fixed BNB plus WBNB USD baseline, or pauses after 5 confirmed profitable BNB receipts for review. The latest pool scan found 25 active overlaps and no quote above the profit floor, so **no BNB arbitrage trade has been sent or proven profitable**. Only successful trades that clear the onchain profit guard can count as profitable; an included revert can still spend gas. The wallet stop does not sell BNB or WBNB.
