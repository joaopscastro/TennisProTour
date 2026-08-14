import { GameWeek, PairId, PlayerId, TournamentId } from '../shared/ids';
import { Surface } from '../player/PlayerAttributes';
import { MatchOutcome } from './CompetitionTypes';
import { GroupStageGenerator } from './GroupStageGenerator';

export interface WorldTeamCupTeam {
  country: string;
  /** Exactly two players in v1 — both play singles and form the doubles
   * pair (the "can be the same two players" case). Four-player teams with
   * a dedicated doubles specialist are a future refinement. */
  players: [PlayerId, PlayerId];
}

export type WorldTeamCupRubber =
  | { kind: 'singles'; playerA: PlayerId; playerB: PlayerId; outcome: MatchOutcome<PlayerId> | null }
  | { kind: 'doubles'; pairA: PairId; pairB: PairId; outcome: MatchOutcome<PairId> | null };

export interface WorldTeamCupTie {
  teamA: string;
  teamB: string;
  /** Exactly three rubbers: singles 1, singles 2, then doubles — the
   * doubles is played only if the first two split 1-1. First team to two
   * rubbers wins. */
  rubbers: [WorldTeamCupRubber, WorldTeamCupRubber, WorldTeamCupRubber];
  winner: string | null;
}

export interface WorldTeamCupGroup {
  teams: string[];
  ties: WorldTeamCupTie[];
}

export interface WorldTeamCupOpenProps {
  id: TournamentId;
  season: number;
  weekScheduled: GameWeek;
  surface: Surface;
  teams: WorldTeamCupTeam[];
}

/**
 * The World Team Cup (P8c) — a Davis-Cup-style national team event. Two
 * round-robin groups of four countries feed a knockout (semifinals +
 * final); every pairing is a TIE of three rubbers (2 singles + 1 doubles,
 * first to two). Group seeding reuses GroupStageGenerator; a tie's rubbers
 * reuse the ordinary match simulator downstream (a doubles rubber is a
 * composite pair, exactly like the doubles draw).
 */
export class WorldTeamCup {
  private _groups: WorldTeamCupGroup[] = [];
  private knockoutRounds: WorldTeamCupTie[][] = [];

  private constructor(
    readonly id: TournamentId,
    readonly season: number,
    readonly weekScheduled: GameWeek,
    readonly surface: Surface,
    readonly teams: ReadonlyArray<WorldTeamCupTeam>,
  ) {
    const stage = new GroupStageGenerator().generate(
      teams.map((t, i) => ({ playerId: t.country as unknown as PlayerId, seed: i + 1 })),
      4,
    );
    this._groups = stage.groups.map((g) => ({
      teams: [...g.entrants] as unknown as string[],
      ties: g.matches.map((m) => this.makeTie(m.entrantA as unknown as string, m.entrantB as unknown as string)),
    }));
  }

  static open(props: WorldTeamCupOpenProps): WorldTeamCup {
    return new WorldTeamCup(props.id, props.season, props.weekScheduled, props.surface, props.teams);
  }

  static reconstitute(
    props: WorldTeamCupOpenProps & { groups: WorldTeamCupGroup[]; knockoutRounds?: WorldTeamCupTie[][] },
  ): WorldTeamCup {
    const cup = new WorldTeamCup(props.id, props.season, props.weekScheduled, props.surface, props.teams);
    cup._groups = [...props.groups];
    cup.knockoutRounds = [...(props.knockoutRounds ?? [])];
    return cup;
  }

  private makeTie(teamA: string, teamB: string): WorldTeamCupTie {
    const a = this.teams.find((t) => t.country === teamA)!;
    const b = this.teams.find((t) => t.country === teamB)!;
    return {
      teamA,
      teamB,
      rubbers: [
        { kind: 'singles', playerA: a.players[0], playerB: b.players[0], outcome: null },
        { kind: 'singles', playerA: a.players[1], playerB: b.players[1], outcome: null },
        { kind: 'doubles', pairA: PairId(`${teamA}-d`), pairB: PairId(`${teamB}-d`), outcome: null },
      ],
      winner: null,
    };
  }

  get groups(): ReadonlyArray<WorldTeamCupGroup> {
    return this._groups;
  }

  get knockout(): ReadonlyArray<ReadonlyArray<WorldTeamCupTie>> {
    return this.knockoutRounds;
  }

  get hasKnockout(): boolean {
    return this.knockoutRounds.length > 0;
  }

  team(country: string): WorldTeamCupTeam | null {
    return this.teams.find((t) => t.country === country) ?? null;
  }

  /** The two players behind a doubles pair id (which is `<country>-d`). */
  doublesPlayersFor(pairId: PairId): PlayerId[] {
    const team = this.team(pairId.replace(/-d$/, ''));
    return team ? [...team.players] : [];
  }

  private sideKey(rubber: WorldTeamCupRubber, side: 'a' | 'b'): string {
    if (rubber.kind === 'singles') return side === 'a' ? rubber.playerA : rubber.playerB;
    return side === 'a' ? rubber.pairA : rubber.pairB;
  }

  /** Whether TEAM A (the `teamA` field) won this rubber — the rubber's
   * side 'a' is always teamA's side by construction (makeTie). */
  private rubberWonByTeamA(tie: WorldTeamCupTie, rubber: WorldTeamCupRubber): boolean {
    void tie;
    return rubber.outcome !== null && rubber.outcome.winner === this.sideKey(rubber, 'a');
  }

  /** The next rubber that is due, or null if the tie is decided. The
   * doubles rubber (index 2) is only due once the singles split 1-1. */
  nextDueRubberIndex(tie: WorldTeamCupTie): number | null {
    if (tie.winner) return null;
    const singlesWonA = tie.rubbers.slice(0, 2).filter((r) => this.rubberWonByTeamA(tie, r)).length;
    const index = tie.rubbers.findIndex((r) => r.outcome === null);
    if (index === -1) return null;
    if (index === 2 && singlesWonA !== 1) return null;
    return index;
  }

  /** Records a rubber's outcome and, when it makes the tie 2-0 or 2-1,
   * stamps the tie winner. */
  recordRubberOutcome(tie: WorldTeamCupTie, rubberIndex: number, outcome: MatchOutcome<string>): void {
    const rubber = tie.rubbers[rubberIndex];
    if (rubber.outcome) throw new Error(`Tie rubber ${rubberIndex} already has an outcome`);
    if (outcome.winner !== this.sideKey(rubber, 'a') && outcome.winner !== this.sideKey(rubber, 'b')) {
      throw new Error('Rubber winner must be one of the two sides');
    }
    rubber.outcome = { ...outcome } as WorldTeamCupRubber['outcome'];

    const wonA = tie.rubbers.filter((r) => this.rubberWonByTeamA(tie, r)).length;
    const wonB = tie.rubbers.filter((r) => r.outcome !== null && !this.rubberWonByTeamA(tie, r)).length;
    if (wonA >= 2) tie.winner = tie.teamA;
    else if (wonB >= 2) tie.winner = tie.teamB;
  }

  // ---- group standings + advancement ----

  groupTiesWon(group: WorldTeamCupGroup): Map<string, number> {
    const wins = new Map<string, number>();
    for (const team of group.teams) wins.set(team, 0);
    for (const tie of group.ties) {
      if (tie.winner) wins.set(tie.winner, (wins.get(tie.winner) ?? 0) + 1);
    }
    return wins;
  }

  groupStandings(group: WorldTeamCupGroup): string[] {
    // Full round-robin tiebreak chain, mirroring GroupStage.groupStandings:
    // ties won first, then head-to-head between two tied countries (whoever
    // won their direct tie ranks higher), then rubbers won, then sets won,
    // then games won. Before this existed the sort stopped at ties won, so a
    // 3-way 2-1 tie was broken by arbitrary (snake-seed) order — the two
    // highest seeds advanced even if the eliminated team had beaten both
    // head-to-head.
    interface Row {
      country: string;
      tiesWon: number;
      rubbersWon: number;
      setsWon: number;
      gamesWon: number;
    }
    const rows = new Map<string, Row>();
    for (const team of group.teams) rows.set(team, { country: team, tiesWon: 0, rubbersWon: 0, setsWon: 0, gamesWon: 0 });

    for (const tie of group.ties) {
      for (const rubber of tie.rubbers) {
        if (!rubber.outcome) continue;
        const winnerCountry = this.rubberWinnerCountry(tie, rubber);
        const loserCountry = winnerCountry === tie.teamA ? tie.teamB : tie.teamA;
        const w = rows.get(winnerCountry);
        const l = rows.get(loserCountry);
        if (!w || !l) continue;
        w.rubbersWon += 1;
        for (const set of rubber.outcome.setScores) {
          if (set.winnerGames > set.loserGames) w.setsWon += 1;
          else l.setsWon += 1;
          w.gamesWon += set.winnerGames;
          l.gamesWon += set.loserGames;
        }
      }
      if (tie.winner) {
        const w = rows.get(tie.winner);
        if (w) w.tiesWon += 1;
      }
    }

    return [...rows.values()]
      .sort((a, b) => {
        if (b.tiesWon !== a.tiesWon) return b.tiesWon - a.tiesWon;
        const headToHead = this.headToHeadCountry(group, a.country, b.country);
        if (headToHead === a.country) return -1;
        if (headToHead === b.country) return 1;
        if (b.rubbersWon !== a.rubbersWon) return b.rubbersWon - a.rubbersWon;
        if (b.setsWon !== a.setsWon) return b.setsWon - a.setsWon;
        return b.gamesWon - a.gamesWon;
      })
      .map((r) => r.country);
  }

  /** Which country a decided rubber was won by — the rubber's side 'a' is
   * always teamA's side by construction (makeTie), so the winner player/pair
   * id resolving to side 'a' means teamA won. */
  private rubberWinnerCountry(tie: WorldTeamCupTie, rubber: WorldTeamCupRubber): string {
    return rubber.outcome!.winner === this.sideKey(rubber, 'a') ? tie.teamA : tie.teamB;
  }

  private headToHeadCountry(group: WorldTeamCupGroup, a: string, b: string): string | null {
    const tie = group.ties.find(
      (t) => (t.teamA === a && t.teamB === b) || (t.teamA === b && t.teamB === a),
    );
    return tie?.winner ?? null;
  }

  get allGroupStagesComplete(): boolean {
    return this._groups.every((g) => g.ties.every((t) => t.winner !== null));
  }

  /** Top 2 per group, in bracket order (g1 winner, g2 runner-up, g2
   * winner, g1 runner-up). */
  semifinalists(): string[] {
    if (!this.allGroupStagesComplete) return [];
    const g1 = this.groupStandings(this._groups[0]);
    const g2 = this.groupStandings(this._groups[1]);
    return [g1[0], g2[1], g2[0], g1[1]];
  }

  seedKnockout(): void {
    if (this.hasKnockout) return;
    if (!this.allGroupStagesComplete) throw new Error('Cannot seed the World Team Cup knockout before all group ties finish');
    const semis = this.semifinalists();
    this.knockoutRounds = [[this.makeTie(semis[0], semis[1]), this.makeTie(semis[2], semis[3])]];
  }

  /** Once both semifinal ties are decided, seeds the final. */
  advanceKnockout(): void {
    if (this.knockoutRounds.length === 0) return;
    const semis = this.knockoutRounds[0];
    if (semis.some((t) => t.winner === null)) return;
    if (this.knockoutRounds.length >= 2) return;
    this.knockoutRounds.push([this.makeTie(semis[0].winner!, semis[1].winner!)]);
  }

  get champion(): string | null {
    if (this.knockoutRounds.length < 2) return null;
    return this.knockoutRounds[1][0].winner;
  }

  get complete(): boolean {
    return this.champion !== null;
  }
}
