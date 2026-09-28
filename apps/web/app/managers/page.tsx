'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CosmeticItemDto,
  CosmeticPurchaseDto,
  ManagerCosmeticsDto,
  ManagerLeaderboardDto,
  fetchManagerCosmetics,
  fetchManagerLeaderboard,
  purchaseManagerCosmetic,
} from '../../lib/api';
import { AppShell } from '../../components/ui/AppShell';
import { PageShell, SectionLabel, Button } from '../../components/ui/primitives';
import { useDevManagerId } from '../../lib/managerContext';
import { useEntitlement } from '../../lib/entitlement';
import { xpAffordability } from '../../lib/xp';
import { MEDAL } from '../../lib/ui/medals';

const KIND_LABEL: Record<CosmeticItemDto['kind'], string> = {
  banner: 'Banner styles',
  badge: 'Badges',
  celebration: 'Celebration skins',
};
const KIND_ORDER: CosmeticItemDto['kind'][] = ['badge', 'banner', 'celebration'];

function BadgeGlyph({ glyph, name }: { glyph: string; name: string }) {
  return (
    <span
      title={`${name} badge`}
      aria-label={`${name} badge`}
      style={{ marginRight: 6, color: 'var(--gold)', display: 'inline-block' }}
    >
      {glyph}
    </span>
  );
}

export default function ManagersPage() {
  const devManagerId = useDevManagerId();
  const [managerId] = useState(devManagerId ?? '');
  const { entitlement, refresh: refreshEntitlement } = useEntitlement(managerId);
  const [board, setBoard] = useState<ManagerLeaderboardDto | null>(null);
  const [cosmetics, setCosmetics] = useState<ManagerCosmeticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [buyingItemId, setBuyingItemId] = useState<string | null>(null);

  const loadBoard = useCallback(() => {
    fetchManagerLeaderboard(100)
      .then(setBoard)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const loadCosmetics = useCallback(() => {
    fetchManagerCosmetics()
      .then(setCosmetics)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    loadBoard();
    loadCosmetics();
  }, [loadBoard, loadCosmetics]);

  const handleBuy = useCallback(
    async (item: CosmeticItemDto) => {
      setBuyingItemId(item.id);
      setError(null);
      setNotice(null);
      try {
        const result: CosmeticPurchaseDto = await purchaseManagerCosmetic(item.id);
        // The shared entitlement store keeps every XP surface in sync
        // (sidebar included) — the same post-spend refresh the claim and
        // coach-conversion paths use.
        await refreshEntitlement();
        // Re-read the owned set so the leaderboard badge changes with it.
        loadCosmetics();
        loadBoard();
        setNotice(`Unlocked ${item.name} — ${result.xpSpent} XP spent.`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBuyingItemId(null);
      }
    },
    [refreshEntitlement, loadCosmetics, loadBoard],
  );

  const self = board?.self;
  const selfInTop = board?.standings.some((r) => r.isSelf) ?? false;
  const owned = new Set(cosmetics?.owned ?? []);
  const xpBalance = entitlement?.xpBalance;

  return (
    <AppShell active="managers" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
      <PageShell>
        {/* Page header — flat (Direction A), with the caller's own standing
            as the one summary figure beside it. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div className="t-label">The Tour Standings</div>
            <h1 className="t-h1" style={{ margin: '4px 0 0' }}>Manager Rankings</h1>
            <div className="t-body-sm" style={{ marginTop: 4, maxWidth: 580 }}>
              Every ranking point your players earn banks onto your ladder — but it erodes a little each week. Stand still and you slide. This is the number that never stops moving.
            </div>
          </div>
          {self && (
            <div className="gc-subbar" style={{ flex: 'none', gap: 16, padding: '10px 16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                <span className="t-label" style={{ margin: 0 }}>Your Position</span>
                <span className="num" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1, color: 'var(--gold)' }}>
                  {self.rank !== null ? `#${self.rank}` : 'NR'}
                </span>
                <span className="num" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                  {self.score.toLocaleString()} pts
                </span>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div
            className="gc-notice"
            style={{
              marginTop: 18,
              color: 'var(--loss)',
              borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)',
              background: 'color-mix(in srgb, var(--loss) 10%, transparent)',
            }}
          >
            {error}
          </div>
        )}
        {notice && (
          <div className="gc-notice" style={{ marginTop: 18, color: 'var(--win)' }}>
            {notice}
          </div>
        )}

        {/* THE XP SINK — cosmetics. Deliberately zero effect on the sim,
            training, or rankings (Batch 4B, F2); purely how your manager
            name and profile look. */}
        <SectionLabel>Your collection</SectionLabel>
        <div className="gc-tbl-note" style={{ padding: 0, marginBottom: 12 }}>
          Spend manager XP on how your name looks — a banner style, the badge shown next to your name on the
          leaderboard, or a celebration skin. Nothing here changes a single match, training gain, or ranking point.
        </div>
        {cosmetics && (
          <div className="gc-panel" style={{ padding: '18px 20px', marginBottom: 18 }}>
            <div className="t-body-sm" style={{ marginBottom: 12 }}>
              {owned.size === 0
                ? 'Nothing unlocked yet.'
                : `Unlocked: ${cosmetics.catalog
                    .filter((item) => owned.has(item.id))
                    .map((item) => `${item.glyph} ${item.name}`)
                    .join(' · ')}`}
              {cosmetics.badge && (
                <span style={{ marginLeft: 8, color: 'var(--ink-3)' }}>
                  Leaderboard badge: {cosmetics.badge.glyph} {cosmetics.badge.name}
                </span>
              )}
            </div>
            {KIND_ORDER.map((kind) => (
              <div key={kind} style={{ marginBottom: 14 }}>
                <div className="t-label" style={{ marginBottom: 6 }}>{KIND_LABEL[kind]}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
                  {cosmetics.catalog
                    .filter((item) => item.kind === kind)
                    .map((item) => {
                      const isOwned = owned.has(item.id);
                      const afford = xpAffordability(xpBalance, item.price);
                      const disabled = isOwned || buyingItemId !== null || afford.state !== 'affordable';
                      return (
                        <div key={item.id} className="gc-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: 'var(--gold)', fontSize: 16 }}>{item.glyph}</span>
                            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{item.name}</span>
                            {isOwned && <span className="gc-badge" style={{ color: 'var(--accent)' }}>Owned</span>}
                          </div>
                          <div className="t-body-sm" style={{ lineHeight: 1.5 }}>{item.description}</div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 'auto' }}>
                            <span className="num" style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{item.price} XP</span>
                            <Button
                              variant={isOwned ? 'ghost' : 'primary'}
                              onClick={() => void handleBuy(item)}
                              disabled={disabled}
                              style={{ padding: '6px 12px', fontSize: 12.5 }}
                            >
                              {isOwned
                                ? 'Owned'
                                : buyingItemId === item.id
                                  ? 'Buying…'
                                  : afford.state === 'short'
                                    ? `Need ${afford.remaining} more`
                                    : 'Unlock'}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        )}

        {board && board.standings.length === 0 && !error && (
          <div className="gc-panel" style={{ marginTop: 18, padding: '28px 20px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
            No manager has banked a ranking point yet. Win a match and you&apos;ll be the first name on the board.
          </div>
        )}

        {board && board.standings.length > 0 && (
          <div className="gc-panel" style={{ marginTop: 18 }}>
            <div className="gc-panel-bd flush">
              <table className="gc-table">
                <thead>
                  <tr>
                    <th className="r" style={{ width: 70 }}>Rank</th>
                    <th>Manager</th>
                    <th className="r">Ladder Score</th>
                  </tr>
                </thead>
                <tbody>
                  {board.standings.map((row) => (
                    <tr key={row.managerId} className={row.isSelf ? 'is-selected' : undefined}>
                      <td className="r">
                        <span className="num" style={{ fontWeight: 600, color: row.rank <= 3 ? MEDAL[row.rank - 1] : 'var(--ink-2)' }}>
                          {row.rank <= 3 && (
                            <span className="gc-dot" style={{ background: MEDAL[row.rank - 1], marginRight: 6 }} />
                          )}
                          #{row.rank}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: row.isSelf ? 600 : 400, color: row.isSelf ? 'var(--gold)' : 'var(--ink)' }}>
                          {row.badge && <BadgeGlyph glyph={row.badge.glyph} name={row.badge.name} />}
                          {row.displayName}
                        </span>
                        {row.isSelf && (
                          <span className="gc-badge" style={{ marginLeft: 8, color: 'var(--accent)' }}>You</span>
                        )}
                      </td>
                      <td className="r num" style={{ fontWeight: 600 }}>{row.score.toLocaleString()}</td>
                    </tr>
                  ))}

                  {/* Outside the returned slice: the caller's own row is
                      appended below the cut, not hidden. */}
                  {self && self.rank !== null && !selfInTop && (
                    <tr className="is-selected" style={{ borderTop: '2px solid var(--hair-2)' }}>
                      <td className="r">
                        <span className="num" style={{ fontWeight: 600, color: 'var(--gold)' }}>#{self.rank}</span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 600, color: 'var(--gold)' }}>
                          {self.badge && <BadgeGlyph glyph={self.badge.glyph} name={self.badge.name} />}
                          {self.displayName}
                        </span>
                        <span className="gc-badge" style={{ marginLeft: 8, color: 'var(--accent)' }}>You</span>
                      </td>
                      <td className="r num" style={{ fontWeight: 600 }}>{self.score.toLocaleString()}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </PageShell>
    </AppShell>
  );
}
