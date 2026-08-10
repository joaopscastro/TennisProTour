import { Player } from '@tennis-manager/domain';

/** Thin serialization only — no domain rules here. Shared by
 * playerRoutes.ts and talentPoolRoutes.ts (claiming a candidate and
 * creating a custom player both ultimately hand back a Player). */
export function toPlayerDto(player: Player) {
  const { technical, physical, mental, surfaceAffinities } = player.attributes;
  return {
    id: player.id,
    name: player.name,
    nationality: player.nationality,
    managerId: player.managerId,
    ageInWeeks: player.ageInWeeks,
    stage: player.stage,
    fatigue: player.fatigue,
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
      surfaceAffinities: {
        clay: surfaceAffinities.get('clay'),
        grass: surfaceAffinities.get('grass'),
        hard: surfaceAffinities.get('hard'),
        indoor: surfaceAffinities.get('indoor'),
      },
    },
  };
}
