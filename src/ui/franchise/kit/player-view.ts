/**
 * Pure player-card view-model (used by the player card screen and reusable by roster/market lists).
 *
 * POTENTIAL VISIBILITY RULE (`potentialVisibility`), from the viewing team's perspective:
 * - 'exact'  : the player is on the viewer's roster, or the viewer drafted him (own staff has full access);
 *              the development trait is shown too.
 * - 'range'  : the viewer holds a scouting report on him (League.draft.reports[viewer][id]) -> the report's
 *              potential range (e.g. "68-76").
 * - 'hidden' : everyone else, and retired players -> "?".
 * Overall and attributes are public for league players (they are visible on film).
 */
import { personalityTags } from '@/franchise/career-stage';
import type { PlayerId, TeamId } from '@/core/ids';
import { capHit, contractEndYear, leagueCapYear, rebaseContract } from '@/franchise/contracts';
import type { League } from '@/franchise/types';
import { positionAttributeProfile, attributeWeight } from '@/players/attributes';
import { fullName, type AttributeKey, type Player } from '@/players/types';
import { addLines, emptyCareer } from '@/statistics/aggregate';
import type { PlayerStatLine } from '@/statistics/types';
import { loadRegions } from '@/teams/data';
import type { CellValue } from './data-table';
import {
  POSITION_NAMES, formatContract, formatDevTrait, formatExperience, formatHeight, formatInjury, formatMoney, formatRating,
  formatRatingRange, formatSigned, formatWeight, humanize, moodLabel, moodTone, ordinal, type Tone, type ToneText,
} from './format';
import { statGroupsFor, type StatGroup } from './stat-columns';

/** How much of a player's potential the viewer may see. */
export type PotentialMode = 'exact' | 'range' | 'hidden';

/** Potential as the viewer may see it. */
export const potentialVisibility = (league: League, player: Player, viewerTeamId: TeamId): { mode: PotentialMode; text: ToneText } => {
  if (!player.retired && (player.teamId === viewerTeamId || player.draft?.teamId === viewerTeamId)) {
    return { mode: 'exact', text: formatRating(player.potential) };
  }
  const report = player.retired ? undefined : league.draft?.reports[viewerTeamId]?.[player.id];
  if (report) return { mode: 'range', text: formatRatingRange(report.potentialRange[0], report.potentialRange[1]) };
  return { mode: 'hidden', text: { text: '?', tone: 'dim' } };
};

/** One label/value line of a card section. Headings have an empty value. */
export interface CardLine {
  id: string;
  label: string;
  value: CellValue;
  heading?: boolean;
}

/** One attribute of the ratings section. */
export interface RatingLine {
  key: AttributeKey;
  label: string;
  value: number;
  importance: 'primary' | 'secondary' | 'other';
  /** Position weight (sort key for importance). */
  weight: number;
}

/** One row of the season-by-season stats table. */
export interface StatRow {
  id: string;
  year: string;
  team: string;
  line: PlayerStatLine;
  total: boolean;
}

/** Everything the player card shows. */
export interface PlayerCardView {
  id: PlayerId;
  name: string;
  jersey: string;
  position: Player['position'];
  positionName: string;
  teamId: TeamId | null;
  teamLabel: string;
  status: 'active' | 'freeAgent' | 'retired';
  overall: ToneText;
  potential: ToneText;
  potentialMode: PotentialMode;
  overview: CardLine[];
  ratings: RatingLine[];
  statGroups: StatGroup[];
  statRows: StatRow[];
  history: CardLine[];
}

let regionNames: Map<string, string> | null = null;
/** Display name of a region id (falls back to the humanized id). */
const regionName = (id: string): string => {
  regionNames ??= new Map(loadRegions().map((r) => [r.id, r.name]));
  return regionNames.get(id) ?? humanize(id);
};

const heading = (id: string, label: string): CardLine => ({ id, label, value: '', heading: true });

const draftLine = (league: League, p: Player): string => {
  const d = p.draft;
  if (!d) return 'Undrafted';
  const by = league.teams[d.teamId]?.abbr ?? '?';
  return `${d.year} Rd ${d.round} Pick ${d.pick} (${ordinal(d.overall)}) - ${by}`;
};

const contractLines = (league: League, p: Player): CardLine[] => {
  const c = p.contract;
  if (!c) return [{ id: 'asking', label: 'Asking', value: `${formatMoney(p.askingSalary)}/yr` }];
  const year = leagueCapYear(league);
  const lines: CardLine[] = [
    { id: 'contract', label: 'Contract', value: formatContract(c, { remaining: true }) },
    { id: 'capHit', label: `Cap hit ${year}`, value: formatMoney(capHit(c, year)) },
    { id: 'ends', label: 'Expires', value: `After ${contractEndYear(c)}` },
    // What is still owed, like the rest of the card (the signed total counted seasons already paid).
    { id: 'guaranteed', label: 'Guaranteed left', value: formatMoney(rebaseContract(c, year).guaranteed) },
    { id: 'role', label: 'Role', value: humanize(c.role) },
  ];
  if (c.tag) lines.push({ id: 'tag', label: 'Tag', value: { text: humanize(c.tag), tone: 'info' } });
  return lines;
};

const mood = (v: number): ToneText => ({ text: `${moodLabel(v)} (${Math.round(v)})`, tone: moodTone(v) });

const ratingLines = (p: Player): RatingLine[] => {
  const prof = positionAttributeProfile(p.position);
  const make = (key: AttributeKey, importance: RatingLine['importance']): RatingLine =>
    ({ key, label: humanize(key), value: p.attrs[key], importance, weight: attributeWeight(p.position, key) });
  return [...prof.primary.map((k) => make(k, 'primary')), ...prof.secondary.map((k) => make(k, 'secondary')), ...prof.irrelevant.map((k) => make(k, 'other'))];
};

const statRows = (league: League, p: Player): StatRow[] => {
  const career = league.careerStats[p.id] ?? emptyCareer(p.id);
  const abbr = (id: TeamId | null): string => (id ? league.teams[id]?.abbr ?? '-' : '-');
  const rows: StatRow[] = career.seasons.map((s) => ({ id: `y${s.year}`, year: String(s.year), team: abbr(s.teamId), line: s.line, total: false }));
  let totals = career.totals;
  const current = league.season.stats[p.id];
  if (current && !career.seasons.some((s) => s.year === league.season.year)) {
    rows.push({ id: `y${league.season.year}`, year: `${league.season.year}*`, team: abbr(p.teamId), line: current, total: false });
    totals = addLines(totals, current);
  }
  rows.push({ id: 'career', year: 'Career', team: '', line: totals, total: true });
  return rows;
};

const historyLines = (league: League, p: Player): CardLine[] => {
  const lines: CardLine[] = [heading('h-prog', 'Progression')];
  const prog = [...p.progressionLog].reverse();
  if (prog.length === 0) lines.push({ id: 'prog-none', label: 'No offseasons yet', value: '' });
  prog.forEach((e, i) => {
    const delta = e.overallAfter - e.overallBefore;
    const tone: Tone = delta > 0 ? 'success' : delta < 0 ? 'danger' : 'normal';
    const kind = e.kind === 'normal' ? '' : ` ${humanize(e.kind)}`;
    lines.push({ id: `prog-${i}`, label: String(e.year), value: { text: `${e.overallBefore} → ${e.overallAfter} (${formatSigned(delta)})${kind}`, tone } });
  });
  const awards = [...league.history.flatMap((h) => h.awards), ...league.season.awards].filter((a) => a.playerId === p.id);
  if (awards.length > 0) {
    lines.push(heading('h-awards', 'Awards'));
    awards.forEach((a, i) => lines.push({ id: `award-${i}`, label: String(a.year), value: { text: a.award, tone: 'accent' } }));
  }
  lines.push(heading('h-inj', 'Injuries'));
  const injuries = [...p.injuryHistory, ...(p.injury ? [p.injury] : [])].reverse();
  if (injuries.length === 0) lines.push({ id: 'inj-none', label: 'None', value: '' });
  injuries.forEach((inj, i) => lines.push({
    id: `inj-${i}`, label: `${inj.occurredYear} Wk ${inj.occurredWeek}`,
    value: { text: `${humanize(inj.bodyArea)} - ${humanize(inj.severity)}`, tone: inj.severity === 'minor' ? 'warning' : 'danger' },
  }));
  return lines;
};

/** Builds the card for `playerId` as seen by `viewerTeamId`; null when the id is unknown. */
export const buildPlayerCard = (league: League, playerId: PlayerId, viewerTeamId: TeamId): PlayerCardView | null => {
  const p = league.players[playerId] ?? league.retiredPlayers[playerId];
  if (!p) return null;
  const team = p.teamId ? league.teams[p.teamId] ?? null : null;
  const status: PlayerCardView['status'] = p.retired ? 'retired' : team ? 'active' : 'freeAgent';
  const teamLabel = status === 'retired' ? 'Retired' : team ? `${team.city} ${team.name}` : 'Free Agent';
  const pot = potentialVisibility(league, p, viewerTeamId);
  const flags = league.club?.playerFlags[p.id] ?? [];
  const overview: CardLine[] = [
    heading('h-bio', 'Bio'),
    { id: 'team', label: 'Team', value: teamLabel },
    { id: 'position', label: 'Position', value: POSITION_NAMES[p.position] },
    { id: 'age', label: 'Age', value: String(p.age) },
    { id: 'size', label: 'Height / Weight', value: `${formatHeight(p.heightIn)} / ${formatWeight(p.weightLb)}` },
    { id: 'experience', label: 'Experience', value: formatExperience(p.experience) },
    { id: 'college', label: 'College', value: p.college ?? '-' },
    { id: 'hometown', label: 'Home region', value: regionName(p.homeRegion) },
    { id: 'draft', label: 'Draft', value: draftLine(league, p) },
    heading('h-contract', 'Contract'),
    ...contractLines(league, p),
    heading('h-status', 'Status'),
    { id: 'health', label: 'Health', value: formatInjury(p.injury) },
    { id: 'morale', label: 'Morale', value: mood(p.morale.morale) },
    { id: 'confidence', label: 'Confidence', value: mood(p.morale.confidence) },
    { id: 'coach', label: 'Coach relationship', value: mood(p.morale.coachRelationship) },
    { id: 'traits', label: 'Traits', value: personalityTags(p).length > 0 ? personalityTags(p).map(humanize).join(', ') : 'None' },
    ...(pot.mode === 'exact' ? [{ id: 'dev', label: 'Development', value: { text: formatDevTrait(p.devTrait), tone: 'info' as Tone } }] : []),
    ...(flags.length > 0 ? [{ id: 'flags', label: 'Flags', value: { text: flags.map(humanize).join(', '), tone: 'warning' as Tone } }] : []),
  ];
  return {
    id: p.id, name: fullName(p), jersey: `#${p.jerseyNumber}`, position: p.position, positionName: POSITION_NAMES[p.position],
    teamId: team?.id ?? null, teamLabel, status, overall: formatRating(p.overall), potential: pot.text, potentialMode: pot.mode,
    overview, ratings: ratingLines(p), statGroups: statGroupsFor(p.position), statRows: statRows(league, p), history: historyLines(league, p),
  };
};
