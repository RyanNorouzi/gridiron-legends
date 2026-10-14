import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import type { LeagueRecord } from '@/franchise/types';
import type { WeekEvent } from '@/franchise/week';
import { buildRecap } from '@/ui/franchise/shell/recap-model';
import type { SimJobResult } from '@/ui/franchise/shell/sim-job';
import { leagueAt, userOf } from './helpers';

const league = leagueAt(101, 'preseason');
const user = userOf(league);
const other = Object.keys(league.teams).find((id) => id !== user) as TeamId;
const mine = league.teams[user]!.rosterIds[0] as PlayerId;
const theirs = league.teams[other]!.rosterIds[0] as PlayerId;
const game = league.season.schedule.find((g) => !g.isPreseason && !g.isPlayoff && g.week === 8)!;

const recapOf = (events: WeekEvent[]) => {
  const r: SimJobResult = { league, weeks: [{ league, events, franchiseEvents: [], brokenRecords: [], games: [game] }], phases: [], blockedBy: [], error: null, cancelled: false };
  return buildRecap(league, r, user).headlines;
};
const injury = (playerId: PlayerId, teamId: TeamId, weeksOut: number, severity: 'minor' | 'seasonEnding' | 'careerThreatening' = 'minor'): WeekEvent =>
  ({ type: 'injury', playerId, teamId, severity, weeksOut, gameId: game.id });

describe('recap headlines', () => {
  it('words injuries by outlook: day-to-day knocks, week counts, out for the season, career-threatening', () => {
    const lines = recapOf([injury(mine, user, 0), injury(mine, user, 3), injury(mine, user, 38, 'seasonEnding'), injury(mine, user, 30, 'careerThreatening'), injury(theirs, other, 38, 'seasonEnding')]);
    const texts = lines.map((l) => l.text);
    expect(texts[0]).toMatch(/shaken up, day-to-day$/);
    expect(lines[0]!.tone).toBe('normal');
    expect(texts[1]).toMatch(/injured, out 3 wks$/);
    expect(texts[2]).toMatch(/injured, out for the season$/);
    expect(texts[3]).toMatch(/career-threatening injury$/);
    expect(texts[4]).toMatch(/^[A-Z]+: .* injured, out for the season$/);
    expect(texts.some((t) => /out 0 wk|out 38 wks/.test(t))).toBe(false);
  });

  it('headlines only records that are news', () => {
    const record: LeagueRecord = { key: 'passingYards.season', label: 'Passing Yards (Season)', scope: 'season', value: 663, holderPlayerId: mine, holderTeamId: user, holderName: 'Some Passer', year: league.season.year };
    const lines = recapOf([
      { type: 'record', record, previous: null, headline: false },
      { type: 'record', record: { ...record, key: 'passingTds.season', label: 'Passing Touchdowns (Season)', value: 51 }, previous: null, headline: true },
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Record: Passing Touchdowns (Season) - Some Passer (51)']);
  });
});
