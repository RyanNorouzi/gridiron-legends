/**
 * Game-state inspector model for the dev console: the GameState (score, clock, down & distance, ball spot,
 * possession, timeouts, phase, pending decision, weather, drive, last outcome) and the PlayState being shown (tick,
 * phase, dead reason, ball, controlled athletes, pass, lines, events, dev notes) as label / value text rows, with
 * paging for the fixed-size console panel. Pure: no drawing, no mutation.
 */
import { findAthlete } from '@/game/athlete';
import type { DevCommand } from '@/game/engine-api';
import type { PlayOutcome, PlayState } from '@/game/play-types';
import { ballOnFromY, type GameState, type TeamSide } from '@/game/types';

/** One label / value line of the inspector. */
export interface InspectorRow {
  section: 'game' | 'play';
  label: string;
  value: string;
}

/** Display options for the inspector rows. */
export interface InspectorOptions {
  /** Team abbreviations for the score line (default HOME / AWAY). */
  names?: Partial<Record<TeamSide, string>>;
  /** Engine commands still queued (shown on the play page). */
  pendingCommands?: readonly DevCommand[];
}

/** One page of inspector rows. */
export interface InspectorPage {
  rows: InspectorRow[];
  page: number;
  pageCount: number;
}

const ORDINAL = ['', '1ST', '2ND', '3RD', '4TH'];

/** 'm:ss' for a non-negative number of seconds. */
export const formatClock = (sec: number): string => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Offense-perspective yard line as 'OWN 25' / 'OPP 30' / '50'. */
export const yardLine = (ballOn: number): string => {
  const b = Math.min(100, Math.max(0, Math.round(ballOn)));
  if (b === 50) return '50';
  return b < 50 ? `OWN ${b}` : `OPP ${100 - b}`;
};

/** '3RD & 7', '1ST & GOAL'. */
export const downText = (down: number, distance: number, ballOn: number): string =>
  `${ORDINAL[down] ?? `${down}TH`} & ${ballOn + distance >= 100 ? 'GOAL' : Math.max(1, Math.round(distance))}`;

const n1 = (v: number): string => v.toFixed(1);

/** 'PASS +12 TD FD' style summary of a play result. */
export const outcomeSummary = (o: PlayOutcome): string => {
  const parts = [o.result.toUpperCase()];
  if (!o.incomplete && o.result !== 'penalty') parts.push(`${o.yards >= 0 ? '+' : ''}${o.yards}`);
  if (o.touchdown) parts.push('TD');
  if (o.safety) parts.push('SAFETY');
  if (o.turnover) parts.push(`TO ${String(o.turnoverType ?? '').toUpperCase()}`.trim());
  if (o.firstDown) parts.push('FD');
  if (o.kickMade !== null) parts.push(o.kickMade ? 'GOOD' : 'NO GOOD');
  if (o.penalties.length > 0) parts.push(`FLAGS ${o.penalties.length}`);
  return parts.join(' ');
};

/** GameState summary rows. */
export const gameRows = (s: Readonly<GameState>, opts: InspectorOptions = {}): InspectorRow[] => {
  const name = (side: TeamSide): string => opts.names?.[side] ?? side.toUpperCase();
  const row = (label: string, value: string): InspectorRow => ({ section: 'game', label, value });
  const pd = s.pendingDecision;
  const w = s.weather;
  const lastOutcome = s.lastOutcome ?? s.playLog[s.playLog.length - 1]?.outcome ?? null;
  return [
    row('SCORE', `${name('away')} ${s.score.away} - ${name('home')} ${s.score.home}`),
    row('CLOCK', `Q${s.clock.quarter} ${formatClock(s.clock.secondsRemaining)} ${s.clock.running ? 'RUN' : 'STOP'} PC ${Math.ceil(s.clock.playClock)}`),
    row('DOWN', downText(s.down, s.distance, s.ballOn)),
    row('BALL ON', `${yardLine(s.ballOn)} (${n1(s.ballOn)}) X ${n1(s.ballX)}`),
    row('POSSESSION', `${name(s.possession)} DIR ${s.direction > 0 ? '+1' : '-1'}`),
    row('TIMEOUTS', `${name('home')} ${s.timeouts.home} ${name('away')} ${s.timeouts.away}`),
    row('CHALLENGES', `${name('home')} ${s.challenges.home} ${name('away')} ${s.challenges.away}`),
    row('PHASE', s.phase.toUpperCase() + (s.kickoffPending ? ' KICKOFF' : '') + (s.patPending ? ' PAT' : '')),
    row('PENDING', pd ? `${pd.kind.toUpperCase()} ${name(pd.side)}${pd.deadlineSec !== null ? ` ${n1(pd.deadlineSec)}S` : ''}` : 'NONE'),
    row('WEATHER', `${w.type.toUpperCase()} ${Math.round(w.temperatureF)}F WIND ${Math.round(w.windMph)}`),
    row('DRIVE', `${name(s.drive.possession)} ${s.drive.plays} PLAYS ${s.drive.yards} YD${s.drive.result ? ` ${s.drive.result.toUpperCase()}` : ''}`),
    row('LAST PLAY', lastOutcome ? outcomeSummary(lastOutcome) : '-'),
    row('PLAYS', String(s.playLog.length)),
  ];
};

/** PlayState summary rows (a single 'NONE' row without a play). */
export const playRows = (p: PlayState | null, opts: InspectorOptions = {}): InspectorRow[] => {
  const row = (label: string, value: string): InspectorRow => ({ section: 'play', label, value });
  if (!p) return [row('PLAY', 'NONE')];
  const ball = p.ball;
  const holder = findAthlete(p, ball.carrierId);
  const controlled = (['home', 'away'] as const).map((side) => (p.controlledIds[side] ? `${side.toUpperCase()} ${p.controlledIds[side]}` : null)).filter((x) => x !== null);
  const pass = p.pass;
  const last = p.events[p.events.length - 1];
  const pending = opts.pendingCommands ?? [];
  const rows = [
    row('TICK', `${p.tick} (${n1(p.time)}S) CLOCK ${n1(p.playClock)}`),
    row('PHASE', p.phase.toUpperCase()),
    row('DEAD', p.deadReason ? `${p.deadReason.toUpperCase()}${p.deadSpot ? ` @ ${n1(p.deadSpot.x)},${n1(p.deadSpot.y)}` : ''}` : '-'),
    row('BALL', `${ball.phase.toUpperCase()} ${ball.kind.toUpperCase()} ${holder ? holder.id : '-'}`),
    row('BALL POS', `${n1(ball.pos.x)},${n1(ball.pos.y)} Z ${n1(ball.z)} (${yardLine(ballOnFromY(ball.pos.y, p.ctx.direction))})`),
    row('CONTROLLED', controlled.length > 0 ? controlled.join(' ') : 'NONE'),
    row('PASS', pass ? `${pass.throwerId} > ${pass.targetId ?? 'AWAY'} ${pass.throwType.toUpperCase()} AIR ${Math.round(pass.airYards)} D ${pass.difficulty.toFixed(2)}` : '-'),
    row('LINES', `LOS ${n1(p.losY)} 1ST ${n1(p.firstDownY)}`),
    row('EVENTS', `${p.events.length}${last ? ` LAST ${last.type.toUpperCase()}` : ''}`),
    row('PLAY CALL', `${p.ctx.offensivePlay.id} v ${p.ctx.defensivePlay.id}`),
  ];
  if (typeof p.debug.dev === 'string') rows.push(row('DEV', String(p.debug.dev)));
  if (pending.length > 0) rows.push(row('QUEUED', pending.map((c) => c.type).join(' ')));
  return rows;
};

/** Game rows followed by play rows. */
export const buildInspectorRows = (game: Readonly<GameState>, play: PlayState | null, opts: InspectorOptions = {}): InspectorRow[] =>
  [...gameRows(game, opts), ...playRows(play, opts)];

/** Rows `page` (clamped) of `pageSize` rows each; an empty list is one empty page. */
export const paginate = (rows: readonly InspectorRow[], pageSize: number, page: number): InspectorPage => {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(pageCount - 1, Math.max(0, Math.floor(page)));
  return { rows: rows.slice(p * size, p * size + size), page: p, pageCount };
};
