export function getAmountOut(amountIn, reserveIn, reserveOut) {
  for (const value of [amountIn, reserveIn, reserveOut]) {
    if (typeof value !== 'bigint' || value <= 0n) throw new Error('Amounts and reserves must be positive bigint values');
  }
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1000n + withFee);
}

export function quoteRoundTrip(amountIn, buy, sell) {
  const tokenOut = getAmountOut(amountIn, buy.weth, buy.token);
  if (tokenOut === 0n) return { tokenOut, wethOut: 0n, grossProfit: -amountIn };
  const wethOut = getAmountOut(tokenOut, sell.token, sell.weth);
  return { tokenOut, wethOut, grossProfit: wethOut - amountIn };
}

export function quoteRoute(amountIn, hops) {
  if (!Array.isArray(hops) || hops.length < 2) throw new Error('Route requires at least two hops');
  if (typeof amountIn !== 'bigint' || amountIn <= 0n) throw new Error('Route input must be a positive bigint');
  let amount = amountIn;
  for (const hop of hops) {
    amount = getAmountOut(amount, hop.reserveIn, hop.reserveOut);
    if (amount === 0n) return { wethOut: 0n, grossProfit: -amountIn };
  }
  return { wethOut: amount, grossProfit: amount - amountIn };
}

export function selectOpportunity(sizes, buy, sell, gasCeilingWei, minNetProfitWei) {
  let best = null;
  for (const amountIn of sizes) {
    const quote = quoteRoundTrip(amountIn, buy, sell);
    const netFloor = quote.grossProfit - gasCeilingWei;
    if (netFloor >= minNetProfitWei && (!best || netFloor > best.netFloor)) {
      best = { amountIn, ...quote, gasCeilingWei, netFloor };
    }
  }
  return best;
}

export function selectRouteOpportunity(sizes, hops, gasCeilingWei, minNetProfitWei) {
  let best = null;
  for (const amountIn of sizes) {
    const quote = quoteRoute(amountIn, hops);
    const netFloor = quote.grossProfit - gasCeilingWei;
    if (netFloor >= minNetProfitWei && (!best || netFloor > best.netFloor)) {
      best = { amountIn, ...quote, gasCeilingWei, netFloor };
    }
  }
  return best;
}

export function confirmedNetProfit(grossProfit, gasUsed, effectiveGasPrice) {
  return grossProfit - gasUsed * effectiveGasPrice;
}
