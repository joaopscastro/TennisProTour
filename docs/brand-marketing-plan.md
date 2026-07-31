# Brand & Marketing Plan

## 0. Updated competitive context (important — read this first)

While checking candidate names, one significant fact surfaced that changes
the earlier competitive picture: **ReboundCG's "Tennis Manager Mobile"**
(the same studio behind the PC Tennis Manager 25/26 series) is a
free-to-play, actively-maintained mobile app with a 4.5★ rating across
~493 reviews, already offering a 4-player roster, scouting, PvP leagues,
and live events tied to real Grand Slams. This means the space isn't
"two abandoned browser games and nothing else" — it's that *plus* one
well-run modern free competitor with real polish and (implied) modest
in-app-purchase monetization.

This doesn't invalidate the plan, but it sharpens the positioning: our
edge isn't "we exist and they don't," it's specifically **(a)** winning
back the browser-first, PC-manager-game crowd that ReboundCG's mobile
app doesn't really serve, and **(b)** being demonstrably fairer on
monetization than a mobile IAP-driven competitor, which is a real
differentiation angle since mobile F2P games have a well-earned
reputation problem on that front.

---

## 1. Naming

### Ruled out (already in use — checked, not assumed)
| Name | Why it's out |
|---|---|
| Tiebreak | Official ATP/WTA console game (Nacon/Big Ant), plus at least 3 other tennis apps use it |
| Baseline | Used as an AI coaching app name and as a feature name inside the existing Tennis Manager franchise |
| Deuce | At least 4 existing tennis apps, including one backed by Andy Murray |
| Tennis Manager | Registered trademark (Rebound Capital Games, EUIPO) |
| Top Spin / Top Seed | Existing console franchise / existing mobile manager game |

### Shortlist (not exhaustively trademark/domain-checked — verify before committing, see step below)
| Name | Read | Fit |
|---|---|---|
| **Grand Circuit** | Evokes the full journey (juniors → majors) that's central to the core loop; "Circuit" is the actual tennis-world term for the tour structure, so it's descriptive without being generic like "Tennis Manager" | Strong — my top pick |
| **Netside** | Short, brandable, single word, doesn't scream "manager game" so it could extend into a broader sports-manager suite later if that ever made sense | Good backup |
| **Match Circuit** | Similar logic to Grand Circuit, slightly more generic | Fine, less distinctive |
| **Racket Rise** | Alliterative, evokes the aging/progression arc directly | Good but slightly cutesy for a "serious sim" positioning |
| **Love All** | Tennis term for 0-0 — a nice thematic nod to every manager's fresh start, and "all" gestures at inclusivity/fairness (fits the non-p2w positioning) | Interesting but less immediately legible as tennis-related to newcomers |

**Recommendation: Grand Circuit.** It's descriptive of the actual gameplay (the circuit structure is your core progression system), doesn't collide with any trademark or app found in checks, and reads as a serious sim rather than a mobile-casual game — which matches the "Rocking Rackets, rebuilt" positioning better than something cutesy.

### Before finalizing — do this validation pass (I can't do these directly)
1. Domain check: `grandcircuit.gg` / `.app` / `.com` availability.
2. Trademark search: EUIPO (since you're EU-based) and USPTO quick search for "Grand Circuit" in games/software classes.
3. Handle check: X/Twitter, Discord server name, itch.io/Steam-style listing name (if ever ported).
4. App store name check on Apple/Google if a mobile app is ever planned — "Grand Circuit" alone is likely too generic for App Store search, so the actual listing name would probably be **"Grand Circuit: Tennis Manager"** (descriptive suffix, matching how "TOP SEED" lists as "Tennis Manager 2026 - TOP SEED").

### Tagline options
- *"Every manager starts at love-all."*
- *"The circuit doesn't wait. Neither should your training plan."*
- *"Free forever. Fair, always."* — directly addresses the pay-to-win anxiety this genre has earned.

---

## 2. Brand identity

### Positioning statement
For manager-game fans who loved (or still play) abandoned browser tennis
sims, Grand Circuit is the actively-maintained, fair, browser-first
tennis manager RPG that respects both your time and your wallet —
unlike aging games that got abandoned, and unlike mobile competitors
built around in-app-purchase pressure.

### Voice & tone
- **Confident but not hype-y.** This audience is skeptical of "gacha
  energy" — speak like a product made by someone who actually plays
  the genre, not a growth-hacked mobile studio.
- **Transparent about fairness**, proactively, not just in a FAQ. The
  VIP/Pro tier's tradeoffs should be explained openly in marketing
  copy, not buried — "here's exactly what Pro gives you, and here's
  the cost that keeps it fair" is itself a trust-building message.
- **Nod to nostalgia without being a parody.** The audience remembers
  Rocking Rackets and similar games fondly; reference that shared
  history (in community channels, not paid ads) rather than pretending
  this is an entirely novel category.

### Visual direction (for whenever a designer or Claude Design session takes this further)
- Clean, data-forward, scoreboard-inspired — closer to a modern sports
  stats site than a cartoonish mobile game. This matches the "serious
  sim, not casual mobile game" positioning and differentiates visually
  from ReboundCG's more illustrated mobile style.
- Court-surface-inspired palette rather than a single "tennis green":
  clay terracotta, grass green, hard-court blue, indoor grey/purple as
  accent colors tied to surface affinity in the UI itself — this can
  double as a functional UI convention (surface-colored badges) and a
  distinctive palette, not just decoration.
- Typography: a clean geometric sans for UI/data density, avoiding
  anything that reads as either "AAA sports game" (overly aggressive,
  italicized) or "casual mobile" (rounded, bubbly).

---

## 3. Marketing plan (mapped onto the existing phased roadmap)

### Phase 0 — Validation
**Goal**: confirm demand before writing game code, per the business plan.
- **Direct community outreach** (highest priority, lowest cost): post
  in the Mens Tennis Forums thread where Rocking Rackets players still
  discuss the game, relevant subreddits (r/tennis, browser-game and
  sim-game communities), and any active Discord servers tied to
  Rocking Rackets or Online Tennis Manager. Frame it honestly: "I'm a
  longtime [game] player building a modern, actively-maintained
  successor — here's what I'm planning, what would you want kept/changed?"
  This does double duty as market validation *and* early-adopter
  recruitment.
- **Landing page + waitlist**: simple page explaining the pitch
  (fair monetization, active maintenance, browser-first), with an email
  capture. Use the "free forever, fair always" tagline as the headline
  test.
- **"Building in public" devlog**: a short devlog post or two (dev.to,
  a personal blog, or a Discord/X thread) walking through *why* the
  architecture avoids Football Manager's and Tribal Wars' complexity
  traps — this genre's core audience genuinely enjoys reading about
  design philosophy, and it's free, credibility-building content that
  costs only writing time.

### Phase 1 — MVP
**Goal**: prove the sim is fun and retention holds for a few weeks.
- Invite the Phase 0 waitlist/community contacts directly — a closed
  or semi-closed beta framed as "help shape this before public launch"
  performs well with this audience and produces word-of-mouth in the
  same forums used for validation.
- Start a devlog cadence (biweekly is plenty) documenting real
  progress — screenshots of the match replay UI, aging curve tuning,
  etc. — to keep the waitlist warm without needing paid spend.

### Phase 2 — Monetization
**Goal**: validate willingness to pay.
- Publish the Pro-tier pricing/perks page with the fairness tradeoff
  spelled out explicitly (see Voice & tone above) — this is content
  marketing in itself for this particular audience, who will
  screenshot and discuss a transparently-explained pricing model in
  the same communities that complained about Online Tennis Manager's
  pay-to-win reputation.

### Phase 3 — Social & retention
**Goal**: increase stickiness, justify server growth.
- Encourage organic story-sharing: since Football Manager's biggest
  free marketing channel is players sharing their own emergent
  stories, make sure end-of-season summaries and marquee-match replay
  pages are easily screenshot- and share-friendly (a clean, single-
  image "season recap" card is a cheap, high-leverage feature to build
  for this purpose).
- Guild/academy leaderboards double as a referral mechanic — a guild
  wants more active members to compete on leaderboards, which creates
  organic invite pressure without needing a formal referral program.

### Phase 4 — Scale
**Goal**: support a larger concurrent player base.
- Reassess whether ReboundCG's mobile app's audience (evidenced by its
  review count) represents a viable secondary acquisition channel —
  e.g. comparison content ("why we don't do IAP the way mobile tennis
  managers do") aimed at players who've expressed frustration with
  IAP pressure in that app's own reviews.
- Consider a light PWA/mobile wrapper at this stage if retention data
  justifies it, per the original software plan.

### Ongoing / channel-agnostic
- **SEO**: target long-tail, low-competition queries this audience
  actually searches — "rocking rackets alternative," "online tennis
  manager alternative," "free tennis manager game," "tennis manager
  game no pay to win." These are exactly the kind of low-volume,
  high-intent queries a small project can realistically rank for
  without a large content budget.
- **No paid ads at MVP stage.** The entire go-to-market thesis rests on
  a real, already-underserved community with organic reach through
  forums/Discord — spend effort there before considering paid
  acquisition, which this audience also tends to be skeptical of
  anyway.

---

## 4. Messaging pillars (use consistently across landing page, app store listing, community posts)
1. **"Actively maintained."** Directly addresses Rocking Rackets' and
   Online Tennis Manager's biggest weakness.
2. **"Fair, not pay-to-win."** Directly addresses Online Tennis
   Manager's and (implicitly) mobile IAP games' biggest trust problem.
3. **"Browser-first, no app-store gatekeeping."** Differentiates from
   ReboundCG's mobile-first approach for the PC/browser-manager-game
   purist audience specifically.
4. **"Built by a fan, for fans."** Authenticity angle — the origin
   story here (a longtime player building the successor they wanted)
   is genuinely a good hook for this specific community and costs
   nothing to communicate honestly.

## 5. Rough KPIs to track from Phase 0 onward
- Waitlist signups from community outreach vs. landing page organic traffic (tells you whether the "orphaned community" wedge is real).
- Beta retention: % of Phase 1 invitees still playing at week 2 and week 4 (the actual test of whether the sim is fun, independent of marketing).
- Pro-tier conversion rate at Phase 2, and — importantly — whether Pro subscribers' win rates are statistically different from free players' (a direct, measurable check that the fairness model is holding up in practice, not just in copy).
