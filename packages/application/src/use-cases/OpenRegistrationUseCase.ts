import { GameWeek, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { AgeBand, DrawSize, TournamentTier } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';
import { RandomSource, TournamentNameGenerator } from '@tennis-manager/domain';
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
    });

    await this.tournaments.save(tournament);
  }
}
