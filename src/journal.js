import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const defaultJournalPath = resolve('data/events.jsonl');

export function record(type, fields = {}, file = defaultJournalPath) {
  mkdirSync(dirname(file), { recursive: true });
  const event = { at: new Date().toISOString(), type, ...fields };
  appendFileSync(file, JSON.stringify(event, (_, value) => typeof value === 'bigint' ? value.toString() : value) + '\n');
  return event;
}

export function readEvents(file = defaultJournalPath) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { at: '', type: 'journal_error', message: 'Malformed journal line' }; }
  });
}

export function snapshot(events = readEvents()) {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  const receiptByHash = new Map();
  for (const event of events) {
    if (['confirmed', 'receipt_failed'].includes(event.type) && event.chainId === 11155111 && /^0x[0-9a-f]{64}$/i.test(event.txHash ?? '')) {
      receiptByHash.set(event.txHash.toLowerCase(), event);
    }
  }
  const receipts = [...receiptByHash.values()];
  const confirmations = receipts.filter(e => e.type === 'confirmed' && BigInt(e.netProfitWei ?? '0') > 0n);
  const netWei = receipts.reduce((sum, e) => sum + BigInt(e.netProfitWei ?? (e.gasCostWei ? `-${e.gasCostWei}` : '0')), 0n);
  const lastStart = events.findLast(e => ['startup', 'blocked', 'stopped'].includes(e.type));
  const lastHeartbeat = events.findLast(e => e.type === 'heartbeat');
  const lastActivity = events.at(-1);
  const fresh = lastHeartbeat?.at && Date.now() - Date.parse(lastHeartbeat.at) < 45_000;
  return {
    ready: confirmations.length >= 5 && netWei > 0n,
    proofCount: confirmations.length,
    cumulativeNetWei: netWei.toString(),
    status: lastStart?.type === 'blocked' ? 'blocked' : lastStart?.type === 'startup' && fresh ? lastStart.mode : 'offline',
    statusMessage: lastStart?.type === 'startup' && !fresh ? 'Bot heartbeat is stale' : lastStart?.message ?? '',
    lastActivity: lastActivity?.at ?? null,
    blockNumber: lastHeartbeat?.blockNumber ?? null,
    counts,
    trades: receipts.slice(-50).reverse(),
    events: events.filter(e => e.type !== 'heartbeat').slice(-100).reverse(),
  };
}
