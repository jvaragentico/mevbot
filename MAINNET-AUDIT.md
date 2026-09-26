# Mainnet audit — 26 September 2026

**Five profitable real-chain trades have not been achieved.** At 04:24 UTC, independent receipt verification found **0/5**, with no BNB arbitrage transactions sent and no trading gas paid. The improvements below repair operation and measurement; they do not establish a profitable mainnet strategy.

## Why the testnet result did not carry over

The five Sepolia receipts in `proof/sepolia-five.json` establish successful direct arbitrage on those pools. They do not establish inclusion of a MEV-Share backrun bundle. Four trades used 0.00000001 WETH input and returned approximately 0.0064–0.0067 WETH after gas. Those unusual testnet prices have not been found in the sampled mainnet pools. Sepolia WETH has no demonstrated cash profit here.

I also left operational weaknesses in the original BNB implementation:

- It was not running all night: the old journal ended at 15:46 UTC on 25 September, and its processes were absent when checked the next morning. The journal does not establish the cause of that shutdown.
- Four routes were fully quoted sequentially every eight seconds. With 25 active routes, this could miss brief spreads. BNB currently produces blocks every 0.45 seconds. [BNB Fermi announcement](https://www.bnbchain.org/en/blog/fermi-hard-fork-accelerates-bsc-to-0-45-second-block-times)
- Quote failures were not adequately distinguished from unfavorable prices. A stale route list also postponed discovery at startup.
- The size grid omitted the tiny inputs that worked on Sepolia.
- The live strategy covered only Uniswap V2 against Uniswap V3. A different exchange or three-hop strategy requires additional verified execution support.

The remaining market evidence is unfavorable: the 04:12 UTC scan found 25 active overlaps, 422 valid quotes from 450 attempts, 28 filtered quotes, zero quote errors and zero routes meeting the floor. Best quoted return after the capped gas allowance was **−0.000119292856053252 WBNB**, versus the required **+0.00005 WBNB**.

## Fixes now running

- Screen all live routes at one pinned block through Multicall; batch all input sizes and quote eligible directions concurrently. Observed live cycle duration after these changes was approximately 0.7–0.9 seconds. This remains several BNB block intervals once simulation and submission are added.
- Include inputs from 0.00000001 through 0.01 WBNB. Discard stale quotes and repeat the owner-controlled contract simulation before submission.
- Show valid quotes, rejected quotes, quote errors, full-quote results and upper-bound leads separately. A marginal price upper bound is not executable profit.
- Refresh expired discovery data immediately. Retry failed discovery without overwriting the prior usable route file.
- Read wallet balances, oracle data and the oracle reference timestamp at the same block. Reject a stale RPC head and stale or invalid oracle data. This avoids false feed failures from a small Windows/chain clock difference.
- Run a current-user Windows supervisor at sign-in. It restarts crashed processes, honors manual stops, and preserves wallet-loss and receipt-target stops. An OS-owned localhost port prevents duplicate bot instances.
- Independently verify the mainnet target using canonical receipts, the expected sender/executor, actual wallet WBNB transfer changes, actual gas and at least 20 confirmations. Count distinct positive receipts dated 26 September in Asia/Bangkok.

The supervisor recovery test exposed a UTC/local timestamp comparison bug. It was fixed, duplicate processes were stopped, and a deliberate dashboard crash was then recovered successfully. No arbitrage transaction was sent during those checks.

## Broader read-only tests

These are limited snapshots of the same two-hop strategy, not comprehensive measurements of all MEV on a chain. Raw results remain local in `data/scouts/`.

| Sample | Tokens checked | Active V2/V3 overlaps | Result |
|---|---:|---:|---|
| BNB Uniswap V2 → PancakeSwap V3, both directions | 577 | 31 | No full quote met the current BNB floor; 16 valid, 9 filtered, 2 reverted |
| Base Uniswap V2/V3 | 95 | 43 | No full quote met the test floor; 28 valid, 4 filtered; Base L1 fee allowance included |
| Arbitrum Uniswap V2/V3 | 17 | 8 | All 16 directions failed the optimistic upper-bound screen; transaction-specific L1 fee accounting remains incomplete |

Two apparent BNB cross-V2 reserve spreads were also tested on a private Ganache fork. One reverted with `Pancake: TRANSFER_FAILED`; the other with `Pancake: K`. Neither was a proven mainnet profit. Pool formulas alone are inadequate for nonstandard token transfers.

Reproduce without signing or moving funds:

```powershell
node scripts/inspect-bnb-screened-routes.js
node scripts/scout-mainnet-mixed.js bnb-pancake
node scripts/scout-mainnet-mixed.js base
node scripts/scout-mainnet-mixed.js arbitrum
node test/evm/fork-bnb-cross-v2.js
npm run verify-bnb-target
```

## Chain choice and competition

| Chain | Evidence relevant to this bot | Practical conclusion |
|---|---|---|
| BNB | A study of April 2025–February 2026 found that two builders produced over 87% of blocks and captured about 90%+ of observed MEV profits. This is historical concentration, not this wallet's success probability. [Primary study](https://arxiv.org/abs/2602.15395) | Public RPC polling has a latency and order-flow disadvantage. Broader pools alone have not produced a verified edge. |
| Base | Flashblocks expose 200 ms preconfirmations; both execution and L1 data fees matter. [Flashblocks](https://docs.base.org/specifications/flashblocks), [fees](https://docs.base.org/specifications/transactions/network-fees) | Public RPC full quoting took about 44 seconds in this sample. A suitable provider and stream are prerequisites for testing competitiveness. |
| Arbitrum | Timeboost gives normal transactions a default 200 ms delay; express-lane rounds default to 60 seconds with a starting reserve of 0.001 WETH. Parameters can change. Winning the lane does not guarantee profit. [Timeboost](https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction) | Moving the existing strategy here does not remove competition or establish an affordable edge. |
| Gnosis | Official specifications list five-second slots. [Specifications](https://docs.gnosischain.com/about/specs/gbc/) | A slower timing window is worth read-only investigation. Neither the opportunity rate nor this bot's capture probability has been measured there. |
| Ethereum | Flashbots supports private bundle auctions with conditional inclusion. [Flashbots Auction](https://docs.flashbots.net/flashbots-auction/overview) | This provides an appropriate backrun transport, but the existing testnet direct trades do not establish a competitive mainnet strategy or fund its costs. |

No defensible numerical probability of winning a trade is available yet. It requires qualifying opportunity counts and lifetimes, endpoint latency, executable simulations, bid costs and actual inclusion results. The measured qualifying count here is zero.

## What could make the strategy viable

The next substantive development is an event-driven search over additional verified exchange routes, paired with a suitable private simulation/submission path. First measure executable leads without deploying or bridging; only then budget the required contract and infrastructure. Keep swap gas, builder payments, flash-loan fees and any L2 data fee in the profit calculation.

For example, 48Club documents private backrun targets and bundle expiry, but its auction feed requires membership points and documents a 1 gwei bundle requirement. That cannot simply replace the existing 0.2 gwei gas ceiling. No membership purchase or higher gas spending has been made. [Auction feed](https://docs.48.club/puissant-builder/auction-transaction-feed), [bundle API](https://docs.48.club/puissant-builder/send-bundle)

The current installation keeps watching its supported routes with the $15 wallet USD decline stop and five-receipt review pause. The completion condition remains unmet until five real positive-net receipts are independently verified. No daily trade count can be guaranteed from these findings.
