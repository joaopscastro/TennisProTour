/**
 * Manager cosmetics (Batch 4B, F2) — the zero-competitive-effect XP sink.
 *
 * The problem this solves: a free-tier manager at the roster cap
 * accumulates manager XP with nothing to spend it on. Income is
 * `StandardManagerXpPolicy` (BASE_XP × tier multiplier, +60 for a win)
 * and the only sinks are talent claims (50-300 XP) and one-time coach
 * conversions — the 52-week agent season ended with 123k-155k unspent XP
 * and no sink at all. XP is now a spendable currency for cosmetic
 * self-expression: a manager banner style, a badge glyph shown next to
 * your name on the public manager leaderboard, or a celebration skin.
 *
 * **This is deliberately and strictly cosmetic.** Design principle #1:
 * money (and therefore XP) never buys an unconditional win-rate boost.
 * A cosmetic item has NO attribute, training, fatigue, ranking or
 * simulation effect of any kind — the `CosmeticItem` shape below carries
 * only presentation data (id, kind, name, description, price, glyph),
 * and `ManagerCosmetics.test.ts` pins both the shape and a source-level
 * guard that no sim/training/ranking module reads any cosmetic.
 *
 * **Explicitly rejected in this batch, stated here so it reads as a
 * scope decision rather than an oversight:** XP → player development
 * XP, training boosts, fatigue recovery, or practice sessions. Every one
 * of those would buy win-rate and would need its own disclosed design
 * (including whatever offsetting cost makes it fair) before shipping.
 * The one disclosed competitive exception in the whole economy remains
 * Manager Pro's second coach slot — priced separately by Stripe, not by
 * XP, and untouched by this feature.
 *
 * All prices are explicit PLACEHOLDER balance values, flagged the same
 * way aging thresholds/ranking points are — owned by the next agent
 * season, not derived from anything.
 */

export type CosmeticKind = 'banner' | 'badge' | 'celebration';

/**
 * One purchasable cosmetic. Deliberately presentation-only: there is no
 * field here that any game system could read to change a match, a
 * training session, a ranking total, or a fatigue value. If a future
 * item needs an EFFECT, it does not belong in this catalog.
 */
export interface CosmeticItem {
  readonly id: string;
  readonly kind: CosmeticKind;
  readonly name: string;
  /** One-line manager-facing description of what it changes in the UI. */
  readonly description: string;
  /** XP price, deducted from the manager's wallet on purchase.
   * PLACEHOLDER — see this file's doc comment. */
  readonly price: number;
  /** A short unicode glyph the UI can render (badges next to a name,
   * banner accents, celebration flourishes). Presentation only. */
  readonly glyph: string;
}

/**
 * The catalog. Nine items across the three kinds, cheap-to-showy.
 * PLACEHOLDER prices (200-2500 XP): a manager earning ~30-110 XP per
 * title plus weekly match results has something to save toward at every
 * scale, and the whole catalog costs less than the unspent balances the
 * agent season actually produced — that is the point (a real sink), not
 * a tuned economy.
 */
export const MANAGER_COSMETICS: readonly CosmeticItem[] = [
  {
    id: 'banner-classic',
    kind: 'banner',
    name: 'Classic Banner',
    description: 'A clean, timeless banner behind your manager profile.',
    price: 250,
    glyph: '▬',
  },
  {
    id: 'banner-aurora',
    kind: 'banner',
    name: 'Aurora Banner',
    description: 'A shifting, many-hued gradient behind your manager profile.',
    price: 700,
    glyph: '≈',
  },
  {
    id: 'banner-obsidian',
    kind: 'banner',
    name: 'Obsidian Banner',
    description: 'A deep, matte-black banner for managers who mean business.',
    price: 1100,
    glyph: '◼',
  },
  {
    id: 'badge-star',
    kind: 'badge',
    name: 'Star Badge',
    description: 'A star glyph shown next to your name on the manager leaderboard.',
    price: 200,
    glyph: '★',
  },
  {
    id: 'badge-comet',
    kind: 'badge',
    name: 'Comet Badge',
    description: 'A streaking comet shown next to your name on the manager leaderboard.',
    price: 600,
    glyph: '✦',
  },
  {
    id: 'badge-crown',
    kind: 'badge',
    name: 'Crown Badge',
    description: 'A crown shown next to your name on the manager leaderboard.',
    price: 1500,
    glyph: '♛',
  },
  {
    id: 'celebration-confetti',
    kind: 'celebration',
    name: 'Confetti',
    description: 'Confetti burst when one of your players lifts a trophy.',
    price: 400,
    glyph: '✳',
  },
  {
    id: 'celebration-fireworks',
    kind: 'celebration',
    name: 'Fireworks',
    description: 'A fireworks display when one of your players lifts a trophy.',
    price: 1200,
    glyph: '✹',
  },
  {
    id: 'celebration-gold',
    kind: 'celebration',
    name: 'Gold Rush',
    description: 'A shower of gold when one of your players lifts a trophy.',
    price: 2000,
    glyph: '❖',
  },
];

const BY_ID = new Map(MANAGER_COSMETICS.map((item) => [item.id, item]));

/** The catalog item for an id, or null when it does not exist — the one
 * validation boundary every purchase goes through (a client can never
 * choose its own price). */
export function cosmeticById(id: string): CosmeticItem | null {
  return BY_ID.get(id) ?? null;
}

/**
 * The badge a manager's name displays on the public leaderboard, from
 * their owned item ids: the HIGHEST-PRICED owned badge (ties broken by
 * catalog order), or null when they own no badge. Deterministic and
 * server-side — there is deliberately no "set featured badge" action in
 * this batch; the priciest one is simply the best one you own, so the
 * display can never drift from the purchase record.
 */
export function ownedBadgeFor(ownedItemIds: readonly string[]): CosmeticItem | null {
  let best: CosmeticItem | null = null;
  for (const id of ownedItemIds) {
    const item = cosmeticById(id);
    if (!item || item.kind !== 'badge') continue;
    if (!best || item.price > best.price) best = item;
  }
  return best;
}
