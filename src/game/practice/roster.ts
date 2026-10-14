/**
 * Fixed practice roster: two deterministic squads, the user's GOLD team and the SCOUT team across from it.
 * Players are generated with players/generator.generatePlayer, one independent rng per (squad, quality,
 * position, depth index), so the same athlete lines up at the same spot every rep and in every drill. Squads are
 * cached per quality; lineups fill a formation's slots from the squad's depth at each position.
 */
import { createRng } from '@/core/rng';
import type { PlayerQuality } from '@/players/generator';
import { generatePlayer } from '@/players/generator';
import { createNamePool, type NamePool } from '@/players/names';
import type { Player, Position } from '@/players/types';
import type { FormationSlot } from '@/playbook/types';
import type { TeamColors } from '@/teams/types';

/** Root seed of the practice roster; changing it changes every practice athlete. */
export const PRACTICE_ROSTER_SEED = 0x60_1d;
/** League year stamped on generated practice players. */
export const PRACTICE_YEAR = 2026;

/** The two practice squads: the user's GOLD team and the SCOUT team. */
export type SquadId = 'gold' | 'scout';

/** Display identity of a squad (name, abbreviation, colours). */
export interface SquadIdentity {
  id: SquadId;
  name: string;
  abbr: string;
  colors: TeamColors;
}

/** Display identities of the two practice squads (original colour schemes). */
export const SQUADS: Readonly<Record<SquadId, SquadIdentity>> = Object.freeze({
  gold: { id: 'gold', name: 'Gold Team', abbr: 'GLD', colors: { primary: '#d9a21b', secondary: '#1d1f2b', accent: '#fff4d2', helmet: '#d9a21b' } },
  scout: { id: 'scout', name: 'Scout Team', abbr: 'SCT', colors: { primary: '#3f78b5', secondary: '#f2f2ee', accent: '#9fc6ee', helmet: '#e8e8e2' } },
});

/** A squad at one quality: its identity and a deterministic player per (position, depth). */
export interface PracticeSquad {
  identity: SquadIdentity;
  quality: PlayerQuality;
  /** Depth-ordered players generated so far per position (grows on demand). */
  player(position: Position, depth: number): Player;
}

let names: NamePool | null = null;
const namePool = (): NamePool => {
  if (!names) names = createNamePool();
  return names;
};

const cache = new Map<string, PracticeSquad>();

/** The squad for an id and quality (cached; deterministic). */
export const practiceSquad = (id: SquadId, quality: PlayerQuality): PracticeSquad => {
  const key = `${id}:${quality}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const byPosition = new Map<string, Player>();
  const squad: PracticeSquad = {
    identity: SQUADS[id],
    quality,
    player: (position, depth) => {
      const slot = `${position}:${depth}`;
      const existing = byPosition.get(slot);
      if (existing) return existing;
      // A fresh rng per athlete (string seed), so generation order never changes who lines up where.
      const rng = createRng(`practice:${PRACTICE_ROSTER_SEED}:${key}:${slot}`);
      const p = generatePlayer(rng, { position, quality, names: namePool(), regions: ['northeast'], year: PRACTICE_YEAR });
      byPosition.set(slot, p);
      return p;
    },
  };
  cache.set(key, squad);
  return squad;
};

/**
 * Lineup for a formation: role -> player, each slot taking the next unused depth at its position (two WR slots
 * get WR #0 and WR #1). Deterministic for a squad and slot order.
 */
export const lineupFor = (squad: PracticeSquad, slots: readonly Pick<FormationSlot, 'role' | 'position'>[]): Record<string, Player> => {
  const used = new Map<string, number>();
  const out: Record<string, Player> = {};
  for (const s of slots) {
    const depth = used.get(s.position) ?? 0;
    used.set(s.position, depth + 1);
    out[s.role] = squad.player(s.position, depth);
  }
  return out;
};
