/**
 * Offseason orchestrator. `runOffseasonStep` performs the current phase's work and then advances the calendar
 * through phase.ts `nextPhase` (trainingCamp -> preseason is phase.ts `startNewSeason`, the year rollover):
 *
 *   awards       computeAwards -> Season.awards (the SeasonSummary written when the phase ends carries them),
 *                first-team All-Pro recorded, end-of-season record pass (game/season/career/team)
 *   offseason    retirements -> Hall of Fame inductions -> aging (+1 age/experience) -> contract years synced to
 *                the cap year and expiring deals listed (free-agency prep) -> coaches: the club layer's
 *                once-a-year close (events.ts closeClubSeason: books, fans, seasonal flags, AI facility spending)
 *                plus the staff turnover (closeClubSeason's advanceStaffYear, or deps.coachCarousel when injected).
 *                Coach aging is keyed by ClubState.staffYear, so an integrator that also calls closeClubSeason
 *                (before or after) never ages coaches twice, whichever carousel is used
 *   resigning    user window; AI teams re-sign through deps.aiResign
 *   freeAgency   deps.runFreeAgency (all rounds)
 *   draft        deps.runDraft (the whole draft, UDFAs included)
 *   postDraft    deps.postDraft (final cuts / roster fill)
 *   trainingCamp offseasonProgression -> runTrainingCamp (choices from deps.campChoices)
 *
 * Free agency, the draft and the AI roster moves belong to parallel modules, so they are injected
 * (offseason-deps.ts standardOffseasonDeps wires the real ones); a missing
 * dependency is a no-op that leaves a warning in League.offseasonFlags.warnings (and the free-agency / draft phase
 * guards are then forced). The next cap is grown by the rollover itself; the checklist shows the projection.
 * Every task is recorded in offseasonFlags.done for the season year, so re-running a phase's work never applies it
 * twice. Events are returned and handed to deps.events (the events engine) when injected. Deterministic per Rng.
 */
import type { CoachId, PlayerId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { applyAwards, computeAwards, flagsFor, isTaskDone, markTask } from './awards';
import { contractEndYear, leagueCapYear, syncYearsRemaining } from './contracts';
import { closeClubSeason } from './events';
import { allProTeam, inductHallOfFamers, recordAllPros } from './hall-of-fame';
import { isNewRecordHolder, isRecordNews } from './history';
import { nextPhase, phaseBlocker } from './phase';
import { NOTABLE_PROGRESSION, advanceAges, offseasonProgression, type ProgressionReport } from './progression';
import { seasonEndRecords } from './records';
import { runRetirements, type CoachMove } from './retirement';
import { ensureClub, withClub } from './rivalries';
import { projectedCap } from './settings';
import { campInjuries, runTrainingCamp, type CampChoices, type CampReport } from './training-camp';
import type { AwardResult, HallOfFamer, League, LeagueRecord, SeasonPhase } from './types';

/** A League -> League phase dependency (free agency, draft, AI roster moves). */
export type OffseasonDep = (league: League, rng: Rng) => League;

/** Collaborators injected into the orchestrator (all optional). */
export interface OffseasonDeps {
  /** AI re-signing (e.g. gm/roster-ai runAiResigning). */
  aiResign?: OffseasonDep;
  /** Whole free agency (e.g. free-agency runFreeAgency). */
  runFreeAgency?: OffseasonDep;
  /** Whole draft including UDFAs (e.g. draft startDraft -> runDraftToEnd -> finishDraft). */
  runDraft?: OffseasonDep;
  /** Post-draft cuts / roster fill (e.g. gm/roster-fill aiFinalCuts). */
  postDraft?: OffseasonDep;
  /** Coach aging, retirements and hires; default: clubCoachCarousel (club layer). retirement.ts runCoachCarousel is the
   *  standalone alternative (the books are still closed by closeClubSeason; skipped when the staff already turned
   *  over this offseason). */
  coachCarousel?: (league: League, rng: Rng) => { league: League; moves: readonly CoachMove[] };
  /** Turns offseason events into FranchiseEvents (events engine). */
  events?: (league: League, events: readonly OffseasonEvent[]) => League;
  /** The user's camp decisions. */
  campChoices?: CampChoices | ((league: League) => CampChoices);
}

/** Something that happened during the offseason (for the events engine and the UI). */
export type OffseasonEvent =
  | { type: 'award'; award: AwardResult }
  | { type: 'recordBroken'; record: LeagueRecord; previous: LeagueRecord | null; headline: boolean }
  | { type: 'retirement'; playerId: PlayerId; teamId: TeamId | null; name: string; age: number; seasons: number }
  | { type: 'hallOfFame'; inductee: HallOfFamer }
  | { type: 'progression'; report: ProgressionReport }
  | { type: 'coachRetirement'; coachId: CoachId; teamId: TeamId; replacementId: CoachId | null }
  | { type: 'campInjury'; playerId: PlayerId; teamId: TeamId; severity: string; weeksOut: number };

/** What one phase's work produced. */
export interface OffseasonPhaseResult {
  league: League;
  /** Phase whose work ran. */
  phase: SeasonPhase;
  events: OffseasonEvent[];
  /** Warnings raised by this call (also kept in offseasonFlags.warnings). */
  warnings: string[];
  progression: ProgressionReport[];
  camp: CampReport[];
}

/** A phase's work plus the calendar move. */
export interface OffseasonStepResult extends OffseasonPhaseResult {
  /** Phase the League is in afterwards. */
  next: SeasonPhase;
}

/** Offseason phases in calendar order. */
export const OFFSEASON_STEP_PHASES: readonly SeasonPhase[] = ['awards', 'offseason', 'resigning', 'freeAgency', 'draft', 'postDraft', 'trainingCamp'];

/** Task keys recorded in offseasonFlags.done, per phase. */
export const PHASE_TASKS: Readonly<Record<string, readonly string[]>> = {
  awards: ['awards', 'allPro', 'records'],
  offseason: ['retirements', 'hallOfFame', 'aging', 'contracts', 'coaches'],
  resigning: ['resigning'],
  freeAgency: ['freeAgency'],
  draft: ['draft'],
  postDraft: ['postDraft'],
  trainingCamp: ['progression', 'camp'],
};

const TASK_LABELS: Readonly<Record<string, string>> = {
  awards: 'Season awards', allPro: 'All-Pro team', records: 'Record book', retirements: 'Retirements', hallOfFame: 'Hall of Fame class',
  aging: 'Players age a year', contracts: 'Contract years / expiring deals', coaches: 'Coaching carousel', resigning: 'Re-sign players',
  freeAgency: 'Free agency', draft: 'Draft', postDraft: 'Final cuts', progression: 'Player progression', camp: 'Training camp',
};

const DEP_OF: Readonly<Record<string, keyof OffseasonDeps>> = {
  resigning: 'aiResign', freeAgency: 'runFreeAgency', draft: 'runDraft', postDraft: 'postDraft',
};

/** Adds a warning to offseasonFlags (deduplicated). */
const warn = (league: League, year: number, message: string, out: string[]): League => {
  out.push(message);
  const f = flagsFor(league, year);
  return f.warnings.includes(message) ? league : { ...league, offseasonFlags: { ...f, warnings: [...f.warnings, message] } };
};

/** Contract bookkeeping: yearsRemaining synced to the cap year; rostered deals ending with the season listed. */
const syncContracts = (league: League): League => {
  const capYear = leagueCapYear(league);
  const players: League['players'] = { ...league.players };
  const expiring: PlayerId[] = [];
  for (const p of Object.values(league.players)) {
    if (!p.contract) continue;
    const c = syncYearsRemaining(p.contract, capYear);
    if (c !== p.contract) players[p.id] = { ...p, contract: c };
    if (p.teamId !== null && contractEndYear(p.contract) < capYear) expiring.push(p.id);
  }
  return markTask({ ...league, players }, league.season.year, 'contracts', { expiring: expiring.sort() });
};

/**
 * Default coach step: the club layer's yearly close (events.ts closeClubSeason, idempotent per season), reported as
 * CoachMoves for the staff members who retired from a team. Those coaches are kept in League.coaches (teamId null,
 * listed in club.retiredCoachIds and offseasonFlags.retiredCoaches) so the retirement events can reference them.
 */
export const clubCoachCarousel = (league: League, rng: Rng): { league: League; moves: CoachMove[] } => {
  const { league: closed, staff } = closeClubSeason(league, rng);
  if (!staff) return { league: closed, moves: [] };
  const coaches = { ...closed.coaches };
  const retiredIds = new Set(ensureClub(closed).retiredCoachIds);
  const moves: CoachMove[] = [];
  for (const id of [...staff.retired].sort()) {
    const before = league.coaches[id];
    if (!before?.teamId) continue;
    coaches[id] = { ...(coaches[id] ?? { ...before, age: before.age + 1 }), teamId: null, contractYears: 0 };
    retiredIds.add(id);
    const hire = staff.hired.find((h) => h.teamId === before.teamId && closed.coaches[h.coachId]?.role === before.role);
    moves.push({ retiredId: id, teamId: before.teamId, role: before.role, replacementId: hire?.coachId ?? null });
  }
  const flags = flagsFor(closed, closed.season.year);
  const retiredCoaches = [...new Set([...(flags.retiredCoaches ?? []), ...moves.map((m) => m.retiredId)])];
  const out = withClub({ ...closed, coaches }, { retiredCoachIds: [...retiredIds] });
  return { league: { ...out, offseasonFlags: { ...flags, retiredCoaches } }, moves };
};

/**
 * An injected coach carousel: the club year is closed without the club staff turnover, then the carousel runs once
 * per offseason (skipped when ClubState.staffYear says the coaches already aged this year).
 */
const injectedCarousel = (league: League, rng: Rng, carousel: NonNullable<OffseasonDeps['coachCarousel']>): { league: League; moves: readonly CoachMove[] } => {
  const closed = closeClubSeason(league, rng.fork('close'), { staff: false }).league;
  if (ensureClub(closed).staffYear === closed.season.year) return { league: closed, moves: [] };
  const r = carousel(closed, rng.fork('carousel'));
  return { league: withClub(r.league, { staffYear: closed.season.year }), moves: r.moves };
};

type Work = { league: League; events: OffseasonEvent[]; warnings: string[]; progression: ProgressionReport[]; camp: CampReport[] };

const task = (w: Work, year: number, key: string, run: (league: League) => League): void => {
  if (isTaskDone(w.league, year, key)) return;
  w.league = markTask(run(w.league), year, key);
};

const phaseDep = (w: Work, year: number, phase: SeasonPhase, deps: OffseasonDeps, rng: Rng): void => {
  const key = PHASE_TASKS[phase]?.[0] as string;
  const depName = DEP_OF[phase] as keyof OffseasonDeps;
  const dep = deps[depName] as OffseasonDep | undefined;
  if (isTaskDone(w.league, year, key)) return;
  if (!dep) {
    w.league = markTask(warn(w.league, year, `${phase}: no ${depName} dependency injected; phase skipped`, w.warnings), year, key);
    return;
  }
  w.league = markTask(dep(w.league, rng.fork(key)), year, key);
};

/**
 * Runs the current offseason phase's work (no calendar move). Idempotent per phase and season year. Throws in the
 * game phases (preseason, regular season, playoffs).
 */
export const runOffseasonPhase = (league: League, rng: Rng, deps: OffseasonDeps = {}): OffseasonPhaseResult => {
  const phase = league.season.phase;
  if (!OFFSEASON_STEP_PHASES.includes(phase)) throw new Error(`runOffseasonPhase: ${phase} is not an offseason phase`);
  const year = league.season.year;
  const prng = rng.fork(`offseason:${year}:${phase}`);
  const w: Work = { league, events: [], warnings: [], progression: [], camp: [] };
  switch (phase) {
    case 'awards':
      task(w, year, 'awards', (l) => {
        const awards = computeAwards(l);
        w.events.push(...awards.map((award): OffseasonEvent => ({ type: 'award', award })));
        return applyAwards(l, awards);
      });
      task(w, year, 'allPro', (l) => recordAllPros(l, allProTeam(l), year));
      task(w, year, 'records', (l) => {
        const r = seasonEndRecords(l);
        w.events.push(...r.broken.map((b): OffseasonEvent => ({ type: 'recordBroken', record: b.record, previous: b.previous, headline: isNewRecordHolder(b) && isRecordNews(l, b) })));
        return r.league;
      });
      break;
    case 'offseason':
      task(w, year, 'retirements', (l) => {
        const r = runRetirements(l, prng.fork('retirements'));
        w.events.push(...r.retired.map((x): OffseasonEvent => ({ type: 'retirement', playerId: x.playerId, teamId: x.teamId, name: x.name, age: x.age, seasons: x.seasons })));
        const f = flagsFor(r.league, year);
        return { ...r.league, offseasonFlags: { ...f, retired: [...f.retired, ...r.retired.map((x) => x.playerId)] } };
      });
      task(w, year, 'hallOfFame', (l) => {
        const r = inductHallOfFamers(l, year);
        w.events.push(...r.inducted.map((inductee): OffseasonEvent => ({ type: 'hallOfFame', inductee })));
        return r.league;
      });
      task(w, year, 'aging', advanceAges);
      task(w, year, 'contracts', syncContracts);
      task(w, year, 'coaches', (l) => {
        const r = deps.coachCarousel ? injectedCarousel(l, prng.fork('coaches'), deps.coachCarousel) : clubCoachCarousel(l, prng.fork('coaches'));
        w.events.push(...r.moves.map((m): OffseasonEvent => ({ type: 'coachRetirement', coachId: m.retiredId, teamId: m.teamId, replacementId: m.replacementId })));
        return r.league;
      });
      break;
    case 'resigning':
    case 'freeAgency':
    case 'draft':
    case 'postDraft':
      phaseDep(w, year, phase, deps, prng);
      break;
    default: {
      task(w, year, 'progression', (l) => {
        const r = offseasonProgression(l, prng.fork('progression'));
        w.progression = r.entries;
        w.events.push(...r.entries.filter((e) => NOTABLE_PROGRESSION.includes(e.kind)).map((report): OffseasonEvent => ({ type: 'progression', report })));
        return r.league;
      });
      task(w, year, 'camp', (l) => {
        const choices = typeof deps.campChoices === 'function' ? deps.campChoices(l) : (deps.campChoices ?? {});
        const r = runTrainingCamp(l, prng.fork('camp'), choices);
        w.camp = r.reports;
        w.events.push(...campInjuries(r.reports).map((i): OffseasonEvent => ({ type: 'campInjury', playerId: i.playerId, teamId: i.teamId, severity: i.severity, weeksOut: i.weeksOut })));
        return r.league;
      });
    }
  }
  if (w.events.length > 0) {
    if (deps.events) w.league = deps.events(w.league, w.events);
    else w.league = warn(w.league, year, 'events: no events dependency injected; offseason events were not posted', w.warnings);
  }
  return { league: w.league, phase, events: w.events, warnings: w.warnings, progression: w.progression, camp: w.camp };
};

/**
 * Runs the current phase's work, then advances one phase (trainingCamp -> preseason rolls the year over). When the
 * free-agency or draft dependency was not injected their phase guards are forced (the unfinished state is dropped
 * at rollover). Throws when a guard blocks (e.g. no champion yet).
 */
export const runOffseasonStep = (league: League, rng: Rng, deps: OffseasonDeps = {}): OffseasonStepResult => {
  const done = runOffseasonPhase(league, rng, deps);
  const phase = done.phase;
  const depName = DEP_OF[phase];
  const force = (phase === 'freeAgency' || phase === 'draft') && depName !== undefined && !deps[depName];
  const moved = nextPhase(done.league, { force });
  return { ...done, league: moved, next: moved.season.phase };
};

/** Runs every remaining offseason step until the next preseason (or until `stopAt` is reached). */
export const runOffseason = (league: League, rng: Rng, deps: OffseasonDeps = {}, opts: { stopAt?: SeasonPhase } = {}): OffseasonStepResult => {
  let out: OffseasonStepResult | null = null;
  let current = league;
  const acc: Omit<OffseasonPhaseResult, 'league' | 'phase'> = { events: [], warnings: [], progression: [], camp: [] };
  for (let guard = 0; guard < OFFSEASON_STEP_PHASES.length && OFFSEASON_STEP_PHASES.includes(current.season.phase); guard++) {
    if (opts.stopAt && current.season.phase === opts.stopAt) break;
    out = runOffseasonStep(current, rng.fork(`step:${current.season.phase}`), deps);
    acc.events.push(...out.events);
    for (const w of out.warnings) if (!acc.warnings.includes(w)) acc.warnings.push(w);
    acc.progression.push(...out.progression);
    acc.camp.push(...out.camp);
    current = out.league;
  }
  return { league: current, phase: out?.phase ?? current.season.phase, next: current.season.phase, ...acc };
};

/* -------------------------------------------------------------- checklist */

/** Status of one checklist line. */
export type ChecklistStatus = 'done' | 'pending' | 'upcoming' | 'skipped' | 'blocked' | 'info';

/** One line of the offseason checklist. */
export interface ChecklistItem {
  phase: SeasonPhase;
  key: string;
  label: string;
  status: ChecklistStatus;
  detail: string;
}

const userDetail = (league: League, key: string): string => {
  const team = league.userTeamId ? league.teams[league.userTeamId] : undefined;
  const year = league.season.year;
  switch (key) {
    case 'resigning': {
      if (!team) return '';
      const n = team.rosterIds.filter((id) => { const c = league.players[id]?.contract; return !c || contractEndYear(c) <= year; }).length;
      return `${n} expiring contract(s) on your roster`;
    }
    case 'freeAgency':
      return league.freeAgency ? `round ${Math.min(league.freeAgency.round, league.freeAgency.maxRounds)} of ${league.freeAgency.maxRounds}` : 'not started';
    case 'draft': {
      const d = league.draft;
      if (!d || d.year !== year) return 'not started';
      const mine = d.order.slice(d.currentPickIndex).filter((p) => p.ownerTeamId === league.userTeamId).length;
      return d.complete ? 'complete' : `${mine} pick(s) left for your team`;
    }
    case 'postDraft':
      return team ? `${team.rosterIds.length}/${league.settings.rosterSize} on your roster${team.rosterIds.length > league.settings.rosterSize ? ` - cut ${team.rosterIds.length - league.settings.rosterSize}` : ''}` : '';
    case 'contracts':
      return `${league.offseasonFlags?.year === year ? league.offseasonFlags.expiring.length : 0} expiring league-wide; next cap $${Math.round(projectedCap(league.settings, 1) / 1e6)}M`;
    case 'retirements':
      return league.offseasonFlags?.year === year ? `${league.offseasonFlags.retired.length} retired` : '';
    default:
      return '';
  }
};

/**
 * What the offseason still needs, for the UI: every task of every offseason phase with its status (done /
 * pending in the current phase / upcoming / skipped), user-facing details (expiring deals, FA round, draft picks,
 * roster count), the current phase blocker and any warnings. Empty outside the offseason.
 */
export const offseasonChecklist = (league: League): ChecklistItem[] => {
  const phase = league.season.phase;
  const idx = OFFSEASON_STEP_PHASES.indexOf(phase);
  if (idx < 0) return [];
  const year = league.season.year;
  const items: ChecklistItem[] = [];
  OFFSEASON_STEP_PHASES.forEach((p, i) => {
    for (const key of PHASE_TASKS[p] ?? []) {
      const done = isTaskDone(league, year, key);
      const status: ChecklistStatus = done ? 'done' : i < idx ? 'skipped' : i === idx ? 'pending' : 'upcoming';
      items.push({ phase: p, key, label: TASK_LABELS[key] ?? key, status, detail: userDetail(league, key) });
    }
  });
  const blocker = phaseBlocker(league);
  if (blocker) items.push({ phase, key: 'advance', label: 'Advance to the next phase', status: 'blocked', detail: blocker });
  for (const w of league.offseasonFlags?.year === year ? league.offseasonFlags.warnings : []) items.push({ phase, key: 'warning', label: 'Warning', status: 'info', detail: w });
  return items;
};
