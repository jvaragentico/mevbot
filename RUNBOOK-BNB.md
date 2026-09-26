# Run the BNB bot locally

This guide is for `0x8041Cc720aBC7DA28B056439aa2932Dbb879c408` on BNB Smart Chain. It runs on your own Windows computer without a ChatGPT session. Keep the computer awake and connected. The bot pauses new trades after **5 confirmed profitable BNB receipts** for your review, while the dashboard stays online.

The wallet started with **0.028311407233039037 BNB**. The executor was deployed at `0xBE1fe3d3e68d23729F64970672b78bB200F20117`; **0.015 BNB** was wrapped into WBNB for trade inputs, leaving native BNB for gas. You do **not** need ETH on BNB Chain.

## 1. Install and inspect

Open PowerShell in `C:\Users\jojd1\Documents\ChatGPT\mevbot`:

```powershell
npm install
npm install --prefix test/evm
npm test
npm run test:evm
npm run compile
npm run check-public-wallet -- 0x8041Cc720aBC7DA28B056439aa2932Dbb879c408
npm run scan-bnb-routes
```

The scanner enumerates official Uniswap V2 WBNB pairs, finds overlapping Uniswap V3 pools, and saves `data/bnb-routes.json`. It uses [official BNB Uniswap V2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments) and [official V3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments). The 26 September 04:12 UTC scan found **25 active overlaps, 422 valid quotes from 450 attempts, zero quote errors, and zero quotes above the profit floor**. Its best estimate after capped gas was **-0.000119292856053252 WBNB**, below the required **+0.00005 WBNB**. Live scanning now screens all routes at one block, batches sizes, quotes directions concurrently and includes tiny input sizes. The dashboard distinguishes upper-bound leads from full quotes and confirmed receipts. See [the mainnet audit](MAINNET-AUDIT.md) for failure analysis and read-only chain comparisons.

A separate read-only scout checked Uniswap V2 against PancakeSwap V2. It excluded pools below 0.05 WBNB on either side and found no quote clearing the configured profit floor. One apparent reserve gap had only 0.000000000005751443 WBNB on the Pancake side; another candidate reverted with `Pancake: K` in a private fork simulation. These are not executable profits. The deployed live executor does not support this cross-exchange route, and no new contract was deployed for it. To repeat the checks, run `node scripts/inspect-bnb-cross-v2.js` and `node test/evm/fork-bnb-cross-v2.js` from the repository root. The fork test uses a throwaway Ganache account and sends no live transaction.

The baseline command is for a fresh installation only. It writes the wallet's BNB plus WBNB USD value to `data/bnb-baseline.json` and refuses to reset it. This installation saved **$22.04407704 at 2026-09-25 12:42:30 UTC**, before deployment and wrapping. The bot uses the [Chainlink BNB/USD feed on BNB Chain](https://data.chain.link/feeds/bsc/mainnet/bnb-usd) and stops sending trades if BNB plus WBNB falls by **$15** from that fixed value. It also reserves room for the worst case gas of the next trade and blocks trades when the price feed is stale or unavailable. A BNB price drop alone can trigger the stop. It **does not sell or hedge** BNB or WBNB, so the wallet's USD value could continue to fall after trading stops. Other tokens and external transfers are not included in this calculation.

## 2. Import the signing key locally

```powershell
.\scripts\import-bnb-wallet.ps1
```

Type the private key into the **hidden PowerShell prompt**. Do not paste it into chat, a command argument, or a webpage. The script checks that it derives to the address above. It stores the key with Windows user encryption in `.bnb-key.secure` and public settings in `.env.bnb.local`; both files are ignored by Git. The encrypted file is usable only by the same Windows account. Back up your wallet through its normal recovery method; this file is for bot operation, not a wallet backup.

If both local files already exist after an interrupted import, rerun the import command. It finalizes file permissions and verifies the saved key without asking you to enter it again. You can also run `.\scripts\finalize-bnb-wallet.ps1` directly.

If your PowerShell execution policy blocks local scripts, run `Set-ExecutionPolicy -Scope Process RemoteSigned` in that one PowerShell window and rerun the command. The change lasts only for that window.

## 3. Start read only monitoring

Stop the current live processes first if they are running. Then start observe mode:

```powershell
.\scripts\start-bnb-local.ps1
```

Open [http://127.0.0.1:8788/](http://127.0.0.1:8788/). Observe mode continuously checks pool quotes and refreshes the pool list every six hours. It sends **no** trades. If the dashboard port is already in use, stop the existing BNB dashboard first.

Check status and logs:

```powershell
$state = Invoke-RestMethod http://127.0.0.1:8788/api/state
$state | Select-Object status, profitableTrades, netWei, scan
$state.risk | Select-Object status, walletValueUsd, declineUsd, remainingUsd, limitUsd, reviewAfterProfitableTrades
Get-Content .\data\bnb-bot.err.log -Tail 30
Get-Content .\data\bnb-events.jsonl -Tail 20
```

Stop the locally launched processes:

```powershell
.\scripts\stop-bnb-local.ps1
```

## 4. Run live on this computer

The executor, WBNB, allowance, wallet baseline, encrypted signing key and current-user startup task are already set up on this installation. The supervised bot starts at Windows sign-in unless manually stopped. After a manual stop, resume it with:

```powershell
.\scripts\resume-bnb-local.ps1 -Live
```

If the process is already running, check the dashboard instead of starting a duplicate.

### Fresh installation setup

The following steps use **real BNB**. Deployment costs gas, wrapping moves BNB into WBNB, and approval authorizes the immutable owner controlled executor. Review the output and your wallet balance before running each `-Execute` command.

```powershell
.\scripts\stop-bnb-local.ps1
npm run set-bnb-baseline
.\scripts\run-bnb-command.ps1 -Task deploy
.\scripts\run-bnb-command.ps1 -Task deploy -Execute
.\scripts\run-bnb-command.ps1 -Task prepare
.\scripts\run-bnb-command.ps1 -Task prepare -Execute
.\scripts\start-bnb-local.ps1 -Live
```

Deployment writes its public `BNB_ARB_CONTRACT_ADDRESS` into `.env.bnb.local`. On this installation it is already deployed, so do not run the deployment step again. Preparation targets 0.015 WBNB and refuses to leave less than 0.005 native BNB plus setup gas. This wallet is already prepared, so do not repeat preparation unless the balances change. The bot defaults to trade inputs of 0.00000001, 0.0000001, 0.000001, 0.00001, 0.0001, 0.0005, 0.001, 0.005, and 0.01 WBNB; a 0.2 gwei maximum gas price; a 0.00005 WBNB minimum net floor; a 0.002 BNB daily receipt gas budget; a $15 wallet value stop; and a pause after 5 profitable BNB receipts. You can adjust `BNB_*` values in `.env.bnb.local` before starting it.

Live mode keeps scanning until the $15 wallet stop or 5 profitable receipt review pause. It submits only when a current quote clears capped gas, the deployed contract's `eth_call` succeeds with the profit floor, the gas estimate is below the limit, and the wallet has WBNB, allowance, and native gas reserve. The contract reverts if the actual WBNB output is below the floor. **A race between simulation and inclusion can still produce a reverted transaction that costs gas.** Failed receipt gas is shown in the dashboard, and the daily gas budget limits that exposure. A successful receipt is counted only after the emitted profit exceeds paid gas.

This is a direct arbitrage bot on BNB Chain. Flashbots MEV-Share serves Ethereum and is not the transaction transport used here. There is no guarantee that a profitable pool spread will appear or that this bot will win it against competing searchers. The latest BNB scan found none.

## Keep it running

Install the supervisor on a new local installation with:

```powershell
.\scripts\install-bnb-startup.ps1 -Live
```

The Windows task `Mevbot BNB local supervisor` runs hidden as your current account at sign-in, without storing a password or private key in the task definition. It checks the bot and dashboard every 30 seconds and restarts them after a crash. Startup failures use a longer retry delay. The key stays in its existing Windows-encrypted local file. An OS-owned localhost port prevents a second bot instance. Both the bot and dashboard run independently of ChatGPT/Codex usage.

`stop-bnb-local.ps1` stops the supervisor and its recorded processes, and writes a manual-stop marker that persists across sign-ins. `resume-bnb-local.ps1 -Live` clears only that manual marker; it preserves the wallet-loss and profitable-receipt stop latches and the fixed baseline. Do not remove those risk latches to bypass a stop.

Keep the computer awake and connected. Shutdown, sleep and network failure interrupt scanning; the supervisor cannot create opportunities while the machine is unavailable. The dashboard and append-only `data/bnb-events.jsonl` provide the operational record.

To verify the user's **five trades on 26 September 2026 in Asia/Bangkok** target independently:

```powershell
npm run verify-bnb-target
```

The verifier reads mainnet transactions, canonical receipts, wallet WBNB transfers and actual gas. It requires 20 confirmations and a positive execution net for each distinct receipt dated on the target day. Results are saved locally in `data/bnb-target-proof.json`. A separate Codex heartbeat checks receipts every 15 minutes while the app is available; this check remains subject to Codex usage limits and is not needed for the local bot to operate.
