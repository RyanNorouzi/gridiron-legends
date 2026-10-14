/**
 * Pure view-models of the Teams browser and the read-only team view: the league's team list, a team's header,
 * roster (potential per the scouting visibility rule), unit ratings per position (depth-chart starters), coaching
 * staff, finances summary (season books, cap, club, past seasons) and history (seasons, titles, top rivalries).
 */
import type { CoachId, PlayerId, TeamId } from '@/core/ids';
import { capHit, capSpace, leagueCapYear, teamCapHit, teamDeadMoney } from '@/franchise/contracts';
import { seasonFinanceReport } from '@/franchise/finances';
import { rivalryLedgerEntry, topRivals } from '@/franchise/rivalries';
import { emptyStanding } from '@/franchise/standings';
import type { League } from '@/franchise/types';
import { POSITIONS, fullName, type Player, type Position } from '@/players/types';
import { STARTER_COUNTS, starters } from '@/teams/depth-chart';
import type { Coach } from '@/teams/types';
import type { CellValue } from '../kit/data-table';
import { formatInjury, formatMoney, formatPercent, formatRating, formatRecord, humanize, ordinal, type ToneText } from '../kit/format';
import { potentialVisibility } from '../kit/player-view';
import { divisionRows } from '../shell/home-model';
import { teamAbbr, teamName } from './common';
import { seasonFinish } from './records-model';

/** One team of the browser. */
export interface TeamListRow {
  id: TeamId;
  abbr: string;
  name: string;
  /** Team name without the city ("Outriders"), for narrow cells. */
  nickname: string;
  conference: string;
  division: string;
  record: string;
  pctValue: number;
  overall: number;
  offense: number;
  defense: number;
  coach: string;
  /** Head coach as "F. Last" (or "Vacant"), for narrow cells. */
  coachShort: string;
  titles: number;
  user: boolean;
}

const coachName = (c: Coach | undefined): string => (c ? `${c.firstName} ${c.lastName}` : 'Vacant');
const coachShortName = (c: Coach | undefined): string => (c ? `${c.firstName.slice(0, 1)}. ${c.lastName}` : 'Vacant');

/** Every team of the league. */
export const teamListRows = (league: League, userTeamId: TeamId | null): TeamListRow[] =>
  Object.values(league.teams).map((t) => {
    const s = league.season.standings[t.id] ?? emptyStanding(t.id);
    const g = s.wins + s.losses + s.ties;
    const hc = t.headCoachId ? league.coaches[t.headCoachId] : undefined;
    return {
      id: t.id, abbr: t.abbr, name: `${t.city} ${t.name}`, nickname: t.name, conference: t.conference, division: t.division, record: formatRecord(s),
      pctValue: g > 0 ? (s.wins + s.ties / 2) / g : 0, overall: t.overall, offense: t.offenseRating, defense: t.defenseRating,
      coach: coachName(hc), coachShort: coachShortName(hc), titles: t.championships, user: t.id === userTeamId,
    };
  });

/** A team page header. */
export interface TeamHeader {
  id: TeamId;
  title: string;
  /** "Revelers (NOL)": the title without the city, for narrow (large-text) title rows. */
  shortTitle: string;
  /** Season record, conference/division with the division rank, ratings and head coach. */
  subtitle: string;
  /** "Large market". */
  market: string;
}

/** Header lines of a team page (null for an unknown team). */
export const teamHeader = (league: League, teamId: TeamId): TeamHeader | null => {
  const t = league.teams[teamId];
  if (!t) return null;
  const s = league.season.standings[teamId] ?? emptyStanding(teamId);
  const hc = t.headCoachId ? league.coaches[t.headCoachId] : undefined;
  const rank = divisionRows(league, teamId).find((r) => r.teamId === teamId)?.rank;
  return {
    id: teamId, title: `${t.city} ${t.name} (${t.abbr})`, shortTitle: `${t.name} (${t.abbr})`,
    subtitle: `${league.season.year} ${formatRecord(s)} · ${t.conference} ${t.division}${rank ? ` ${ordinal(rank)}` : ''} · OVR ${t.overall} OFF ${t.offenseRating} DEF ${t.defenseRating} · HC ${coachName(hc)}`,
    market: `${humanize(t.marketSize)} market`,
  };
};

/* --------------------------------- roster --------------------------------- */

/** One rostered player. */
export interface RosterRow {
  id: PlayerId;
  jersey: number;
  name: string;
  position: Position;
  posOrder: number;
  age: number;
  overall: number;
  potential: ToneText;
  potentialSort: number | null;
  experience: number;
  capHit: number;
  contractYears: number;
  injury: ToneText;
  injured: boolean;
}

/** A team's roster as the viewer may see it (potential per potentialVisibility). */
export const rosterRows = (league: League, teamId: TeamId, viewerTeamId: TeamId): RosterRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const year = leagueCapYear(league);
  const order = new Map(POSITIONS.map((p, i) => [p, i]));
  return team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => !!p).map((p) => {
    const pot = potentialVisibility(league, p, viewerTeamId);
    return {
      id: p.id, jersey: p.jerseyNumber, name: fullName(p), position: p.position, posOrder: order.get(p.position) ?? 99, age: p.age, overall: p.overall,
      potential: pot.text, potentialSort: pot.mode === 'hidden' ? null : Number.parseInt(pot.text.text, 10) || null, experience: p.experience,
      capHit: capHit(p.contract, year), contractYears: p.contract?.yearsRemaining ?? 0, injury: formatInjury(p.injury), injured: p.injury !== null,
    };
  });
};

/* ---------------------------------- units ---------------------------------- */

/** One position unit. */
export interface UnitRow {
  id: string;
  position: Position;
  starters: number;
  average: number;
  best: string;
  bestId: PlayerId | null;
  bestOverall: number;
  count: number;
}

/** Per position: the depth-chart starters' average overall, the best player and the head count. */
export const unitRows = (league: League, teamId: TeamId): UnitRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const roster = team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => !!p);
  return POSITIONS.map((pos) => {
    const at = roster.filter((p) => p.position === pos).sort((a, b) => b.overall - a.overall || (a.id < b.id ? -1 : 1));
    const listed = starters(team.depthChart, pos, STARTER_COUNTS[pos]).map((id) => league.players[id]).filter((p): p is Player => !!p);
    const group = listed.length > 0 ? listed : at.slice(0, STARTER_COUNTS[pos]);
    const avg = group.length > 0 ? Math.round(group.reduce((s, p) => s + p.overall, 0) / group.length) : 0;
    const best = at[0];
    return { id: pos, position: pos, starters: group.length, average: avg, best: best ? fullName(best) : '-', bestId: best?.id ?? null, bestOverall: best?.overall ?? 0, count: at.length };
  });
};

/* ---------------------------------- staff ---------------------------------- */

/** One coach of a team. */
export interface CoachRow {
  id: CoachId;
  role: string;
  name: string;
  age: number;
  offense: number;
  defense: number;
  development: number;
  motivation: number;
  record: string;
  titles: number;
  about: string;
}

const ROLE_ORDER = ['HC', 'OC', 'DC', 'QBCoach', 'RBCoach', 'WRCoach', 'OLCoach', 'DBCoach', 'LBCoach', 'StrengthCoach', 'Scout'];

/** Display names of the staff roles. */
export const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  HC: 'Head coach', OC: 'Off coord', DC: 'Def coord', QBCoach: 'QB coach', RBCoach: 'RB coach', WRCoach: 'WR coach', OLCoach: 'OL coach',
  DBCoach: 'DB coach', LBCoach: 'LB coach', StrengthCoach: 'Strength', Scout: 'Scout',
});

/** The head coach then the staff by role. */
export const coachRows = (league: League, teamId: TeamId): CoachRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const ids = [...new Set([...(team.headCoachId ? [team.headCoachId] : []), ...team.staffIds])];
  return ids.map((id) => league.coaches[id]).filter((c): c is Coach => !!c).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)).map((c) => ({
    id: c.id, role: ROLE_LABELS[c.role] ?? humanize(c.role), name: coachName(c), age: c.age,
    offense: c.ratings.offense, defense: c.ratings.defense, development: c.ratings.playerDevelopment, motivation: c.ratings.motivation,
    record: `${c.careerWins}-${c.careerLosses}`, titles: c.championships,
    about: `${humanize(c.offensiveScheme)} offense, ${humanize(c.defensiveScheme)} defense${c.traits.length ? ` · ${c.traits.map(humanize).join(', ')}` : ''}`,
  }));
};

/* -------------------------------- finances -------------------------------- */

/** One line of the finances summary. */
export interface InfoLine {
  id: string;
  label: string;
  value: CellValue;
  heading?: boolean;
  teamId?: TeamId;
}

const money = (v: number): ToneText => ({ text: formatMoney(v), tone: v < 0 ? 'danger' : 'normal' });

/** Season books, cap, club and past seasons of a team. */
export const financeLines = (league: League, teamId: TeamId): InfoLine[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const r = seasonFinanceReport(league, teamId);
  const year = leagueCapYear(league);
  const stadium = league.stadiums[team.stadiumId];
  const space = capSpace(team, league.players, league.settings, year);
  const past = [...(league.club?.financeHistory?.[teamId] ?? [])].reverse();
  return [
    { id: 'h:season', label: `${r.year} books`, value: '', heading: true },
    { id: 'cash', label: 'Cash', value: money(r.cash) },
    { id: 'rev', label: 'Revenue', value: money(r.totalRevenue) },
    { id: 'rev:detail', label: '', value: { text: `Tickets ${formatMoney(r.revenue.tickets)} · Merch ${formatMoney(r.revenue.merchandise)} · Sponsors ${formatMoney(r.revenue.sponsors)} · Media ${formatMoney(r.revenue.media)}`, tone: 'dim' } },
    { id: 'exp', label: 'Expenses', value: money(r.totalExpenses) },
    { id: 'exp:detail', label: '', value: { text: `Players ${formatMoney(r.expenses.playerSalaries)} · Staff ${formatMoney(r.expenses.staffSalaries)} · Stadium ${formatMoney(r.expenses.stadium)} · Facilities ${formatMoney(r.expenses.facilities)}`, tone: 'dim' } },
    { id: 'profit', label: 'Profit', value: { text: formatMoney(r.profit), tone: r.profit >= 0 ? 'success' : 'danger' } },
    { id: 'h:cap', label: `${year} cap`, value: '', heading: true },
    { id: 'payroll', label: 'Payroll', value: formatMoney(teamCapHit(team, league.players, year)) },
    { id: 'dead', label: 'Dead money', value: formatMoney(teamDeadMoney(team, year)) },
    { id: 'space', label: 'Cap space', value: { text: formatMoney(space), tone: space >= 0 ? 'success' : 'danger' } },
    { id: 'h:club', label: 'Club', value: '', heading: true },
    { id: 'owner', label: 'Owner confidence', value: formatRating(r.ownerConfidence) },
    { id: 'fans', label: 'Fan support', value: formatRating(team.fans.support) },
    { id: 'att', label: 'Attendance', value: r.homeGames > 0 ? `${formatPercent(r.averageAttendancePct, 0)} (${r.homeGames} home games)` : 'No home games yet' },
    { id: 'ticket', label: 'Ticket price', value: `$${Math.round(team.finances.ticketPrice)}` },
    { id: 'market', label: 'Market', value: humanize(team.marketSize) },
    { id: 'stadium', label: 'Stadium', value: stadium ? `${stadium.name} (${stadium.capacity.toLocaleString('en-US')} seats)` : '-' },
    ...(past.length > 0 ? [{ id: 'h:past', label: 'Past seasons', value: '', heading: true } as InfoLine] : []),
    ...past.map((h): InfoLine => ({ id: `past:${h.year}`, label: String(h.year), value: { text: `Revenue ${formatMoney(h.revenue)} · Profit ${formatMoney(h.profit)} · Cash ${formatMoney(h.cashEnd)}`, tone: h.profit >= 0 ? 'normal' : 'warning' } })),
  ];
};

/* --------------------------------- history --------------------------------- */

/** Seasons (current first when under way), titles and the top rivalries of a team. */
export const historyLines = (league: League, teamId: TeamId): InfoLine[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const s = league.season.standings[teamId] ?? emptyStanding(teamId);
  const out: InfoLine[] = [{ id: 'h:seasons', label: `Seasons (${team.championships} titles)`, value: '', heading: true }];
  if (s.wins + s.losses + s.ties > 0 && !team.history.some((h) => h.year === league.season.year)) {
    const fin = seasonFinish(league, teamId, league.season.year);
    out.push({ id: `yr:${league.season.year}`, label: `${league.season.year}`, value: { text: `${formatRecord(s)}${fin.text ? ` ${fin.text}` : ' (in progress)'}`, tone: fin.text ? fin.tone : 'info' } });
  }
  for (const h of [...team.history].sort((a, b) => b.year - a.year)) {
    const fin = seasonFinish(league, teamId, h.year);
    out.push({ id: `yr:${h.year}`, label: String(h.year), value: { text: `${formatRecord(h)} ${fin.text}`, tone: fin.tone === 'dim' ? 'normal' : fin.tone } });
  }
  if (team.history.length === 0 && out.length === 1) out.push({ id: 'none', label: '', value: { text: 'No finished seasons yet', tone: 'dim' } });
  const rivals = topRivals(league, teamId, 3);
  if (rivals.length > 0) out.push({ id: 'h:rivals', label: 'Rivalries', value: '', heading: true });
  for (const r of rivals) {
    const e = rivalryLedgerEntry(league, teamId, r.teamId);
    const mine = e ? (e.teams[0] === teamId ? 0 : 1) : 0;
    const rec = e ? `${e.wins[mine]}-${e.wins[1 - mine]}${e.ties ? `-${e.ties}` : ''} in ${e.meetings} meetings` : 'No meetings yet';
    out.push({ id: `rival:${r.teamId}`, label: `vs ${teamAbbr(league, r.teamId)}`, value: `${teamName(league, r.teamId)} · ${rec}`, teamId: r.teamId });
  }
  return out;
};
