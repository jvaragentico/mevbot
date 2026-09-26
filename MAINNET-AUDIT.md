# Mainnet audit — 26 September 2026

## Update: private execution and broader scans, 06:56 UTC

The target remains **0/5 independently verified mainnet profits**, with **zero arbitrage gas paid**. The bot and dashboard were restarted through the existing supervisor with the fixed baseline, $15 stop, native reserve, gas caps and five-receipt pause preserved.

- Screening now uses the actual selected gas price, exactly as execution does, rather than assuming the maximum price for every quote. At 0.05 gwei, the full 600,000 gas budget is **0.00003 BNB**, instead of 0.00012 BNB at the 0.2 gwei cap. The net profit floor remains **0.00005 WBNB**.
- A fresh contract call and gas estimate run concurrently. Both must pass, and stale simulations are discarded. Another public pending wallet nonce blocks submission.
- Submission now uses free BlockRazor private bundles, with no allowed reverts, no disclosure hints, and a four-block expiry. Attempts are journaled before transmission; uncertain responses block new submissions until receipts or an expired unused nonce are reconciled. There is no public fallback. These are external builder policies, not guaranteed inclusion or a guarantee against every paid revert. [Official RPC mode](https://docs.blockrazor.io/transaction-submission/rpc/bsc/bsc-rpc-endpoint), [bundle API](https://docs.blockrazor.io/transaction-submission/rpc/bsc/orderflow-auction).
- The strongest marginal screen is quoted each cycle; other quote slots rotate, preventing recurring false leads from permanently starving lower-ranked directions.
- Twenty tests passed, covering exact gas budgets, bundle expiry and disclosure, errors and timeouts, nonce reconciliation, receipt proof and exchange fees. The API recognized a deliberately empty, expired bundle request; no signed test transaction was sent to mainnet. Actual inclusion remains untested because no qualifying opportunity has appeared.

Additional read-only snapshots used 577 tokens and the correct PancakeSwap V2 0.25% fee:

| Route family | Active overlaps / pools | Directions / full quote calls | Result |
|---|---:|---:|---|
| PancakeSwap V2 / Uniswap V3 | 81 overlaps | 162 directions; 180 quotes | No route cleared the floor; best quoted net −0.000019737440596774 WBNB |
| PancakeSwap V2 / V3, wallet-sized grid | 171 overlaps | 342 directions; 468 quotes | No route cleared the floor; best quoted net +0.000017047283035035 WBNB, below +0.00005 |
| PancakeSwap V2 / V3, separate hypothetical 0.d from the execution net.

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

The BNB submission path now uses private BlockRazor bundles with no allowed reverts, no disclosure hints, and a four-block expiry. There is no public fallback. Screening uses the same bounded gas price as the submitted transaction. Bundle acceptance is not a receipt or profit. Read-only scouts also check PancakeSwap V2/V3 and cross-V3 routes; those routes are not supported by the existing live executor. See [the audit](MAINNET-AUDIT.md) for measured results and remaining limitations.
