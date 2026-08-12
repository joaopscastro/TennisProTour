'use client';

import { useCallback, useEffect, useState } from 'react';
import { createProCheckoutSession, EntitlementDto, fetchEntitlement } from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';
import { AppFrame, Hero, SectionLabel } from '../../components/ui/primitives';

const CONVENIENCE_PERKS = [
  {
    title: 'Longer registration windows',
    body: "More time to enter tournaments around your schedule — the entry requirements and field are identical.",
  },
  {
    title: 'Extra stats & history pages',
    body: 'Deeper match history and long-run performance charts. Nothing here changes a single simulation.',
  },
  {
    title: 'Vacation delegate',
    body: "Hand your roster to another Pro manager while you're away, so fatigue and entries don't pile up untouched.",
  },
  {
    title: 'No banners',
    body: "Removes ad banners from your dashboard. That's it — no simulation changes.",
  },
];

export default function ManagerProPage() {
  const [managerId, setManagerId] = useState('seed-m1');
  const [managerIdInput, setManagerIdInput] = useState('seed-m1');
  const [entitlement, setEntitlement] = useState<EntitlementDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      setEntitlement(await fetchEntitlement(id));
    } catch (e) {
      setEntitlement(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(managerId);
  }, [managerId, load]);

  const tier = entitlement?.tier ?? 'free';

  const handleUpgrade = useCallback(async () => {
    setCheckingOut(true);
    setError(null);
    try {
      const { url } = await createProCheckoutSession(managerId);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCheckingOut(false);
    }
  }, [managerId]);

  return (
    <AppFrame>
      <Sidebar active="manager-pro" tier={tier} xpBalance={entitlement?.xpBalance} />

      <div className="flex-1 p-8 max-w-[1080px] min-w-0">
        {/* Hero */}
        <Hero minHeight={190}>
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div className="max-w-[660px]">
              <div className="inline-flex items-center gap-2 px-[10px] py-[4px] rounded-full text-[11px] font-bold tracking-[0.6px] uppercase mb-[14px]"
                style={{ background: 'oklch(88% 0.19 122 / 0.16)', color: 'var(--gc-ball)', border: '1px solid oklch(88% 0.19 122 / 0.3)' }}>
                ◆ Membership
              </div>
              <div className="text-[34px] font-extrabold tracking-[-0.5px] text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.4)]">
                Manager Pro
              </div>
              <div className="text-[14px] mt-[10px] leading-[1.6] text-white/80">
                More room to manage, less upkeep, and a modest coaching edge — never a better formula.
                The coaching system works identically for every manager; Pro just gets a second slot to run
                it with. Every perk that touches competitiveness is spelled out below in plain sight — nothing
                hidden in fine print.
              </div>
            </div>
            {!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && (
              <form
                className="flex items-center gap-[6px] text-[11.5px] flex-none text-white/70"
                onSubmit={(e) => {
                  e.preventDefault();
                  setManagerId(managerIdInput.trim() || managerId);
                }}
              >
                Manager ID (dev)
                <input
                  value={managerIdInput}
                  onChange={(e) => setManagerIdInput(e.target.value)}
                  className="gc-input rounded px-2 py-1 text-[12px]"
                  style={{ width: 110 }}
                />
              </form>
            )}
          </div>
        </Hero>

        {error && (
          <div
            className="mt-5 text-[13px] rounded-[6px] px-3 py-2"
            style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}
          >
            {error}
          </div>
        )}

        {/* TIER CARDS */}
        <div className="grid grid-cols-2 gap-4 mt-7 mb-8">
          <div className="gc-card rounded-[12px] p-[24px]">
            <div className="text-[12px] font-bold tracking-[0.5px] uppercase" style={{ color: 'var(--gc-ink-mute)' }}>
              Free
            </div>
            <div className="text-[30px] font-extrabold mt-2" style={{ color: 'var(--gc-ink)' }}>$0</div>
            <div className="text-[13px] mt-[6px] leading-[1.55]" style={{ color: 'var(--gc-ink-mute)' }}>
              Fully playable. Every tournament, every match sim, every core system — no crippled trial, no paywalled
              mechanics.
            </div>
            <div className="h-px my-5" style={{ background: 'var(--gc-line)' }} />
            <div className="text-[13px] flex items-center gap-2" style={{ color: 'var(--gc-ink-dim)' }}>
              <span className="font-bold" style={{ color: 'var(--gc-ball)' }}>✓</span>
              2 roster slots, full decay rate
            </div>
            {tier === 'free' && (
              <div className="mt-4 text-[11.5px] font-semibold px-[10px] py-[6px] rounded-[6px] inline-block"
                style={{ background: 'var(--gc-s3)', color: 'var(--gc-ink-dim)' }}>
                Your current plan
              </div>
            )}
          </div>

          <div className="gc-card rounded-[12px] p-[24px] relative overflow-hidden"
            style={{ border: '1.5px solid oklch(88% 0.19 122 / 0.4)' }}>
            <div className="absolute top-0 right-0 h-[3px] w-full"
              style={{ background: 'linear-gradient(90deg, var(--gc-ball), transparent)' }} />
            <div className="text-[12px] font-bold tracking-[0.5px] uppercase" style={{ color: 'var(--gc-ball)' }}>
              Manager Pro
            </div>
            <div className="text-[30px] font-extrabold mt-2" style={{ color: 'var(--gc-ink)' }}>
              $4.99<span className="text-[15px] font-medium" style={{ color: 'var(--gc-ink-mute)' }}>/mo</span>
            </div>
            <div className="text-[13px] mt-[6px] leading-[1.55]" style={{ color: 'var(--gc-ink-mute)' }}>
              More room to manage, less upkeep — and one honest tradeoff on the one perk that matters competitively.
            </div>
            <div className="h-px my-5" style={{ background: 'var(--gc-line)' }} />
            {tier === 'pro' ? (
              <div className="w-full text-center py-[12px] rounded-[8px] text-[13.5px] font-bold"
                style={{ background: 'oklch(88% 0.19 122 / 0.16)', color: 'var(--gc-ball)', border: '1px solid oklch(88% 0.19 122 / 0.3)' }}>
                You&rsquo;re on Manager Pro
              </div>
            ) : (
              <button
                onClick={handleUpgrade}
                disabled={checkingOut}
                className="gc-btn gc-btn--primary w-full justify-center py-[12px] text-[13.5px] font-bold disabled:opacity-60"
              >
                {checkingOut ? 'Redirecting to checkout…' : 'Upgrade to Manager Pro'}
              </button>
            )}
          </div>
        </div>

        {/* THE ONE PERK WITH A REAL EDGE */}
        <SectionLabel>The one perk with a real edge</SectionLabel>
        <div className="text-[12.5px] mb-3 -mt-2" style={{ color: 'var(--gc-ink-mute)' }}>
          This does affect competitiveness — here&rsquo;s exactly what it is and why it&rsquo;s still fair.
        </div>
        <div
          className="rounded-[12px] p-[22px_24px] mb-8"
          style={{ border: '1px solid oklch(64% 0.14 245 / 0.4)', background: 'linear-gradient(180deg, oklch(30% 0.06 245 / 0.5), oklch(22% 0.03 245 / 0.3))' }}
        >
          <div className="text-[15.5px] font-bold" style={{ color: 'var(--gc-ink)' }}>
            A 2nd coach slot
          </div>
          <div className="text-[13px] mt-[6px] leading-[1.55]" style={{ color: 'var(--gc-ink-dim)' }}>
            Run two coaches training two players at once instead of one. This is a real training-efficiency edge
            over a single-coach roster — not a hidden one, and not a bigger one than that.
          </div>
          <div className="text-[13px] mt-[10px] leading-[1.55]" style={{ color: 'var(--gc-ink-dim)' }}>
            The coaching system itself is identical for every manager: same formulas, same training gains per coach,
            free or Pro. Manager Pro doesn&rsquo;t get a better coach — it gets a second one.
          </div>
        </div>

        {/* THE ONE PERK WITH A COST */}
        <SectionLabel>The one perk with a cost</SectionLabel>
        <div className="text-[12.5px] mb-3 -mt-2" style={{ color: 'var(--gc-ink-mute)' }}>
          The only part of Manager Pro with a real cost attached to it — and it&rsquo;s not a flat unlock.
        </div>
        <div
          className="rounded-[12px] p-[22px_24px] mb-8"
          style={{ border: '1px solid oklch(64% 0.155 46 / 0.4)', background: 'linear-gradient(180deg, oklch(32% 0.08 46 / 0.5), oklch(22% 0.04 46 / 0.3))' }}
        >
          <div className="flex items-start gap-[22px]">
            <div className="flex-1">
              <div className="text-[15.5px] font-bold" style={{ color: 'var(--gc-ink)' }}>
                4 roster slots instead of 2
              </div>
              <div className="text-[13px] mt-[6px] leading-[1.55]" style={{ color: 'var(--gc-ink-dim)' }}>
                Manage twice the players and enter twice the tournaments at once.
              </div>
            </div>
            <div className="w-px self-stretch" style={{ background: 'var(--gc-line-hi)' }} />
            <div className="flex-1">
              <div className="flex items-center gap-[6px] text-[15.5px] font-bold" style={{ color: 'var(--sf-clay)' }}>
                <span>&#9888;</span>Faster point decay on those slots
              </div>
              <div className="text-[13px] mt-[6px] leading-[1.55]" style={{ color: 'var(--gc-ink-dim)' }}>
                Your 2 extra slots lose ranking points faster between tournaments than your base 2. More roster, more
                decay — not a free power gain.
              </div>
            </div>
          </div>
        </div>

        {/* PURE CONVENIENCE */}
        <SectionLabel>Everything else is convenience</SectionLabel>
        <div className="text-[12.5px] mb-3 -mt-2" style={{ color: 'var(--gc-ink-mute)' }}>
          Zero effect on competitiveness — quality-of-life for managers who play a lot, not an edge for managers who
          pay.
        </div>
        <div className="grid grid-cols-2 gap-3">
          {CONVENIENCE_PERKS.map((perk) => (
            <div key={perk.title} className="gc-card gc-card--hover rounded-[10px] p-[18px_20px]">
              <div className="text-[14px] font-semibold" style={{ color: 'var(--gc-ink)' }}>{perk.title}</div>
              <div className="text-[12.5px] mt-1 leading-[1.55]" style={{ color: 'var(--gc-ink-mute)' }}>
                {perk.body}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 text-[12px] leading-[1.65] max-w-[660px]" style={{ color: 'var(--gc-ink-mute)' }}>
          We built Manager Pro this way on purpose: of the two perks that touch competitiveness, one (roster slots)
          carries an equal and opposite cost, so paying never buys a stronger roster — only a bigger, faster-aging
          one. The other (a 2nd coach slot) is a modest, fully disclosed training-efficiency edge running the same
          coaching system every manager uses — not a better version of it.
        </div>
      </div>
    </AppFrame>
  );
}
