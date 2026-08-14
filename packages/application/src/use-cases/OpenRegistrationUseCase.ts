import { GameWeek, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { AgeBand, DrawSize, TournamentTier } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';
import { RandomSource, TournamentNameGenerator } from '@tennis-manager/domain';
import { qualifierSlotsFor, qualifyingDrawSizeFor, doublesDrawSizeFor, doublesQualifierSlotsFor, doublesQualifyingDrawSizeFor } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';

export interface OpenRegistrationCommand {
  tournamentId: TournamentId;
  tier: TournamentTier;
  surface: Surface;
  weekScheduled: GameWeek;
  drawSize: DrawSize;
  /** Required for junior tiers, forbidden for senior tiers — see
   * Tournament.open()'s validation. */
  ageBand?: AgeBand | null;
  // Deliberately NO `name` field here — see this class's doc comment.
}

/**
 * Opens a tournament for registration with no entrants yet, and does
 * NOT start it — the genuine counterpart to a roster row's "Enter"
 * action, which needs a tournament that's still accepting entrants
 * one manager at a time via RegisterEntrantUseCase. OpenTournamentUseCase
 * is a different, narrower operation despite the similar name: it
 * opens AND registers a fixed entrant list AND starts the bracket in
 * one call, which is the right shape for admin-seeded draws (see its
 * own doc comment and seed.ts) but structurally can't represent "open
 * for entrants trickling in over time," since it always starts
 * immediately. Without this use case there was no way for an open,
 * not-yet-started tournament to ever exist — RegisterEntrantUseCase
 * would have nothing to register into.
 *
 * There's still no registration window/deadline concept (per
 * CLAUDE.md's "nothing drives one asynchronously yet") — this
 * tournament simply stays open until RegisterEntrantUseCase fills the
 * draw, at which point it auto-starts (see RegisterEntrantUseCase).
 *
 * At a tier that holds qualifying, the tournament is opened with a real
 * qualifying field alongside its main draw (see QualifyingPolicy): part
 * of the main draw's places are reserved for whoever survives it, and
 * below-cutoff registrants enter the qualifying field instead of the
 * main one. This is the only place those two numbers are decided.
 *
 * The tournament's display name is ALWAYS generated internally via
 * TournamentNameGenerator, never accepted from the caller — see
 * OpenTournamentUseCase's doc comment for why this (together with
 * that class doing the same) is a structural guarantee, not a
 * convention: these are the only two places a Tournament is ever
 * constructed anywhere in the codebase.
 */
export class OpenRegistrationUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly nameGenerator: TournamentNameGenerator,
    private readonly random: RandomSource,
  ) {}

  async execute(command: OpenRegistrationCommand): Promise<void> {
    const generated = this.nameGenerator.generate(this.random, command.tier, command.surface);
    const tournament = Tournament.open({
      id: command.tournamentId,
      name: generated.name,
      hostCountry: generated.hostCountry,
      tier: command.tier,
      surface: command.surface,
      weekScheduled: command.weekScheduled,
      drawSize: command.drawSize,
      ageBand: command.ageBand,
      // Qualifying (docs/ranking-realism-proposal.md §5). Derived ONCE,
      // here, from the tier/draw size and then stored on the aggregate
      // — see TournamentOpenProps.qualifyingDrawSize for why it isn't
      // re-derived per read. Both are 0 at every tier that holds no
      // qualifying (futures, every junior grade), which is exactly the
      // pre-qualifying behaviour.
      qualifyingDrawSize: qualifyingDrawSizeFor(command.tier, command.drawSize),
      qualifierSlots: qualifierSlotsFor(command.tier, command.drawSize),
      // Doubles (P7b + junior doubles) — derived once, stored, like
      // qualifying. Every tier holds a doubles draw.
      doublesDrawSize: doublesDrawSizeFor(command.tier, command.drawSize),
      // Doubles qualifying (P8) — derived once from the doubles draw
      // size, stored. 0 when the doubles draw is too small to hold one.
      doublesQualifyingDrawSize: doublesQualifyingDrawSizeFor(doublesDrawSizeFor(command.tier, command.drawSize)),
      doublesQualifierSlots: doublesQualifierSlotsFor(doublesDrawSizeFor(command.tier, command.drawSize)),
    });

    await this.tournaments.save(tournament);
  }
}
