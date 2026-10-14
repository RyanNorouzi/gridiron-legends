/**
 * Small pure helpers shared by the league-info screens (schedule, standings, stats, records, Hall of Fame,
 * teams): team labels, game/week labels, score text, player lookups across active and retired players,
 * a mouse-click sanitiser (a left click also raises Confirm; tables react to the pointer edge instead) and a
 * DataTable rebuild that carries the sort and selection over.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { lookupPlayer } from '@/franchise/league';
import type { League, ScheduledGame } from '@/franchise/types';
import { fullName, type Player } from '@/players/types';
import type { Action, InputManager, InputState } from '../../input/types';
import { DataTable, type Column, type DataTableOptions } from '../kit/data-table';
import type { Tone } from '../kit/format';

/** Row kind used by grouped tables: headings separate groups and never act. */
export interface HeadingRow {
  kind: 'heading';
  id: string;
  label: string;
}

/** A heading row for a grouped table. */
export const heading = (id: string, label: string): HeadingRow => ({ kind: 'heading', id: `h:${id}`, label });

/** Team abbreviation ("FA" for none, the id when unknown). */
export const teamAbbr = (league: Pick<League, 'teams'>, id: TeamId | null | undefined): string => (id ? league.teams[id]?.abbr ?? String(id) : 'FA');

/** "City Name" of a team (the id when unknown). */
export const teamName = (league: Pick<League, 'teams'>, id: TeamId | null | undefined): string => {
  if (!id) return 'Free agent';
  const t = league.teams[id];
  return t ? `${t.city} ${t.name}` : String(id);
};

/** A player's full name (active or retired), or a fallback. */
export const playerName = (league: Pick<League, 'players' | 'retiredPlayers'>, id: PlayerId | null | undefined, fallback = 'Unknown'): string => {
  if (!id) return fallback;
  const p = lookupPlayer(league, id);
  return p ? fullName(p) : fallback;
};

/** A player (active or retired) or null. */
export const findPlayer = (league: Pick<League, 'players' | 'retiredPlayers'>, id: PlayerId | null | undefined): Player | null =>
  (id ? lookupPlayer(league, id) ?? null : null);

/** Round name of a playoff round (1-based), or "Round N". */
export const roundName = (league: Pick<League, 'settings'>, round: number): string => league.settings.playoff.roundNames[round - 1] ?? `Round ${round}`;

/** Short week label of a scheduled game: "Pre 2", "Wk 5", or the playoff round name. */
export const gameWeekLabel = (league: Pick<League, 'settings'>, g: Pick<ScheduledGame, 'week' | 'isPreseason' | 'isPlayoff' | 'playoffRound'>): string =>
  g.isPreseason ? `Pre ${g.week}` : g.isPlayoff ? roundName(league, g.playoffRound ?? g.week) : `Wk ${g.week}`;

/** The team's points and the opponent's in a finished game, from `teamId`'s side (null when unplayed / not involved). */
export const scoreFor = (g: ScheduledGame, teamId: TeamId): { us: number; them: number } | null => {
  const r = g.result;
  if (!r || (g.home !== teamId && g.away !== teamId)) return null;
  return g.home === teamId ? { us: r.homeScore, them: r.awayScore } : { us: r.awayScore, them: r.homeScore };
};

/** "W 24-17", "L 10-13 OT", "T 20-20" plus a tone, from `teamId`'s side; "-" when unplayed. */
export const resultText = (g: ScheduledGame, teamId: TeamId): { text: string; tone: Tone } => {
  const s = scoreFor(g, teamId);
  if (!s) return { text: '-', tone: 'dim' };
  const ot = g.result?.overtime ? ' OT' : '';
  if (s.us > s.them) return { text: `W ${s.us}-${s.them}${ot}`, tone: 'success' };
  if (s.us < s.them) return { text: `L ${s.us}-${s.them}${ot}`, tone: 'danger' };
  return { text: `T ${s.us}-${s.them}${ot}`, tone: 'warning' };
};

/** Game clock seconds as "M:SS". */
export const clockText = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Signed number with one decimal ("+0.12" style digits configurable). */
export const signedFixed = (n: number, digits = 2): string => (n > 0 ? `+${n.toFixed(digits)}` : n.toFixed(digits));

/** Win percentage text ".625" (ties count half); ".000" before the first game. */
export const pctText = (w: number, l: number, t = 0): string => {
  const g = w + l + t;
  if (g === 0) return '.000';
  const p = (w + t / 2) / g;
  return p >= 1 ? '1.000' : `.${String(Math.round(p * 1000)).padStart(3, '0')}`;
};

/** Removes the edges (and held state) of some actions from an input snapshot. */
export const stripActions = (input: InputState, actions: readonly Action[]): InputState => {
  if (!actions.some((a) => input.justPressed.has(a) || input.down.has(a) || input.justReleased.has(a))) return input;
  const keep = (set: ReadonlySet<Action>): Set<Action> => new Set([...set].filter((a) => !actions.includes(a)));
  return { ...input, justPressed: keep(input.justPressed), down: keep(input.down), justReleased: keep(input.justReleased) };
};

/**
 * Drops the Confirm edge that the default mouse map raises with a left click (button 0 -> A), so a click acts once
 * through the pointer hit-tests (a table activates a row on release) instead of twice.
 */
export const sanitizeInput = (input: InputState): InputState => {
  const p = input.pointer;
  if (!p || !(p.justDown || p.justUp) || input.lastDevice !== 'mouse') return input;
  return stripActions(input, ['confirm']);
};

/** Glyph of an action for prompts ("?" headless). */
export const glyphOf = (input: InputManager | null | undefined, action: Action): string => input?.glyph(action) ?? '?';

/**
 * Sortable fixed-width columns widened to fit their label plus the ▲/▼ sort marker (the header otherwise cuts the
 * label to "..." when the column becomes the sort column).
 */
export const withSortRoom = <R>(columns: readonly Column<R>[]): Column<R>[] =>
  columns.map((c) => (c.sortValue && c.width !== undefined && c.width < c.label.length + 1 ? { ...c, width: c.label.length + 1 } : c));

/**
 * A new DataTable over `rows` (sortable columns given room for the sort marker, withSortRoom) that keeps the
 * previous table's sort (when the column still exists) and selected row id; when that row is gone, the first row
 * matching `focus` (e.g. the first non-heading row) is selected. Used whenever a view is (re)built.
 */
export const carryTable = <R>(
  prev: DataTable<R> | null, columns: readonly Column<R>[], rows: readonly R[], opts: DataTableOptions<R>, focus?: (row: R) => boolean,
): DataTable<R> => {
  const sortKey = prev?.sortKey && columns.some((c) => c.key === prev.sortKey && c.sortValue) ? prev.sortKey : null;
  const selected = prev?.selected ? prev.idOf(prev.selected) : undefined;
  const next = new DataTable(withSortRoom(columns), rows, {
    ...opts,
    ...(sortKey && prev ? { initialSort: { key: sortKey, dir: prev.sortDir } } : {}),
    ...(selected !== undefined ? { initialRowId: selected } : {}),
  });
  const kept = selected !== undefined && next.selected !== null && next.idOf(next.selected) === selected;
  if (!kept && focus) {
    const i = next.rows.findIndex(focus);
    if (i >= 0) next.select(i);
  }
  return next;
};
