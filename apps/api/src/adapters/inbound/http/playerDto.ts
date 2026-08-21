import { Player } from '@tennis-manager/domain';

/** Thin serialization only — no domain rules here. Shared by
 * playerRoutes.ts and talentPoolRoutes.ts (claiming a candidate and
 * creating a custom player both ultimately hand back a Player). */
export function toPlayerDto(player: Player) {
  const { technical, physical, mental, doubles, surfaceAffinities } = player.attributes;
  return {
    id: player.id,
    name: player.name,
    nationality: player.nationality,
    managerId: player.managerId,
    ageInWeeks: player.ageInWeeks,
    stage: player.stage,
    fatigue: player.fatigue,
    form: player.form,
    /** True for a permanent, manager-less free agent generated purely to
     * pad under-filled draws (auto-trains its own weakest attribute —
     * see Player.ts) — distinct from a released former manager's player
     * (managerId also null, but fillOnly stays false). Exposed so the
     * bracket UI can visually distinguish a filler from a real entrant
     * instead of rendering them identically. */
    fillOnly: player.fillOnly,
    /** Cumulative on-site prize money earned across this player's whole
     * career — observable, unlike talent/experience, so it's exposed
     * here directly (see Player.careerPrizeMoney's doc comment). */
    careerPrizeMoney: player.careerPrizeMoney,
    /** Prize money earned so far in the current season only — resets
     * to 0 at every season rollover (see Player.seasonPrizeMoney). */
    seasonPrizeMoney: player.seasonPrizeMoney,
    attributes: {
      technical: {
        serve: technical.serve.value,
        forehand: technical.forehand.value,
        backhand: technical.backhand.value,
        volley: technical.volley.value,
      },
      physical: {
        speed: physical.speed.value,
        stamina: physical.stamina.value,
        strength: physical.strength.value,
      },
      mental: {
        consistency: mental.consistency.value,
        clutch: mental.clutch.value,
      },
      doubles: doubles.value,
      surfaceAffinities: {
        clay: surfaceAffinities.get('clay'),
        grass: surfaceAffinities.get('grass'),
        hard: surfaceAffinities.get('hard'),
        indoor: surfaceAffinities.get('indoor'),
      },
    },
  };
}
