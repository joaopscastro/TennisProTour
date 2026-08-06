'use client';

import { useCallback, useEffect, useState } from 'react';
import { createProCheckoutSession, EntitlementDto, fetchEntitlement } from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';

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
    <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
      <Sidebar active="manager-pro" tier={tier} />

      <div className="flex-1 p-9 max-w-[1080px] min-w-0">
        <div className="flex items-start justify-between gap-6 mb-2">
          <div className="max-w-[640px]">
            <div className="text-[23px] font-bold tracking-[-0.2px]">Manager Pro</div>
            <div className="text-[14px] mt-[6px] leading-[1.55]" style={{ color: 'oklch(45% 0.006 75)' }}>
              A paid tier for managers who want more room, less upkeep, and a modest coaching edge — not a better
              formula. The coaching system works identically for every manager; Pro just gets a second slot to run
              it with. The one perk that carries a real tradeoff cost is spelled out below too, not in fine print.
            </div>
          </div>
          <form
            className="flex items-center gap-[6px] text-[11.5px] flex-none"
            style={{ color: 'oklch(52% 0.006 75)' }}
            onSubmit={(e) => {
              e.preventDefault();
              setManagerId(managerIdInput.trim() || managerId);
            }}
          >
            Manager ID (dev)
            <input
              value={managerIdInput}
              onChange={(e) => setManagerIdInput(e.target.value)}
              className="rounded px-2 py-1 text-[12px] text-[oklch(22%_0.006_75)]"
              style={{ background: 'white', border: '1px solid oklch(88% 0.006 75)' }}
            />
          </form>
        </div>

        {error && (
          <div
            className="mb-4 text-[13px] rounded-[6px] px-3 py-2"
            style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}
          >
            {error}
          </div>
        )}

        {/* Net-line motif divider */}
        <div className="flex items-center gap-0 my-5">
          <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
          <div className="flex-1 h-[1.5px]" style={{ background: 'oklch(50% 0.006 75)' }} />
          <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
          <div className="flex-1 h-[1.5px]" style={{ background: 'oklch(50% 0.006 75)' }} />
          <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
        </div>

        {/* TIER CARDS */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="rounded-[10px] p-[22px] bg-white" style={{ border: '1px solid oklch(90% 0.005 75)' }}>
            <div className="text-[12px] font-bold tracking-[0.4px] uppercase" style={{ color: 'oklch(50% 0.006 75)' }}>
              Free
            </div>
            <div className="text-[26px] font-bold mt-2">$0</div>
            <div className="text-[13px] mt-[6px] leading-[1.5]" style={{ color: 'oklch(48% 0.006 75)' }}>
              Fully playable. Every tournament, every match sim, every core system — no crippled trial, no paywalled
              mechanics.
            </div>
            <div className="h-px my-4" style={{ background: 'oklch(93% 0.005 75)' }} />
            <div className="text-[13px] flex items-center gap-2" style={{ color: 'oklch(30% 0.006 75)' }}>
              <span className="font-bold" style={{ color: 'oklch(52% 0.12 142)' }}>
                ✓
              </span>
              2 roster slots, full decay rate
            </div>
            {tier === 'free' && (
              <div className="mt-3 text-[11.5px] font-semibold" style={{ color: 'oklch(52% 0.006 75)' }}>
                Your current plan
              </div>
            )}
          </div>

          <div className="rounded-[10px] p-[22px] bg-white" style={{ border: '1.5px solid oklch(20% 0.006 75)' }}>
            <div className="text-[12px] font-bold tracking-[0.4px] uppercase" style={{ color: 'oklch(50% 0.006 75)' }}>
              Manager Pro
            </div>
            <div className="text-[26px] font-bold mt-2">
              $4.99<span className="text-[14px] font-medium" style={{ color: 'oklch(50% 0.006 75)' }}>/mo</span>
            </div>
            <div className="text-[13px] mt-[6px] leading-[1.5]" style={{ color: 'oklch(48% 0.006 75)' }}>
              More room to manage, less upkeep — and one honest tradeoff on the one perk that matters competitively.
            </div>
            <div className="h-px my-4" style={{ background: 'oklch(93% 0.005 75)' }} />
            {tier === 'pro' ? (
              <div className="w-full text-center text-white py-[11px] rounded-[6px] text-[13.5px] font-semibold" style={{ background: 'oklch(52% 0.12 142)' }}>
                You&rsquo;re on Manager Pro
              </div>
            ) : (
              <button
                onClick={handleUpgrade}
                disabled={checkingOut}
                className="w-full text-white border-none py-[11px] rounded-[6px] text-[13.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-60"
                style={{ background: 'oklch(20% 0.006 75)' }}
              >
                {checkingOut ? 'Redirecting to checkout…' : 'Upgrade to Manager Pro'}
              </button>
            )}
          </div>
        </div>

        {/* THE ONE PERK WITH A REAL EDGE */}
        <div className="mb-[10px]">
          <div className="text-[13px] font-bold tracking-[0.4px] uppercase" style={{ color: 'oklch(45% 0.1 240)' }}>
            The one perk with a real edge
          </div>
          <div className="text-[12.5px] mt-[3px]" style={{ color: 'oklch(48% 0.006 75)' }}>
            This does affect competitiveness — here&rsquo;s exactly what it is and why it&rsquo;s still fair.
          </div>
        </div>
        <div
          className="rounded-[10px] p-[20px_22px] mb-8"
          style={{ border: '1.5px solid oklch(85% 0.03 240)', background: 'oklch(97% 0.01 240)' }}
        >
          <div className="text-[15px] font-bold" style={{ color: 'oklch(25% 0.006 75)' }}>
            A 2nd coach slot
          </div>
          <div className="text-[13px] mt-[5px] leading-[1.5]" style={{ color: 'oklch(42% 0.006 75)' }}>
            Run two coaches training two players at once instead of one. This is a real training-efficiency edge
            over a single-coach roster — not a hidden one, and not a bigger one than that.
          </div>
          <div className="text-[13px] mt-[10px] leading-[1.5]" style={{ color: 'oklch(42% 0.006 75)' }}>
            The coaching system itself is identical for every manager: same formulas, same training gains per coach,
            free or Pro. Manager Pro doesn&rsquo;t get a better coach — it gets a second one.
          </div>
        </div>

        {/* THE ONE PERK WITH A COST */}
        <div className="mb-[10px]">
          <div className="text-[13px] font-bold tracking-[0.4px] uppercase" style={{ color: 'oklch(48% 0.13 30)' }}>
            The one perk with a cost
          </div>
          <div className="text-[12.5px] mt-[3px]" style={{ color: 'oklch(48% 0.006 75)' }}>
            The only part of Manager Pro with a real cost attached to it — and it&rsquo;s not a flat unlock.
          </div>
        </div>
        <div
          className="rounded-[10px] p-[20px_22px] mb-8"
          style={{ border: '1.5px solid oklch(88% 0.03 30)', background: 'oklch(97% 0.012 30)' }}
        >
          <div className="flex items-start gap-[18px]">
            <div className="flex-1">
              <div className="text-[15px] font-bold" style={{ color: 'oklch(25% 0.006 75)' }}>
                4 roster slots instead of 2
              </div>
              <div className="text-[13px] mt-[5px] leading-[1.5]" style={{ color: 'oklch(42% 0.006 75)' }}>
                Manage twice the players and enter twice the tournaments at once.
              </div>
            </div>
            <div className="w-px self-stretch" style={{ background: 'oklch(85% 0.03 30)' }} />
            <div className="flex-1">
              <div className="flex items-center gap-[6px] text-[15px] font-bold" style={{ color: 'oklch(40% 0.13 30)' }}>
                <span>&#9888;</span>Faster point decay on those slots
              </div>
              <div className="text-[13px] mt-[5px] leading-[1.5]" style={{ color: 'oklch(42% 0.006 75)' }}>
                Your 2 extra slots lose ranking points faster between tournaments than your base 2. More roster, more
                decay — not a free power gain.
              </div>
            </div>
          </div>
        </div>

        {/* PURE CONVENIENCE */}
        <div className="mb-[10px]">
          <div className="text-[13px] font-bold tracking-[0.4px] uppercase" style={{ color: 'oklch(48% 0.006 75)' }}>
            Everything else is convenience
          </div>
          <div className="text-[12.5px] mt-[3px]" style={{ color: 'oklch(48% 0.006 75)' }}>
            Zero effect on competitiveness — quality-of-life for managers who play a lot, not an edge for managers who
            pay.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {CONVENIENCE_PERKS.map((perk) => (
            <div key={perk.title} className="rounded-[8px] p-[16px_18px] bg-white" style={{ border: '1px solid oklch(90% 0.005 75)' }}>
              <div className="text-[14px] font-semibold">{perk.title}</div>
              <div className="text-[12.5px] mt-1 leading-[1.5]" style={{ color: 'oklch(48% 0.006 75)' }}>
                {perk.body}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-7 text-[12px] leading-[1.6] max-w-[640px]" style={{ color: 'oklch(52% 0.006 75)' }}>
          We built Manager Pro this way on purpose: of the two perks that touch competitiveness, one (roster slots)
          carries an equal and opposite cost, so paying never buys a stronger roster — only a bigger, faster-aging
          one. The other (a 2nd coach slot) is a modest, fully disclosed training-efficiency edge running the same
          coaching system every manager uses — not a better version of it.
        </div>
      </div>
    </div>
  );
}
