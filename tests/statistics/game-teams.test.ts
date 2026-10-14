import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { emptyPlayerStatLine, emptyTeamStatLine } from '@/statistics/empty';
import { lineTeamId, prunePlayerTeams, stampPlayerTeams } from '@/statistics/game-teams';
import type { GameStats } from '@/statistics/types';

const P = (s: string): PlayerId => s as PlayerId;
const T = (s: string): TeamId => s as TeamId;

const stats = (ids: string[], playerTeams?: Record<string, string>): GameStats => ({
  players: Object.fromEntries(ids.map((id) => [id, emptyPlayerStatLine()])) as GameStats['players'],
  teams: { home: emptyTeamStatLine(), away: emptyTeamStatLine() },
  ...(playerTeams ? { playerTeams: playerTeams as GameStats['playerTeams'] } : {}),
});

describe('game line teams', () => {
  it('stamps each line with the roster it dressed for, keeping recorded entries and leaving unknowns unmapped', () => {
    const s = stats(['a', 'b', 'c', 'x'], { c: 't_old' });
    const out = stampPlayerTeams(s, [{ teamId: T('t_home'), playerIds: [P('a'), P('c')] }, { teamId: T('t_away'), playerIds: [P('b')] }]);
    expect(out.playerTeams).toEqual({ a: 't_home', b: 't_away', c: 't_old' });
    expect(s.playerTeams).toEqual({ c: 't_old' });
    expect(out.players).toBe(s.players);
  });

  it('prunes to kept lines and falls back for box scores stored without teams', () => {
    const s = stats(['a', 'b'], { a: 't1', b: 't2' });
    expect(prunePlayerTeams(s, [P('b')])).toEqual({ b: 't2' });
    expect(prunePlayerTeams(stats(['a']), [P('a')])).toBeUndefined();
    expect(lineTeamId(s, P('a'), () => T('t_now'))).toBe('t1');
    expect(lineTeamId(stats(['a']), P('a'), () => T('t_now'))).toBe('t_now');
    expect(lineTeamId(s, P('zz'), () => null)).toBeNull();
  });
});
