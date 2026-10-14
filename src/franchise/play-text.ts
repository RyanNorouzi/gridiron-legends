/**
 * Compact play-by-play for games whose full log is not kept (AI-vs-AI regular-season and preseason games): one
 * small record per snap (quarter, clock, possession, down & distance, spot, a one-line description with the
 * players' names, the score after and a tone), so every game in the league has a readable play history at a
 * fraction of the size of League.playLogs. Pure; the box score reads these when no full log exists.
 */
import type { PlayerId } from '@/core/ids';
import type { PlayOutcome } from '@/game/play-types';
import type { GameSetup, PlayLogEntry } from '@/game/types';
import { shortName } from '@/players/types';
import type { CompactPlay } from './types';

export type { CompactPlay } from './types';

const yds = (n: number): string => {
  const v = Math.round(n);
  return v === 0 ? 'no gain' : v < 0 ? `loss of ${-v}` : `${v} yd${v === 1 ? '' : 's'}`;
};

const KICK_WORDS: Readonly<Partial<Record<PlayOutcome['result'], string>>> = {
  kickoff: 'Kickoff', onside: 'Onside kick', punt: 'Punt', fieldGoal: 'Field goal', extraPoint: 'Extra point',
};

/** One-line description of an applied outcome ("J. Doe pass to R. Roe, 12 yds, TD"). */
export const describeOutcome = (o: PlayOutcome, name: (id: PlayerId | null) => string | null): string => {
  const passer = name(o.passerId);
  const receiver = name(o.receiverId);
  const carrier = name(o.ballCarrierId);
  const flag = o.penalties.find((p) => p.accepted);
  let text: string;
  switch (o.result) {
    case 'penalty': text = flag ? `Penalty: ${flag.foul.replace(/([A-Z])/g, ' $1').toLowerCase()} on the ${flag.side}, ${Math.round(Math.abs(flag.yards))} yds` : 'No play'; break;
    case 'pass': text = `${passer ?? 'Pass'} to ${receiver ?? 'receiver'}, ${yds(o.yards)}`; break;
    case 'incomplete': text = `${passer ?? 'Pass'} incomplete${receiver ? ` to ${receiver}` : ''}`; break;
    case 'interception': text = `${passer ?? 'Pass'} intercepted`; break;
    case 'sack': text = `${passer ?? 'QB'} sacked, ${yds(o.yards)}`; break;
    case 'run': text = `${carrier ?? 'Run'} run, ${yds(o.yards)}`; break;
    case 'scramble': text = `${carrier ?? 'QB'} scramble, ${yds(o.yards)}`; break;
    case 'kneel': text = 'Kneel down'; break;
    case 'spike': text = 'Spike'; break;
    case 'fieldGoal':
    case 'extraPoint': text = `${Math.round(o.kickDistance ?? 0) > 0 && o.result === 'fieldGoal' ? `${Math.round(o.kickDistance ?? 0)}-yd ` : ''}${KICK_WORDS[o.result]} ${o.kickMade ? 'good' : 'no good'}`; break;
    case 'kickoff':
    case 'onside':
    case 'punt': text = `${KICK_WORDS[o.result]}${o.kickDistance ? ` ${Math.round(o.kickDistance)} yds` : ''}${o.returnYards ? `, return ${Math.round(o.returnYards)}` : ''}`; break;
    case 'twoPoint': text = `Two-point try ${o.points === 2 ? 'good' : 'failed'}`; break;
    default: text = `${o.result}, ${yds(o.yards)}`;
  }
  const tail = o.touchdown ? ', TD' : o.safety ? ', safety' : o.turnover && o.result !== 'interception' ? ', turnover' : o.firstDown ? ', 1st down' : '';
  return `${text}${tail}`;
};

/** The compact log of a finished game (names resolved from the game's setup). */
export const compactPlayLog = (log: readonly PlayLogEntry[], setup: Pick<GameSetup, 'home' | 'away'>): CompactPlay[] => {
  const name = (id: PlayerId | null): string | null => {
    if (!id) return null;
    const p = setup.home.players[id] ?? setup.away.players[id];
    return p ? shortName(p) : null;
  };
  return log.map((e) => {
    const o = e.outcome;
    return {
      q: e.quarter, c: Math.round(e.clock), p: e.possession, d: e.down, t: Math.round(e.distance * 10) / 10, b: Math.round(e.ballOn),
      x: describeOutcome(o, name), s: [e.scoreAfter.away, e.scoreAfter.home], k: o.points > 0 ? 1 : o.turnover ? 2 : 0,
    };
  });
};
