import { RandomSource } from '../match-simulation/MatchSimulator';
import { Surface } from '../player/PlayerAttributes';
import { TournamentTier } from './CompetitionTypes';

function pick<T>(pool: readonly T[], random: RandomSource): T {
  const index = Math.min(pool.length - 1, Math.floor(random.next() * pool.length));
  return pool[index];
}

type TournamentPrestige = 'entry' | 'mid' | 'upper' | 'elite';

/** How "big" a tier reads for name-flavoring purposes only — a
 * separate scale from AgeBand/ranking-points, just grouping the 11
 * real TournamentTier values (4 senior + 7 junior) into four suffix
 * bands so a futures/J30 doesn't sound as grand as a major/juniorMasters. */
const TIER_PRESTIGE: Record<TournamentTier, TournamentPrestige> = {
  futures: 'entry',
  challenger: 'mid',
  tour: 'upper',
  major: 'elite',
  j30: 'entry',
  j60: 'entry',
  j100: 'mid',
  j200: 'mid',
  j300: 'upper',
  j500: 'upper',
  juniorMasters: 'elite',
};

/**
 * Real country names used as host-location flavor ONLY — explicitly
 * fine per this feature's design brief (mentioning a real country is
 * not the trademark concern; copying a real EVENT name is). The four
 * real Grand Slam host countries are deliberately excluded so no
 * template combination could ever land on something resembling
 * "Australian Open"/"US Open"/"French Open"/a Wimbledon-adjacent name:
 * Australia, France, the United Kingdom (and its constituent
 * countries), and the United States never appear in this pool. This
 * exclusion is the structural half of the "no resemblance to a real
 * tournament" guarantee; TournamentNameGenerator.test.ts checks actual
 * generated output against a curated blocklist of real tournament
 * names as the other half.
 */
const HOST_COUNTRIES = [
  'Brazil', 'Portugal', 'Spain', 'Germany', 'Italy', 'Argentina', 'Japan', 'Sweden', 'Czechia',
  'Canada', 'Serbia', 'Croatia', 'Poland', 'Austria', 'Switzerland', 'Netherlands', 'Belgium',
  'Chile', 'Mexico', 'Morocco', 'Egypt', 'South Korea', 'Thailand', 'Indonesia', 'Kenya',
  'Norway', 'Finland', 'Denmark', 'Greece', 'Romania', 'Hungary', 'Slovakia', 'Slovenia',
  'Bulgaria', 'Ireland', 'New Zealand', 'South Africa', 'India', 'China', 'Uruguay',
  'Colombia', 'Peru', 'Turkey', 'Israel', 'United Arab Emirates', 'Qatar', 'Vietnam',
] as const;

/** Wholly invented sponsor-style words — never a real brand, never a
 * real place name — purely for variety/flavor in the generated name. */
const SPONSOR_WORDS = [
  'Meridian', 'Solstice', 'Cobalt', 'Zenith', 'Halcyon', 'Vanguard', 'Lumen', 'Ember',
  'Crest', 'Aurora', 'Tidewave', 'Granite', 'Onyx', 'Sable', 'Marlowe', 'Vesper',
  'Cascade', 'Falcon', 'Silverline', 'Northstar', 'Amberlight', 'Wrenfield',
] as const;

const SURFACE_WORDS: Record<Surface, string> = {
  clay: 'Clay',
  grass: 'Lawn',
  hard: 'Hardcourt',
  indoor: 'Indoor',
};

/** Deliberately avoids "Masters"/"Grand Prix" and anything else with
 * strong real-tournament trademark adjacency, even at the 'elite' band
 * — see this file's class doc comment. */
const SUFFIXES_BY_PRESTIGE: Record<TournamentPrestige, readonly string[]> = {
  entry: ['Open', 'Cup', 'Classic', 'Trophy'],
  mid: ['International', 'Invitational', 'Championship', 'Cup'],
  upper: ['Championship', 'International Cup', 'Elite Cup', 'Classic'],
  elite: ['Championship', 'International Championship', 'Grand Championship', 'Elite Trophy'],
};

interface NameParts {
  country: string;
  sponsor: string;
  surface: string;
  suffix: string;
}

/** Several different shapes so the same word pools don't always
 * combine the same way — picked per-generation, not fixed. */
const TEMPLATES: ReadonlyArray<(parts: NameParts) => string> = [
  (p) => `${p.country} ${p.suffix}`,
  (p) => `${p.sponsor} ${p.country} ${p.suffix}`,
  (p) => `${p.sponsor} ${p.surface} ${p.suffix}`,
  (p) => `${p.country} ${p.surface} ${p.suffix}`,
  (p) => `${p.sponsor} ${p.suffix}`,
];

/**
 * Generates a fully original tournament display name, flavored by tier
 * prestige/surface/host country, with no resemblance to any real
 * ATP/WTA/ITF tournament name. Pure/stateless domain service — same
 * shape as BracketGenerator/PlayerGenerationPolicy: no constructor
 * state, RandomSource injected per call so it's fully deterministic
 * and testable.
 *
 * This is the ONLY place tournament names are produced. Both
 * OpenTournamentUseCase and OpenRegistrationUseCase — the only two
 * call sites that ever construct a Tournament — call this internally
 * rather than accepting a name from their caller, so no caller
 * (admin route, seed script, or otherwise) can ever hand-type or omit
 * a name: see Tournament.open()'s own non-empty-name guard for the
 * other half of that structural guarantee.
 */
export class TournamentNameGenerator {
  generate(random: RandomSource, tier: TournamentTier, surface: Surface): string {
    const parts: NameParts = {
      country: pick(HOST_COUNTRIES, random),
      sponsor: pick(SPONSOR_WORDS, random),
      surface: SURFACE_WORDS[surface],
      suffix: pick(SUFFIXES_BY_PRESTIGE[TIER_PRESTIGE[tier]], random),
    };
    return pick(TEMPLATES, random)(parts);
  }
}
