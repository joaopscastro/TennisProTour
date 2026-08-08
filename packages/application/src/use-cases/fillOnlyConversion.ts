import { AgingPolicy, Player, PlayerId, TalentPoolCandidate } from '@tennis-manager/domain';

/**
 * Converts a `TalentPoolCandidate` into a real, permanent, fill-only
 * `Player` — the exact mapping used both when a candidate ages out of
 * the active Scouting list (`RefreshTalentPoolUseCase`) and when one is
 * consumed to fill an under-registered tournament slot
 * (`StartDueTournamentsUseCase`). Factored out rather than duplicated
 * so the two call sites can never drift on which fields carry over.
 *
 * Reuses the candidate's own id as the new player's id — same "this IS
 * that player from here on" convention `ClaimTalentPoolCandidateUseCase`
 * already uses for an actual claim. The caller is responsible for
 * marking the source candidate no-longer-available (`markExpired()`)
 * and saving both — this function only builds the `Player`, it doesn't
 * touch any repository.
 */
export function convertToFillOnlyPlayer(candidate: TalentPoolCandidate, agingPolicy: AgingPolicy): Player {
  const stage = agingPolicy.stageForAge(candidate.ageInWeeks);
  return Player.generateFillOnly(
    PlayerId(candidate.id),
    candidate.name,
    candidate.ageInWeeks,
    stage,
    candidate.attributes,
    candidate.nationality,
    candidate.potentialCeiling,
    candidate.physicalCeilings,
  );
}
