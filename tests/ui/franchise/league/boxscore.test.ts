import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { assignPlayer } from '@/franchise/roster';
import type { League, ScheduledGame } from '@/franchise/types';
import { buildBoxScore, sideOf } from '@/ui/franchise/league/boxscore-model';
import { midSeasonLeague } from './helpers';

/** A played game with a home player who has a line. */
const pick = (league: League): { g: ScheduledGame; id: PlayerId } => {
  for (const g of league.season.schedule) {
    const r = g.result;
    if (!r || g.isPreseason) continue;
    const id = (Object.keys(r.stats.players) as PlayerId[]).find((p) => league.players[p]?.teamId === g.home && r.stats.playerTeams?.[p] === g.home);
    if (id) return { g, id };
  }
  throw new Error('no played game');
};

describe('box score team credit', () => {
  it('stores the side every line was recorded for and keeps crediting it after the player moves', () => {
    const league = midSeasonLeague();
    const { g, id } = pick(league);
    const r = g.result!;
    // Every stored line carries the team it was recorded for, and that team played in the game.
    for (const pid of Object.keys(r.stats.players)) expect([g.home, g.away]).toContain(r.stats.playerTeams?.[pid as PlayerId]);
    const before = buildBoxScore(league, g.id)!;
    const row = (v: typeof before) => Object.values(v.players).flat().find((x) => x.id === id);
    expect(row(before)?.side).toBe('home');
    // Trade him to the opponent: the old box score still credits the home team.
    const moved = assignPlayer(league, id, g.away);
    expect(moved.players[id]?.teamId).toBe(g.away);
    expect(sideOf(moved, g, id)).toBe('home');
    expect(row(buildBoxScore(moved, g.id)!)?.team).toBe(before.home.abbr);
  });

  it('falls back to his current team for box scores stored before line teams existed', () => {
    const league = midSeasonLeague();
    const { g, id } = pick(league);
    const { playerTeams: _dropped, ...legacyStats } = g.result!.stats;
    const legacyGame: ScheduledGame = { ...g, result: { ...g.result!, stats: legacyStats } };
    const legacy: League = { ...league, season: { ...league.season, schedule: league.season.schedule.map((x) => (x.id === g.id ? legacyGame : x)) } };
    expect(sideOf(legacy, legacyGame, id)).toBe('home');
    const moved = assignPlayer(legacy, id, g.away as TeamId);
    expect(sideOf(moved, legacyGame, id)).toBe('away');
  });
});
