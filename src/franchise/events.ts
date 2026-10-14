/**
 * Systemic franchise events. Nothing is scripted: every trigger reads League state.
 *
 *   tradeDemand         star (overall >= 80) with morale < 40 on a losing team, not already on the block
 *   extensionRequest    contract in its last year after a good season (started most games), once a year
 *   rookieBreakout / playerJump / playerSlump / veteranDecline   the latest progressionLog entry (offseason)
 *   lockerRoomConflict  hotHeaded player during a losing streak of 3+
 *   injury              a notable player hurt for 2+ weeks
 *   coachDisagreement   head-coach traits clashing with results (aggressive + weak offense, ...)
 *   targetsRequest      WR1 below 18% of the team's targets
 *   unhappyPlayer       an expected starter left on the bench
 *   winningStreak / losingStreak   4+ in a row (once per streak)
 *   rivalryGame         next game against a strong rival (intensity >= 60)
 *   recordBroken        a player/team beat an existing league record this week and it is news (history.ts isRecordNews)
 *   holdout             offseason: asking salary >= 1.5x the current salary
 *   retirementAnnounced offseason: old or declining veterans
 *   fanUnrest           fan support < 35
 *   sponsorOffer        random, likelier in big markets and for winning teams
 *
 * Rate limiting: at most EVENT_CATALOG.limits.maxPerWeek new events per team per call, one per type, a
 * per-type cooldown per subject (player / coach / team) on a monotonic club clock, and once-only subject
 * keys. resolveEvent applies a choice's effects (events-catalog.ts); events left unresolved for
 * autoResolveWeeks resolve with their default choice.
 *
 * Club orchestration also lives here: advanceClubWeek (after every played week), advanceClubPhase (after an
 * offseason phase change) and closeClubSeason (once a year, in the offseason phase).
 */
import type { CoachId, PlayerId, TeamId } from '@/core/ids';
import { createRng, type Rng } from '@/core/rng';
import { fullName, type Player } from '@/players/types';
import type { BrokenRecord } from '@/statistics/records';
import type { Team } from '@/teams/types';
import { leagueCapYear, roundMoney, yearsRemainingAt } from './contracts';
import { EVENT_CATALOG, FRANCHISE_EVENT_TYPES, applyEventEffects, catalogTemplate, eventChoices, renderTemplate, type CatalogEventType } from './events-catalog';
import { aiFacilityUpgrades, economyScale, formatMoney } from './facilities';
import { applyFanEvent, applyGamesToFans, decayAllFans, seasonFanReset } from './fans';
import { FINANCE_DATA, applyAllWeekFinances, closeFinancialYear, isFinancialYearClosed, teamSuccess } from './finances';
import { isRecordNews, teamSeasonRecord } from './history';
import { leagueRng, withRngState } from './league';
import { isBenchedStarter, playerFlags, resetSeasonFlags, syncRosterMoves, weeklyMoraleAll } from './morale';
import { ensureClub, rivalryIntensity, updateRivalryLedger, withClub } from './rivalries';
import { scheduleWeekCount } from './settings';
import { advanceStaffYear, recordCoachPlayoffResults, teamStaff, type StaffYearReport } from './staff';
import { gamesPlayed, winPct } from './standings';
import type { FranchiseEvent, FranchiseEventData, League, ScheduledGame, SeasonPhase, Standing } from './types';

const OFFSEASON_ORDER: readonly SeasonPhase[] = ['awards', 'offseason', 'resigning', 'freeAgency', 'draft', 'postDraft', 'trainingCamp'];

/**
 * Monotonic club clock: season year * 100 + the week's position in the season calendar (preseason weeks,
 * regular-season weeks, playoff rounds, then one step per offseason phase).
 */
export const leagueClock = (league: Pick<League, 'settings' | 'season'>, phase: SeasonPhase = league.season.phase, week: number = league.season.week): number => {
  const s = league.settings;
  const pre = s.preseasonWeeks;
  const reg = scheduleWeekCount(s);
  const po = s.playoff.roundNames.length;
  const offset = phase === 'preseason' ? week : phase === 'regularSeason' ? pre + week : phase === 'playoffs' ? pre + reg + week : pre + reg + po + 1 + OFFSEASON_ORDER.indexOf(phase);
  return league.season.year * 100 + offset;
};

/** Clock value an event was raised at (older events without data fall back to year and week). */
export const eventRaisedAt = (e: FranchiseEvent): number => e.data?.raisedAt ?? e.year * 100 + e.week;

/** A broken record as reported by the week advance (WeekEvent 'record'). */
export type RecordBreak = Pick<BrokenRecord, 'record' | 'previous'>;

/** Options of generateEvents. */
export interface GenerateEventsOptions {
  /** Teams to generate for. Default: the user team, or every team in an all-AI league. */
  teamIds?: readonly TeamId[];
  /** Phase the week belonged to (default: the League's phase). */
  phase?: SeasonPhase;
  /** Records broken this week (recordBroken fires only from these). */
  brokenRecords?: readonly RecordBreak[];
}

interface Candidate {
  type: CatalogEventType;
  player: Player | null;
  coachId: CoachId | null;
  vars: Record<string, string | number>;
  data: FranchiseEventData;
  weight: number;
}

interface Ctx {
  league: League;
  team: Team;
  roster: Player[];
  phase: SeasonPhase;
  st: Standing | undefined;
  games: number;
  capYear: number;
  rng: Rng;
  records: readonly RecordBreak[];
}

const GAME_PHASES: readonly SeasonPhase[] = ['preseason', 'regularSeason', 'playoffs'];
const PROGRESSION_PHASES: readonly SeasonPhase[] = ['offseason', 'resigning', 'freeAgency', 'draft', 'postDraft', 'trainingCamp', 'preseason'];
const HOLDOUT_PHASES: readonly SeasonPhase[] = ['resigning', 'freeAgency', 'draft', 'postDraft', 'trainingCamp', 'preseason'];

const cand = (type: CatalogEventType, player: Player | null, vars: Record<string, string | number> = {}, data: FranchiseEventData = {}, weight = 0, coachId: CoachId | null = null): Candidate =>
  ({ type, player, coachId, vars, data, weight });

const isLosing = (c: Ctx): boolean => !!c.st && c.games >= 3 && (winPct(c.st) < 0.5 || c.st.streak <= -2);
const listedStarter = (team: Team, p: Player): boolean => {
  const i = (team.depthChart[p.position] ?? []).indexOf(p.id);
  return i >= 0 && i < 2;
};

const playerTriggers = (c: Ctx): Candidate[] => {
  const out: Candidate[] = [];
  const { league, team, phase } = c;
  const inSeason = phase === 'regularSeason' || phase === 'playoffs';
  const losing = isLosing(c);
  for (const p of c.roster) {
    const flags = playerFlags(league, p.id);
    if (losing && phase !== 'preseason' && p.morale.morale < 40 && p.overall >= 80 && !flags.includes('tradeBlock')) out.push(cand('tradeDemand', p, {}, {}, p.overall));
    const line = league.season.stats[p.id];
    const started = line?.gamesStarted ?? 0;
    const extWindow = (phase === 'regularSeason' && league.season.week >= 6) || ['playoffs', 'awards', 'offseason', 'resigning'].includes(phase);
    if (extWindow && p.contract && yearsRemainingAt(p.contract, c.capYear) <= 1 && !flags.includes('extensionTalks') && p.overall >= 74
      && p.morale.morale >= 40 && started >= Math.max(3, 0.6 * c.games)) out.push(cand('extensionRequest', p, {}, { subjectKey: `ext:${p.id}:${c.capYear}` }, p.overall));
    const last = p.progressionLog[p.progressionLog.length - 1];
    // Only the latest offseason's progression is news: its entry carries the finished season's year, so it is
    // season.year - 1 once the year rolled over (preseason) and season.year before that. Last year's entry seen
    // in this year's early offseason phases is stale.
    if (PROGRESSION_PHASES.includes(phase) && last && last.year === (phase === 'preseason' ? league.season.year - 1 : league.season.year)) {
      const key = `prog:${p.id}:${last.year}`;
      if (last.kind === 'breakout') out.push(cand(p.experience <= 3 ? 'rookieBreakout' : 'playerJump', p, {}, { subjectKey: key }, p.overall));
      else if (last.kind === 'jump' && p.overall >= 65) out.push(cand('playerJump', p, {}, { subjectKey: key }, p.overall));
      else if (last.kind === 'slump' && p.overall >= 60) out.push(cand('playerSlump', p, {}, { subjectKey: key }, p.overall));
      else if (last.kind === 'decline' && p.age >= 30 && p.overall >= 60) out.push(cand('veteranDecline', p, {}, { subjectKey: key }, p.overall));
    }
    if (inSeason && c.st && c.st.streak <= -3 && p.traits.includes('hotHeaded')) out.push(cand('lockerRoomConflict', p, { streak: -c.st.streak }, {}, 100 - p.morale.morale));
    const inj = p.injury;
    if (GAME_PHASES.includes(phase) && inj && inj.occurredYear === league.season.year && inj.severity !== 'minor' && inj.weeksRemaining >= 2 && (p.overall >= 70 || listedStarter(team, p))) {
      const area = { upperBody: 'upper-body', lowerBody: 'lower-body', head: 'head', core: 'core' }[inj.bodyArea];
      const outlook = inj.severity === 'seasonEnding' || inj.severity === 'careerThreatening' ? 'is out for the season'
        : `is expected to miss about ${inj.weeksRemaining} week${inj.weeksRemaining === 1 ? '' : 's'}`;
      out.push(cand('injury', p, { weeks: inj.weeksRemaining, outlook, severity: inj.severity === 'seasonEnding' ? 'season-ending' : inj.severity === 'careerThreatening' ? 'career-threatening' : inj.severity, area },
        { subjectKey: `inj:${p.id}:${inj.occurredYear}:${inj.occurredWeek}` }, p.overall));
    }
    if ((phase === 'regularSeason' || phase === 'preseason') && p.morale.morale < 50 && isBenchedStarter(team, c.roster, p)) out.push(cand('unhappyPlayer', p, {}, {}, p.overall));
    if (HOLDOUT_PHASES.includes(phase) && p.contract && p.experience >= 1 && yearsRemainingAt(p.contract, c.capYear) >= 1 && p.overall >= 78
      && p.askingSalary >= 1.5 * p.contract.salary && !flags.includes('holdout')) {
      out.push(cand('holdout', p, { amount: formatMoney(p.askingSalary) }, { amount: p.askingSalary, subjectKey: `ho:${p.id}:${c.capYear}` }, p.overall));
    }
    const lastDecline = last?.kind === 'decline';
    if ((phase === 'offseason' || phase === 'resigning') && !flags.includes('retiring')
      && (p.age >= 36 || (p.age >= 33 && (p.overall < 70 || lastDecline)) || (p.age >= 30 && p.injury?.severity === 'careerThreatening'))) {
      out.push(cand('retirementAnnounced', p, {}, { subjectKey: `ret:${p.id}:${league.season.year}` }, p.overall));
    }
  }
  return out;
};

const closeLosses = (league: League, teamId: TeamId): number =>
  league.season.schedule.filter((g) => !g.isPreseason && !g.isPlayoff && g.result && (g.home === teamId || g.away === teamId)).filter((g) => {
    const r = g.result;
    if (!r) return false;
    const margin = (g.home === teamId ? r.homeScore - r.awayScore : r.awayScore - r.homeScore);
    return margin < 0 && margin >= -7;
  }).length;

const teamTriggers = (c: Ctx): Candidate[] => {
  const out: Candidate[] = [];
  const { league, team, phase, st } = c;
  const year = league.season.year;
  if (phase === 'regularSeason' && st && c.games >= 4) {
    const staff = teamStaff(league, team);
    const hc = staff.HC;
    const ppg = st.pointsFor / c.games;
    const papg = st.pointsAgainst / c.games;
    const has = (t: 'aggressive' | 'conservative' | 'innovator'): boolean => hc?.traits.includes(t) ?? false;
    const offense = (has('aggressive') && ppg < 18) || (has('innovator') && ppg < 17) || (has('conservative') && closeLosses(league, team.id) >= 2 && ppg < 21);
    const defense = (has('aggressive') && papg > 27) || (has('conservative') && papg > 29);
    const coach = offense ? (staff.OC ?? hc) : defense ? (staff.DC ?? hc) : undefined;
    if (coach) out.push(cand('coachDisagreement', null, { coach: `${coach.firstName} ${coach.lastName}`, value: (offense ? ppg : papg).toFixed(1) }, {}, 0, coach.id));
  }
  if (phase === 'regularSeason' && c.games >= 3) {
    const wr1 = league.players[team.depthChart.WR?.[0] as PlayerId];
    const attempts = c.roster.reduce((s, p) => s + (league.season.stats[p.id]?.passing.attempts ?? 0), 0);
    if (wr1 && wr1.teamId === team.id && wr1.injury === null && wr1.overall >= 75 && attempts >= 60 && !playerFlags(league, wr1.id).includes('targetsPromised')) {
      const share = (league.season.stats[wr1.id]?.receiving.targets ?? 0) / attempts;
      if (share < 0.18) out.push(cand('targetsRequest', wr1, { value: Math.round(share * 100) }, {}, wr1.overall));
    }
  }
  if (GAME_PHASES.includes(phase) && st && phase !== 'preseason') {
    const start = gamesPlayed(st) - Math.abs(st.streak);
    if (st.streak >= 4) out.push(cand('winningStreak', null, { streak: st.streak }, { subjectKey: `ws:${team.id}:${year}:${start}` }));
    if (st.streak <= -4) out.push(cand('losingStreak', null, { streak: -st.streak }, { subjectKey: `ls:${team.id}:${year}:${start}` }));
  }
  const s = league.season;
  if (s.phase === 'regularSeason' || s.phase === 'playoffs') {
    const next = s.schedule.find((g) => !g.result && g.week === s.week && (g.home === team.id || g.away === team.id) && g.isPlayoff === (s.phase === 'playoffs') && !g.isPreseason);
    const opp = next ? league.teams[next.home === team.id ? next.away : next.home] : undefined;
    if (next && opp && rivalryIntensity(league, team.id, opp.id) >= 60) {
      out.push(cand('rivalryGame', null, { opponent: `${opp.city} ${opp.name}` }, { subjectKey: `rg:${next.id}`, otherTeamId: opp.id, gameId: next.id }, rivalryIntensity(league, team.id, opp.id)));
    }
  }
  for (const b of c.records) {
    const r = b.record;
    if (!isRecordNews(league, b)) continue;
    const holder = r.holderPlayerId ? league.players[r.holderPlayerId] : undefined;
    const mine = r.holderPlayerId ? holder?.teamId === team.id : r.holderTeamId === team.id;
    if (!mine) continue;
    out.push(cand('recordBroken', holder ?? null, { player: r.holderName, stat: r.label, value: Math.round(r.value * 10) / 10 },
      { subjectKey: `rec:${r.key}:${r.holderPlayerId ?? r.holderTeamId ?? ''}:${r.year}` }, r.value));
  }
  if (team.fans.support < 35) out.push(cand('fanUnrest', null, { value: Math.round(team.fans.support) }));
  if (phase === 'preseason' || phase === 'regularSeason') {
    const success = teamSuccess(league, team.id);
    const S = FINANCE_DATA.sponsors;
    if (c.rng.chance(S.offerChance[team.marketSize] * (0.6 + 0.8 * success))) {
      const amount = roundMoney(S.perSeason[team.marketSize] * economyScale(league.settings) * S.offerShare * c.rng.range(0.8, 1.2) * (0.8 + 0.4 * success));
      out.push(cand('sponsorOffer', null, { amount: formatMoney(amount) }, { amount }));
    }
  }
  return out;
};

const subjectOf = (e: Pick<FranchiseEvent, 'playerId' | 'coachId'>): string => e.playerId ?? e.coachId ?? 'team';

/** True when an existing event blocks a candidate: once-only key already used, or the type is cooling down
 *  for this subject (cooldownWeeks) or for the whole team (teamCooldownWeeks). */
const blocked = (existing: readonly FranchiseEvent[], teamId: TeamId, c: Candidate, now: number): boolean => {
  const key = c.data.subjectKey;
  if (key && existing.some((e) => e.data?.subjectKey === key)) return true;
  const subject = c.player?.id ?? c.coachId ?? 'team';
  const { cooldownWeeks, teamCooldownWeeks } = EVENT_CATALOG.types[c.type];
  return existing.some((e) => e.type === c.type && e.teamId === teamId
    && now - eventRaisedAt(e) < (subjectOf(e) === subject ? Math.max(cooldownWeeks, teamCooldownWeeks) : teamCooldownWeeks));
};

const record = (st: Standing | undefined): string => (st ? `${st.wins}-${st.losses}${st.ties ? `-${st.ties}` : ''}` : '0-0');

const toEvent = (league: League, team: Team, c: Candidate, week: number, now: number, taken: Set<string>): FranchiseEvent => {
  const tpl = EVENT_CATALOG.types[c.type];
  const p = c.player;
  const vars: Record<string, string | number> = {
    team: `${team.city} ${team.name}`, record: record(league.season.standings[team.id]),
    ...(p ? { player: fullName(p), position: p.position, overall: p.overall, age: p.age } : {}), ...c.vars,
  };
  let id = `ev_${now}_${team.id}_${c.type}_${p?.id ?? c.coachId ?? 'team'}`;
  for (let n = 2; taken.has(id); n++) id = `ev_${now}_${team.id}_${c.type}_${p?.id ?? c.coachId ?? 'team'}_${n}`;
  taken.add(id);
  return {
    id, year: league.season.year, week, type: c.type, teamId: team.id,
    playerId: p?.id ?? null, coachId: c.coachId, title: renderTemplate(tpl.title, vars), description: renderTemplate(tpl.description, vars),
    choices: eventChoices(c.type), resolvedChoice: null, read: false, data: { ...c.data, raisedAt: now, defaultChoice: tpl.defaultChoice },
  };
};

/**
 * New events for the week just played (`week` is its phase-week). Pure: the events are returned, not added
 * (addEvents / advanceClubWeek append them). Deterministic for (league, week, rng seed).
 */
export const generateEvents = (league: League, week: number, rng: Rng, opts: GenerateEventsOptions = {}): FranchiseEvent[] => {
  const phase = opts.phase ?? league.season.phase;
  const now = leagueClock(league, phase, week);
  const ids = opts.teamIds ?? (league.userTeamId ? [league.userTeamId] : (Object.keys(league.teams) as TeamId[]));
  const taken = new Set(league.events.map((e) => e.id));
  const out: FranchiseEvent[] = [];
  for (const teamId of ids) {
    const team = league.teams[teamId];
    if (!team) continue;
    const st = league.season.standings[teamId];
    const ctx: Ctx = {
      league, team, phase, st, games: st ? gamesPlayed(st) : 0, capYear: leagueCapYear(league), rng: rng.fork(`events:${teamId}`),
      roster: team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => p !== undefined), records: opts.brokenRecords ?? [],
    };
    const typeOrder = (t: CatalogEventType): number => FRANCHISE_EVENT_TYPES.indexOf(t);
    const candidates = [...playerTriggers(ctx), ...teamTriggers(ctx)].sort((a, b) =>
      EVENT_CATALOG.types[b.type].priority - EVENT_CATALOG.types[a.type].priority || b.weight - a.weight || typeOrder(a.type) - typeOrder(b.type)
      || ((a.player?.id ?? '') < (b.player?.id ?? '') ? -1 : 1));
    const existing = league.events.filter((e) => e.teamId === teamId);
    const types = new Set<CatalogEventType>();
    let count = 0;
    for (const c of candidates) {
      if (count >= EVENT_CATALOG.limits.maxPerWeek) break;
      if (types.has(c.type) || blocked(existing, teamId, c, now)) continue;
      types.add(c.type);
      count++;
      out.push(toEvent(league, team, c, week, now, taken));
    }
  }
  return out;
};

/** Appends events to the League. */
export const addEvents = (league: League, events: readonly FranchiseEvent[]): League =>
  events.length ? { ...league, events: [...league.events, ...events] } : league;

/** Unresolved events, optionally for one team. */
export const pendingEvents = (league: League, teamId?: TeamId): FranchiseEvent[] =>
  league.events.filter((e) => e.resolvedChoice === null && (teamId === undefined || e.teamId === teamId));

/** Marks an event read. */
export const markEventRead = (league: League, eventId: string): League =>
  ({ ...league, events: league.events.map((e) => (e.id === eventId ? { ...e, read: true } : e)) });

/**
 * Resolves an event with a choice: applies the choice's effects and records it. Throws for an unknown or
 * already-resolved event and for a choice the event does not offer. Chance-based effects use `rng`
 * (default: a generator seeded from the league seed and the event id, so resolution is reproducible).
 */
export const resolveEvent = (league: League, eventId: string, choiceId: string, rng?: Rng, auto = false): League => {
  const event = league.events.find((e) => e.id === eventId);
  if (!event) throw new Error(`resolveEvent: unknown event ${eventId}`);
  if (event.resolvedChoice !== null) throw new Error(`resolveEvent: event ${eventId} is already resolved`);
  if (!event.choices.some((c) => c.id === choiceId)) throw new Error(`resolveEvent: event ${eventId} has no choice '${choiceId}'`);
  const applied = applyEventEffects(league, event, choiceId, rng ?? createRng(`${league.rngSeed}:event:${eventId}`));
  const done: FranchiseEvent = { ...event, resolvedChoice: choiceId, read: true, data: { ...event.data, ...(auto ? { autoResolved: true } : {}) } };
  return { ...applied, events: applied.events.map((e) => (e.id === eventId ? done : e)) };
};

/** Resolves every event left open for autoResolveWeeks (club clock) with its default choice. */
export const autoResolveEvents = (league: League, now: number = leagueClock(league)): League => {
  let out = league;
  for (const e of league.events) {
    if (e.resolvedChoice !== null || now - eventRaisedAt(e) < EVENT_CATALOG.limits.autoResolveWeeks) continue;
    out = resolveEvent(out, e.id, e.data?.defaultChoice ?? catalogTemplate(e.type)?.defaultChoice ?? 'noted', undefined, true);
  }
  return out;
};

/** Drops AI-team events older than keepAiEventYears seasons (user-team events are kept forever). */
export const pruneAiEvents = (league: League): League => {
  const cutoff = league.season.year - EVENT_CATALOG.limits.keepAiEventYears;
  const events = league.events.filter((e) => e.teamId === league.userTeamId || e.year >= cutoff || e.resolvedChoice === null);
  return events.length === league.events.length ? league : { ...league, events };
};

/** Generates events for AI teams and resolves each immediately with its default choice. */
const runAiEvents = (league: League, week: number, rng: Rng, opts: GenerateEventsOptions): League => {
  const aiIds = (Object.keys(league.teams) as TeamId[]).filter((id) => id !== league.userTeamId && !league.teams[id]?.isUserControlled);
  const fresh = generateEvents(league, week, rng, { ...opts, teamIds: aiIds });
  let out = addEvents(league, fresh);
  for (const e of fresh) out = resolveEvent(out, e.id, e.data?.defaultChoice ?? catalogTemplate(e.type)?.defaultChoice ?? 'noted', rng.fork(e.id), true);
  return pruneAiEvents(out);
};

/** What advanceClubWeek needs to know about the week just played. */
export interface ClubWeekContext {
  /** Games finished this week (WeekAdvanceResult.games). */
  games: readonly ScheduledGame[];
  /** Phase and phase-week that were played (the League may already have moved on). */
  phase: SeasonPhase;
  week: number;
  /** Records broken this week (WeekEvent 'record' entries). */
  brokenRecords?: readonly RecordBreak[];
  /** Default: the League rng (its state is written back). */
  rng?: Rng;
  /** Also run events for AI teams (resolved at once with the default choice). Default false. */
  aiEvents?: boolean;
}

/**
 * The club layer after a played week, in order: rivalry ledger, head-coach playoff records, roster moves
 * (fans/morale/tenure), fan reactions to the results (+ playoff berths), weekly fan drift, every team's finances (AI ticket re-pricing), weekly morale and chemistry,
 * auto-resolution of stale events and the new events for the user team. Returns the League and the new events.
 * Once per week: repeating the week processed last (ClubState.lastClubWeek) without a new game returns the
 * League unchanged, and so does the game-less preseason-to-regular-season transition "week" of week.ts.
 */
export const advanceClubWeek = (league: League, ctx: ClubWeekContext): { league: League; events: FranchiseEvent[] } => {
  const last = ensureClub(league).lastClubWeek;
  const sameWeek = !!last && last.year === league.season.year && last.phase === ctx.phase && last.week === ctx.week;
  if (sameWeek && ctx.games.every((g) => last.gameIds.includes(g.id))) return { league, events: [] };
  if (ctx.phase === 'preseason' && (ctx.week < 1 || ctx.week > league.settings.preseasonWeeks) && ctx.games.length === 0) return { league, events: [] };
  const rng = ctx.rng ?? leagueRng(league);
  const weekRng = rng.fork(`club:${league.season.year}:${ctx.phase}:${ctx.week}`);
  let out = updateRivalryLedger(league, ctx.games);
  out = recordCoachPlayoffResults(out, ctx.games);
  out = syncRosterMoves(out).league;
  out = applyGamesToFans(out, ctx.games);
  if (ctx.phase === 'regularSeason' && out.season.phase === 'playoffs' && out.season.bracket) {
    for (const id of Object.values(out.season.bracket.seeds).flat()) out = applyFanEvent(out, id, 'playoffs', 1);
  }
  out = decayAllFans(out);
  out = applyAllWeekFinances(out, { games: ctx.games, phase: ctx.phase });
  out = weeklyMoraleAll(out, ctx.week, { phase: ctx.phase });
  out = autoResolveEvents(out, leagueClock(out, ctx.phase, ctx.week));
  const opts: GenerateEventsOptions = { phase: ctx.phase, brokenRecords: ctx.brokenRecords ?? [] };
  const fresh = out.userTeamId ? generateEvents(out, ctx.week, weekRng.fork('user-events'), { ...opts, teamIds: [out.userTeamId] }) : [];
  out = addEvents(out, fresh);
  if (ctx.aiEvents) out = runAiEvents(out, ctx.week, weekRng.fork('ai-events'), opts);
  const gameIds = [...(sameWeek && last ? last.gameIds : []), ...ctx.games.map((g) => g.id as string)];
  out = withClub(out, { lastClubWeek: { year: league.season.year, phase: ctx.phase, week: ctx.week, gameIds } });
  return { league: ctx.rng ? out : withRngState(out, rng), events: fresh };
};

/**
 * The club layer on an offseason phase change (call after the phase moved): roster moves since the last
 * sync (draft picks, signings, trades), auto-resolution, and the phase's events (progression news,
 * holdouts, retirement announcements) for the user team.
 */
export const advanceClubPhase = (league: League, rng?: Rng): { league: League; events: FranchiseEvent[] } => {
  const r = rng ?? leagueRng(league);
  let out = syncRosterMoves(league).league;
  out = autoResolveEvents(out);
  const fresh = out.userTeamId ? generateEvents(out, out.season.week, r.fork(`club-phase:${out.season.year}:${out.season.phase}`), { teamIds: [out.userTeamId] }) : [];
  out = addEvents(out, fresh);
  return { league: rng ? out : withRngState(out, r), events: fresh };
};

/** Flags currently set for a team's players (for the UI and the roster AI). */
export const teamPlayerFlags = (league: League, teamId: TeamId): Record<string, string[]> => {
  const team = league.teams[teamId];
  const flags = ensureClub(league).playerFlags;
  const out: Record<string, string[]> = {};
  for (const id of team?.rosterIds ?? []) if (flags[id]?.length) out[id] = [...(flags[id] ?? [])];
  return out;
};

/** Everything closeClubSeason did. */
export interface ClubSeasonClose {
  league: League;
  /** The staff turnover, or null when it did not run (already done this offseason, or not requested). */
  staff: StaffYearReport | null;
}

/** Options of closeClubSeason. */
export interface CloseClubSeasonOptions {
  /** Run the staff turnover (staff.ts advanceStaffYear: coach aging, retirements, AI hires). Default true. An
   *  integrator that ages coaches elsewhere (retirement.ts runCoachCarousel) passes false. */
  staff?: boolean;
}

/**
 * The club layer's once-a-year close (call in the offseason phase, after the season's standings are final):
 * books closed, fan excitement reset from the finished season and the seasonal event flags cleared (once per
 * season, keyed by the finance history), the staff turnover (once per season, keyed by ClubState.staffYear, so
 * coaches never age twice however the close and the offseason orchestrator are combined) and AI facility
 * spending (bounded by the per-offseason upgrade limit). A second call for the same year changes nothing.
 */
export const closeClubSeason = (league: League, rng: Rng, opts: CloseClubSeasonOptions = {}): ClubSeasonClose => {
  const year = league.season.year;
  const booksOpen = !isFinancialYearClosed(league);
  const staffDue = (opts.staff ?? true) && ensureClub(league).staffYear !== year;
  if (!booksOpen && !staffDue) return { league, staff: null };
  let out = league;
  if (booksOpen) {
    out = closeFinancialYear(out);
    const teams = { ...out.teams };
    for (const t of Object.values(out.teams)) teams[t.id] = { ...t, fans: seasonFanReset(t, teamSeasonRecord(league, t.id)) };
    out = resetSeasonFlags({ ...out, teams });
  }
  let report: StaffYearReport | null = null;
  if (staffDue) {
    const staff = advanceStaffYear(out, rng.fork(`club-close:${year}`));
    out = withClub(staff.league, { staffYear: year });
    report = staff.report;
  }
  return { league: aiFacilityUpgrades(out), staff: report };
};
