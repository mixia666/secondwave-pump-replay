// SecondWave: a confirmed-flow momentum bot for the pump.fun replay harness
// (agent-fun/replay/v2). It never snipes the create slot. Every launch is taped
// from its CreateEvent; a coin earns a first buy only after strangers have put
// real SOL behind it, the recent tape is dominated by buys, the creator has not
// sold, and the price is pressing its highs instead of fading from them. Held
// coins are ridden with a trailing stop and cut fast when the story breaks:
// creator sells, flow dies, or the position ages out. Pure function of the
// batches it is fed: no clock, no randomness, no I/O.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- entry screen -----------------------------------------------------------
const MIN_AGE_SLOTS = 20; // let the create-slot bundle land first
const MAX_AGE_SLOTS = 20_000; // after ~2h a launch has usually decided
const MIN_REAL_SOL = 3n * SOL; // 2.5 SOL of real money on the curve
const MAX_REAL_SOL = 80n * SOL; // graduation territory: the ride is over
const MIN_BUYERS = 6; // distinct non-creator buyers before we trust it
const FLOW_WINDOW_SLOTS = 90; // trailing tape the flow test reads
const MIN_FLOW_NET = 8n * SOL / 10n; // 0.4 SOL net buying inside the window
const FLOW_BUY_SHARE_PCT = 65; // buys must be at least this share of flow
const MAX_SELL_RATIO_PCT = 45; // all-time non-creator sells vs buys
const MAX_BIG_SELL_PCT = 20; // largest single sell, % of real reserve before it
const MIN_RUNUP = 1.20; // price vs create price: moving, not flat
const MAX_RUNUP = 3.5; // ...but not a vertical spike we would be exit liquidity for
const NEAR_HIGH = 0.88; // buy strength: price within 15% of its high

// ---- sizing -----------------------------------------------------------------
const FIRST_BUY = 5n * SOL / 100n; // 0.12 SOL opener
const ADD_BUY = 4n * SOL / 100n; // 0.10 SOL confirmation tranche
const MAX_STAKE = 9n * SOL / 100n; // 0.32 SOL total per coin
const MIN_BUY = 15n * SOL / 1000n; // smaller than this the fees eat the trade
const CASH_BUFFER = 3n * SOL / 10n; // always keep 0.3 SOL back for fees
const ADD_DELAY_SLOTS = 25;
const ADD_RISE = 1.10; // add only once price is 15% over average cost
const REBUY_COOLDOWN = 600; // slots before a sold coin can be bought again
const MAX_TRIPS_PER_COIN = 2;

// ---- exits ------------------------------------------------------------------
const STOP_LOSS = 0.85; // value falls to 70% of cost: out
const TAKE_PROFIT = 1.60; // value reaches 230% of cost: bank it all
const PARTIAL_AT = 1.25; // at 150% of cost, sell half and de-risk
const TRAIL_ARM = 1.18; // trailing stop arms at 135% of cost
const TRAIL_DROP = 0.88; // ...and fires at 78% of the peak value
const MAX_HOLD_SLOTS = 700; // time stop
const SCRATCH_SLOTS = 200; // held this long and still flat: dead money, out
const SCRATCH_MAX = 1.03;
const STALE_SLOTS = 200; // no trade for this long: the story is over

const BUY_SLIPPAGE_BPS = 2_000;
const SELL_SLIPPAGE_BPS = 10_000;

interface FlowTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
}

interface Tape {
  createdSlot: number;
  creator: Pubkey;
  createPrice: number; // virtual quote per token at the CreateEvent
  highPrice: number;
  buyers: Set<Pubkey>;
  buySol: bigint;
  sellSol: bigint;
  bigSellPct: number;
  lastBigSellSlot: number;
  devSold: boolean;
  flow: FlowTrade[]; // recent trades, oldest first
  lastTradeSlot: number;
}

interface Held {
  sinceSlot: number;
  peakRatio: number;
  partialDone: boolean;
  added: boolean;
  lastBuySlot: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const trips = new Map<Pubkey, number>();
const cooldownUntil = new Map<Pubkey, number>();
const decidedUntil = new Map<Pubkey, number>(); // rejected/failed buy: wait

function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

/** What selling `tokens` into the curve would gross right now, in lamports. */
function valueOf(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n) return 0n;
  return (vq * tokens) / (vt + tokens);
}

function tapeFor(mint: Pubkey, slot: number): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      createdSlot: slot,
      creator: '',
      createPrice: 0,
      highPrice: 0,
      buyers: new Set(),
      buySol: 0n,
      sellSol: 0n,
      bigSellPct: 0,
      lastBigSellSlot: -1,
      devSold: false,
      flow: [],
      lastTradeSlot: slot,
    };
    tapes.set(mint, t);
  }
  return t;
}

/** Fold one batch's events into the tapes. */
function watch(batch: Batch): Set<Pubkey> {
  const traded = new Set<Pubkey>();
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const t = tapeFor(e.mint, e.slot);
      t.createdSlot = e.slot;
      t.creator = e.creator;
      t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      t.highPrice = t.createPrice;
    } else if (e.event === 'TradeEvent') {
      traded.add(e.mint);
      const t = tapeFor(e.mint, e.slot);
      if (t.creator === '') t.creator = e.creator;
      const sol = BigInt(e.quote_amount);
      t.lastTradeSlot = e.slot;
      if (e.user === t.creator) {
        if (!e.is_buy) t.devSold = true;
      } else if (e.is_buy) {
        t.buyers.add(e.user);
        t.buySol += sol;
      } else {
        t.sellSol += sol;
        const realBefore = BigInt(e.real_quote_reserves) + sol;
        if (realBefore > 0n) {
          const pct = Number((sol * 100n) / realBefore);
          if (pct > t.bigSellPct) t.bigSellPct = pct;
          if (pct >= 12) t.lastBigSellSlot = e.slot;
        }
      }
      t.flow.push({ slot: e.slot, buy: e.is_buy, sol });
      const cutoff = e.slot - FLOW_WINDOW_SLOTS;
      while (t.flow.length > 0 && t.flow[0].slot < cutoff) t.flow.shift();
      const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (p > t.highPrice) t.highPrice = p;
    }
  }
  return traded;
}

function flowNet(t: Tape, now: number, window: number): bigint {
  let net = 0n;
  for (const f of t.flow) {
    if (f.slot < now - window) continue;
    net += f.buy ? f.sol : -f.sol;
  }
  return net;
}

function flowStats(t: Tape, now: number): { net: bigint; buyShare: number } {
  let buy = 0n;
  let sell = 0n;
  for (const f of t.flow) {
    if (f.slot < now - FLOW_WINDOW_SLOTS) continue;
    if (f.buy) buy += f.sol;
    else sell += f.sol;
  }
  const total = buy + sell;
  const share = total === 0n ? 0 : Number((buy * 100n) / total);
  return { net: buy - sell, buyShare: share };
}

function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

function entryOk(state: BotState, mint: Pubkey, slot: number): bigint {
  const t = tapes.get(mint);
  const curve = state.curves.get(mint);
  if (t === undefined || curve === undefined || curve.complete) return 0n;
  if (t.devSold || t.creator === '') return 0n;
  const age = slot - t.createdSlot;
  if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) return 0n;
  const real = curve.real_quote_reserves;
  if (real < MIN_REAL_SOL || real > MAX_REAL_SOL) return 0n;
  if (t.buyers.size < MIN_BUYERS) return 0n;
  if (t.bigSellPct > MAX_BIG_SELL_PCT) return 0n;
  if (t.buySol > 0n && Number((t.sellSol * 100n) / t.buySol) > MAX_SELL_RATIO_PCT) return 0n;
  const { net, buyShare } = flowStats(t, slot);
  if (net < MIN_FLOW_NET || buyShare < FLOW_BUY_SHARE_PCT) return 0n;
  if (flowNet(t, slot, 45) < 2n * SOL / 10n) return 0n; // freshest 45 slots still buying
  const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
  if (t.createPrice > 0) {
    const runup = price / t.createPrice;
    if (runup < MIN_RUNUP || runup > MAX_RUNUP) return 0n;
  }
  if (t.highPrice > 0 && price < t.highPrice * NEAR_HIGH) return 0n;
  const cap = state.maxBuyLamports(mint);
  const amount = cap < FIRST_BUY ? cap : FIRST_BUY;
  if (amount < MIN_BUY) return 0n;
  if (state.freeCashLamports() - amount < CASH_BUFFER) return 0n;
  return amount;
}

await runBot({
  onBatch(state, batch) {
    const slot = batch.slot;
    const traded = watch(batch);
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();

    // Fills from earlier decisions arrive inside the batch: a refused or
    // failed buy is not retried at once (the tape that justified it will
    // still be there in a hundred slots if it was real), and a buy that
    // never landed leaves no hold behind.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status !== 'filled') {
        decidedUntil.set(fill.mint, fill.slot + 100);
        if (!state.positions.has(fill.mint) && !hasPending(state, fill.mint, 'buy')) {
          held.delete(fill.mint);
        }
      }
    }

    // Forget holds the account no longer reports (harness closes, full sells).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // ---- exits and adds on held coins --------------------------------------
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      let h = held.get(mint);
      if (h === undefined) {
        h = { sinceSlot: slot, peakRatio: 1, partialDone: false, added: false, lastBuySlot: slot };
        held.set(mint, h);
      }
      const value = valueOf(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const ratio = pos.cost_lamports > 0n ? Number((value * 1000n) / pos.cost_lamports) / 1000 : 0;
      if (ratio > h.peakRatio) h.peakRatio = ratio;
      const t = tapes.get(mint);
      const selling = hasPending(state, mint, 'sell');

      let sellPart = 0n; // 0 = no sell, else token amount to sell
      if (!selling) {
        if (t !== undefined && t.devSold) sellPart = pos.token_amount;
        else if (ratio <= STOP_LOSS) sellPart = pos.token_amount;
        else if (ratio >= TAKE_PROFIT) sellPart = pos.token_amount;
        else if (h.peakRatio >= TRAIL_ARM && ratio <= h.peakRatio * TRAIL_DROP) sellPart = pos.token_amount;
        else if (slot - h.sinceSlot >= MAX_HOLD_SLOTS) sellPart = pos.token_amount;
        else if (slot - h.sinceSlot >= SCRATCH_SLOTS && ratio <= SCRATCH_MAX) sellPart = pos.token_amount;
        else if (t !== undefined && slot - t.lastTradeSlot >= STALE_SLOTS) sellPart = pos.token_amount;
        else if (t !== undefined && slot - t.lastBigSellSlot <= 10 && ratio <= 1.25) sellPart = pos.token_amount;
        else if (t !== undefined && ratio <= 1.10 && flowNet(t, slot, FLOW_WINDOW_SLOTS) <= -4n * SOL / 10n) sellPart = pos.token_amount;
        else if (!h.partialDone && ratio >= PARTIAL_AT) sellPart = pos.token_amount / 2n;
      }
      if (sellPart > 0n) {
        orders.push({ side: 'sell', mint, token_amount: sellPart, max_slippage_bps: SELL_SLIPPAGE_BPS });
        if (sellPart === pos.token_amount) {
          trips.set(mint, (trips.get(mint) ?? 0) + 1);
          cooldownUntil.set(mint, slot + REBUY_COOLDOWN);
        } else {
          h.partialDone = true;
        }
        continue;
      }

      // Confirmation add: price has run 15% over average cost and flow agrees.
      if (
        !h.added &&
        !hasPending(state, mint, 'buy') &&
        slot - h.lastBuySlot >= ADD_DELAY_SLOTS &&
        pos.cost_lamports < MAX_STAKE &&
        t !== undefined &&
        !t.devSold
      ) {
        const avg = priceOf(pos.cost_lamports, pos.token_amount);
        const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const { net, buyShare } = flowStats(t, slot);
        if (avg > 0 && now >= avg * ADD_RISE && net > 0n && buyShare >= FLOW_BUY_SHARE_PCT) {
          const cap = state.maxBuyLamports(mint);
          let amount = cap < ADD_BUY ? cap : ADD_BUY;
          const room = MAX_STAKE - pos.cost_lamports;
          if (amount > room) amount = room;
          if (amount >= MIN_BUY && state.freeCashLamports() - amount >= CASH_BUFFER) {
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
            h.added = true;
            h.lastBuySlot = slot;
          }
        }
      }
    }

    // ---- first buys on coins that traded this batch -------------------------
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
      if ((trips.get(mint) ?? 0) >= MAX_TRIPS_PER_COIN) continue;
      if (slot < (cooldownUntil.get(mint) ?? 0)) continue;
      if (slot < (decidedUntil.get(mint) ?? 0)) continue;
      const amount = entryOk(state, mint, slot);
      if (amount === 0n) continue;
      if (state.freeCashLamports() - amount - tx < CASH_BUFFER) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      held.set(mint, { sinceSlot: slot, peakRatio: 1, partialDone: false, added: false, lastBuySlot: slot });
      slots -= 1;
    }

    return orders;
  },
});
