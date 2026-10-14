import type { CoachId, GameId, PlayerId, StadiumId, TeamId } from '@/core/ids';
import type { RngState } from '@/core/rng';
import type { AttributeSet, ContractRole, DevTrait, PersonalityTrait, Player } from '@/players/types';
import type { DefensivePlay, OffensivePlay, Playbook } from '@/playbook/types';
import type { Coach, DraftPick, Stadium, Team } from '@/teams/types';
import type { DifficultyProfile, GameInjury, PlayLogEntry, Ruleset, WeatherState } from '@/game/types';
import type { CareerStats, GameStats, PlayerStatLine, TeamStatLine } from '@/statistics/types';
import type { ClubFinanceRecord, CompactPlay, ExtensionTalks, PracticePlan, RosterTenure } from './club-types';
export type { ClubFinanceRecord, CompactPlay, ExtensionTalks, PracticePlan, RosterTenure } from './club-types';

export type { Coach, CoachRatings, CoachTrait, StaffRole } from '@/teams/types';

export type SeasonPhase =
  | 'preseason' | 'regularSeason' | 'playoffs' | 'awards' | 'offseason'
  | 'resigning' | 'freeAgency' | 'draft' | 'postDraft' | 'trainingCamp';

/** Cycle order. The year rolls over (and a fresh Season is created) on trainingCamp -> preseason. */
export const SEASON_PHASE_ORDER: readonly SeasonPhase[] = [
  'preseason', 'regularSeason', 'playoffs', 'awards', 'offseason',
  'resigning', 'freeAgency', 'draft', 'postDraft', 'trainingCamp',
];

export interface PlayoffFormat {
  teamsPerConference: number;
  byesPerConference: number;
  roundNames: string[];
}

export interface LeagueSettings {
  teamCount: number;
  regularSeasonWeeks: number;
  byeWeeks: boolean;
  playoff: PlayoffFormat;
  /** Current-year cap; the offseason step grows it by capGrowthRate. Year N projection = salaryCap * (1+rate)^N. */
  salaryCap: number;
  /** League year whose cap `salaryCap` is, once the offseason has grown it for the coming season; absent = league.year. */
  salaryCapYear?: number;
  capGrowthRate: number;
  minimumSalary: number;
  rosterSize: number;
  activeRosterSize: number;
  draftRounds: number;
  /** Regular-season week; trades allowed while phase==='regularSeason' && week <= tradeDeadlineWeek, and in all offseason phases. */
  tradeDeadlineWeek: number;
  ruleset: Ruleset;
  difficulty: DifficultyProfile;
  /** User-facing toggles. League creation and every game setup MUST copy these into ruleset.injuries/fatigue;
   *  the engine and fast-sim read ONLY Ruleset. Franchise-level rolls (week advance, camp) read these. */
  injuriesEnabled: boolean;
  fatigueEnabled: boolean;
  weatherEnabled: boolean;
  preseasonWeeks: number;
  conferences: string[];
  divisionsPerConference: number;
}

export interface GameResult {
  homeScore: number;
  awayScore: number;
  overtime: boolean;
  stats: GameStats;
  weather: WeatherState;
  injuries: GameInjury[];
  /** Key into League.playLogs (= the ScheduledGame id); null when auto-simmed without a stored log. */
  playLogId: string | null;
  /**
   * Quarter length (seconds) the game was played at: the league's live length for a game the user played, the
   * simulated length (settings.ts LEAGUE_SIM_QUARTER_SEC) otherwise. Absent in older saves (treated as full length).
   */
  quarterLengthSec?: number;
}

export interface ScheduledGame {
  id: GameId;
  /** Per-phase week (same convention as Season.week). Playoff games: week === playoffRound. */
  week: number;
  home: TeamId;
  away: TeamId;
  isPlayoff: boolean;
  playoffRound: number | null;
  isPreseason: boolean;
  result: GameResult | null;
}

export interface Standing {
  teamId: TeamId;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  divisionWins: number;
  divisionLosses: number;
  conferenceWins: number;
  conferenceLosses: number;
  streak: number;
  results: ('W' | 'L' | 'T')[];
}

export interface BracketMatchup {
  round: number;
  higherSeed: TeamId | null;
  lowerSeed: TeamId | null;
  winner: TeamId | null;
  gameId: GameId | null;
  conference: string | null;
}

export interface PlayoffBracket {
  seeds: Record<string, TeamId[]>;
  matchups: BracketMatchup[];
  champion: TeamId | null;
}

export interface Season {
  /** League year. Increments when phase moves trainingCamp -> preseason. League.year mirrors it. */
  year: number;
  phase: SeasonPhase;
  /** 1-based week WITHIN the current phase (preseason 1..preseasonWeeks, regularSeason 1..regularSeasonWeeks,
   *  playoffs 1..roundNames.length). 0 in non-game phases. With byeWeeks the regular-season calendar has one
   *  extra week (1..regularSeasonWeeks + 1; franchise/settings.ts scheduleWeekCount). */
  week: number;
  schedule: ScheduledGame[];
  standings: Record<TeamId, Standing>;
  bracket: PlayoffBracket | null;
  champion: TeamId | null;
  awards: AwardResult[];
  /** Regular season only. */
  stats: Record<PlayerId, PlayerStatLine>;
  playoffStats: Record<PlayerId, PlayerStatLine>;
  teamStats: Record<TeamId, TeamStatLine>;
}

export interface ScoutingReport {
  prospectId: PlayerId;
  overallRange: [number, number];
  potentialRange: [number, number];
  /** Letter grade A+..F derived from the team's scouted view. */
  grade: string;
  /** 0..1 confidence; higher scouting investment tightens ranges. */
  confidence: number;
  attributeEstimates: Partial<AttributeSet>;
  devTraitEstimate: DevTrait | null;
  /** Revealed by interviews. */
  traitsRevealed: PersonalityTrait[];
  notes: string[];
  interviewed: boolean;
  redFlags: string[];
}

export interface CombineResults {
  fortyYard: number;
  benchReps: number;
  vertical: number;
  broadJump: number;
  shuttle: number;
  threeCone: number;
}

export interface Prospect {
  /** Ground truth. Only franchise/draft (report generation, selection) and player generation may read
   *  attrs/potential/devTrait/traits. UI and GM AI must read DraftState.reports[teamId][prospectId].
   *  Prospects exist ONLY here until drafted/signed, when the Player moves into League.players. */
  player: Player;
  combine: CombineResults;
  proDay: Partial<CombineResults> | null;
  /** League-wide consensus projection (imperfect). A value above LeagueSettings.draftRounds means "projected undrafted". */
  projectedRound: number;
  college: string;
  /** 1-based league-wide consensus rank (imperfect, public). Additive; absent on classes generated before it. */
  consensusRank?: number;
}

export interface DraftState {
  year: number;
  order: DraftPick[];
  currentPickIndex: number;
  prospects: Prospect[];
  selections: { pick: DraftPick; playerId: PlayerId }[];
  reports: Record<TeamId, Record<PlayerId, ScoutingReport>>;
  /** scoutQuality (additive, 1..99) is the team's scouting-department quality captured when points were granted;
   *  accuracy (additive, 0..0.5) is the analytics department's share taken off every report's error (facilities.ts
   *  scoutingAccuracy), captured at the same time. Absent = 0. */
  scouting: Record<TeamId, { pointsAvailable: number; invested: Record<PlayerId, number>; scoutQuality?: number; accuracy?: number }>;
  userBoard: PlayerId[];
  complete: boolean;
  /** Additive: stable seed for per-team report noise and scouting bias (absent on older saves; the year is used). */
  seed?: number;
  /** Additive: undrafted prospects signed as UDFAs when the draft finished (teamId) or released to free agency (null). */
  undrafted?: { playerId: PlayerId; teamId: TeamId | null }[];
}

export type OfferStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'countered';

export type TradeAsset = { kind: 'player'; playerId: PlayerId } | { kind: 'pick'; pick: DraftPick };

export interface TradeOffer {
  id: string;
  fromTeam: TeamId;
  toTeam: TeamId;
  fromAssets: TradeAsset[];
  toAssets: TradeAsset[];
  status: OfferStatus;
  year: number;
  week: number;
  initiatedBy: TeamId;
}

export interface TradeEvaluation {
  accepted: boolean;
  valueGiven: number;
  valueReceived: number;
  reason: string;
  counterSuggestion: string | null;
  /** Actionable counter the user can accept/reject. */
  counterOffer: TradeOffer | null;
}

export interface FreeAgentOffer {
  id: string;
  teamId: TeamId;
  playerId: PlayerId;
  salary: number;
  years: number;
  guaranteed: number;
  signingBonus: number;
  role: ContractRole;
  round: number;
  status: OfferStatus;
}

/** A user-run team's negotiation with one free agent during free agency (franchise/fa-talks.ts). */
export interface FreeAgentTalks {
  teamId: TeamId;
  playerId: PlayerId;
  /** Bidding rounds in which he refused the team's offer on merit. */
  rounds: number;
  /** Refused offers that were far below his bar. */
  lowballs: number;
  /** Patience with the team 0..1: every refused round wears it down, lowballs more. */
  patience: number;
  /** True once he walked away: he takes no more offers from this team this free agency. */
  walkedAway: boolean;
  /** Bidding round of the last refused offer (0 before any). */
  lastRound: number;
}

export interface FreeAgencyState {
  round: number;
  maxRounds: number;
  offers: FreeAgentOffer[];
  signings: { playerId: PlayerId; teamId: TeamId; round: number }[];
  /** Additive: user teams' talks with free agents, keyed `${teamId}:${playerId}` (missing = no talks yet). */
  talks?: Record<string, FreeAgentTalks>;
}

export type FranchiseEventType =
  | 'tradeDemand' | 'extensionRequest' | 'rookieBreakout' | 'veteranDecline' | 'playerSlump' | 'playerJump'
  | 'lockerRoomConflict' | 'injury' | 'coachDisagreement' | 'targetsRequest' | 'unhappyPlayer'
  | 'winningStreak' | 'losingStreak' | 'rivalryGame' | 'recordBroken' | 'holdout' | 'retirementAnnounced'
  | 'fanUnrest' | 'sponsorOffer'
  | NewsEventType;

/**
 * Additive: informational news items (franchise/news.ts). They are not in the event catalog (no choices to make,
 * no effects, no cooldowns): created already resolved with a single 'noted' choice, unread. Leagues saved before
 * these types carry their news under borrowed catalog types; news.ts newsKindOf reads both.
 */
export type NewsEventType =
  | 'newsSigning' | 'newsTrade' | 'newsInjury' | 'newsRecord' | 'newsMilestone' | 'newsAward' | 'newsCoaching'
  | 'newsRetirement' | 'newsDraft';

export interface EventChoice {
  id: string;
  label: string;
  description: string;
}

export interface FranchiseEvent {
  id: string;
  year: number;
  week: number;
  type: FranchiseEventType;
  teamId: TeamId;
  playerId: PlayerId | null;
  coachId: CoachId | null;
  title: string;
  description: string;
  choices: EventChoice[];
  resolvedChoice: string | null;
  read: boolean;
  /** Additive (club layer, franchise/events.ts): machine-readable context for effects, dedupe and auto-resolution.
   *  Absent on events created before it. */
  data?: FranchiseEventData;
}

/** Machine-readable context of a FranchiseEvent (all optional). */
export interface FranchiseEventData {
  /** Once-only subject (record key, progression entry, streak start...): an event with the same key never repeats. */
  subjectKey?: string;
  /** Money involved in dollars (sponsor offer, holdout ask). */
  amount?: number;
  /** Monotonic club clock (events.ts leagueClock) when the event was raised; auto-resolution counts from here. */
  raisedAt?: number;
  /** Choice applied when the event is left unresolved. */
  defaultChoice?: string;
  /** True when the default choice was applied automatically. */
  autoResolved?: boolean;
  /** Other team involved (rivalry opponent). */
  otherTeamId?: TeamId;
  /** Game involved (upcoming rivalry game). */
  gameId?: GameId;
}

export type AwardType = 'MVP' | 'OPOY' | 'DPOY' | 'OROY' | 'DROY' | 'COY' | 'bestQB' | 'bestRB' | 'bestWR' | 'bestDefender';

export interface AwardResult {
  award: AwardType;
  year: number;
  playerId: PlayerId | null;
  coachId: CoachId | null;
  teamId: TeamId;
  summary: string;
}

export interface HallOfFamer {
  playerId: PlayerId;
  inductedYear: number;
  name: string;
  position: string;
  seasons: number;
  peakOverall: number;
  championships: number;
  awards: AwardResult[];
  careerStats: PlayerStatLine;
  teams: TeamId[];
}

export type RecordScope = 'game' | 'season' | 'career' | 'team';

export interface LeagueRecord {
  key: string;
  label: string;
  scope: RecordScope;
  value: number;
  holderPlayerId: PlayerId | null;
  holderTeamId: TeamId | null;
  holderName: string;
  year: number;
}

export interface SeasonSummary {
  year: number;
  champion: TeamId;
  runnerUp: TeamId;
  mvp: PlayerId | null;
  standings: Record<TeamId, { wins: number; losses: number; ties: number }>;
  awards: AwardResult[];
}

export interface League {
  id: string;
  name: string;
  settings: LeagueSettings;
  year: number;
  teams: Record<TeamId, Team>;
  /** Active + free-agent players. A player is in exactly ONE of players / retiredPlayers; retirement MOVES the
   *  record. Lookups must use `league.players[id] ?? league.retiredPlayers[id]`. */
  players: Record<PlayerId, Player>;
  retiredPlayers: Record<PlayerId, Player>;
  coaches: Record<CoachId, Coach>;
  stadiums: Record<StadiumId, Stadium>;
  season: Season;
  freeAgentIds: PlayerId[];
  draft: DraftState | null;
  freeAgency: FreeAgencyState | null;
  pendingTrades: TradeOffer[];
  userTeamId: TeamId | null;
  history: SeasonSummary[];
  records: LeagueRecord[];
  hallOfFame: HallOfFamer[];
  events: FranchiseEvent[];
  careerStats: Record<PlayerId, CareerStats>;
  /** User-authored content that travels with the save. The playbook loader resolves ids against data JSON first, then these. */
  customPlaybooks: Playbook[];
  customOffensePlays: OffensivePlay[];
  customDefensePlays: DefensivePlay[];
  /** Stored play-by-play keyed by GameResult.playLogId (week.ts storedPlayLog: without per-play stat deltas and
   *  fatigue maps). Pruned at rollover to user-team and playoff games. */
  playLogs: Record<string, PlayLogEntry[]>;
  /** Compact play-by-play (CompactPlay, built by franchise/play-text.ts) of games without a full log, keyed by ScheduledGame id: every
   *  AI-vs-AI game of the current and the previous season. Optional (older saves have none). */
  playSummaries?: Record<string, CompactPlay[]>;
  rngSeed: number;
  rngState: RngState;
  /** Save-format version for migrations. */
  version: number;
  /** Club-layer state (rivalry ledger, event flags, staff dead money...). Absent on leagues created before it; see ClubState. */
  club?: ClubState;
  /** Residual fatigue 0..1 per player carried between game weeks (written by franchise/week.ts after each week's
   *  games and weekly recovery; only non-trivial values are kept). Absent or missing entry = fully rested. */
  fatigue?: Record<PlayerId, number>;
  /** Additive (franchise/offseason.ts): per-offseason idempotency flags plus honours bookkeeping (All-Pro history,
   *  retired coaches, preseason rating snapshot). Absent on leagues created before it. */
  offseasonFlags?: OffseasonFlags;
}

/* ------------------------------ Offseason (additive) ------------------------------ */
/**
 * Offseason bookkeeping owned by src/franchise/offseason.ts (and the awards / retirement / camp modules it drives).
 * `year`, `done`, `warnings`, `retired` and `expiring` describe ONE offseason (reset when the awards of the next
 * season are handed out); the remaining fields persist across seasons.
 */
export interface OffseasonFlags {
  /** Season year whose offseason the per-offseason fields describe. */
  year: number;
  /** Offseason work already applied for `year` (task keys such as awards, retirements, camp); guards re-runs. */
  done: string[];
  /** Non-fatal notes, e.g. a phase dependency that was not injected and therefore skipped. */
  warnings: string[];
  /** Players who retired during this offseason. */
  retired: PlayerId[];
  /** Rostered players whose contracts end with season `year` (re-signing / free-agency prep). */
  expiring: PlayerId[];
  /** Team overall at the end of training camp, keyed by TeamId: the expectation baseline for coach of the year. */
  preseasonRatings?: { year: number; ratings: Record<string, number> };
  /** First-team All-Pro selection years per PlayerId (persists; feeds the Hall of Fame score). */
  allPro?: Record<string, number[]>;
  /** Coaches retired by the offseason coach carousel (kept in League.coaches because awards reference them). */
  retiredCoaches?: CoachId[];
  /** Last in-season weekly development pass applied (guards double application of weeklyDevelopment). */
  lastWeeklyDevelopment?: { year: number; week: number };
}

/* ------------------------------ Club layer (additive) ------------------------------ */
/**
 * Club-layer state owned by src/franchise/{staff,facilities,finances,fans,rivalries,events}.ts. Optional on
 * League so leagues created before the club layer keep loading; every club function reads it through
 * `ensureClub` and writes a complete object back.
 */
export type PlayerFlag = 'tradeBlock' | 'holdout' | 'extensionTalks' | 'retiring' | 'disgruntled' | 'targetsPromised';

/** Head-to-head history between two teams; the key is the two ids sorted and joined with '|'. */
export interface RivalryLedgerEntry {
  /** Sorted pair. */
  teams: [TeamId, TeamId];
  meetings: number;
  /** Decided by 7 points or fewer (or overtime). */
  closeGames: number;
  playoffMeetings: number;
  /** Wins by teams[0] and teams[1]. */
  wins: [number, number];
  ties: number;
  lastYear: number;
  /** Signed margin of the last meeting from teams[0]'s perspective. */
  lastMargin: number;
  /** Additive: id of the last game folded in (guards against applying the same game twice). */
  lastGameId?: string;
}

export interface ClubState {
  rivalries: Record<string, RivalryLedgerEntry>;
  /** Event-driven flags per PlayerId (trade block, holdout, ...). */
  playerFlags: Record<string, PlayerFlag[]>;
  /** Cash owed to fired coaches, per TeamId then season year. */
  staffDeadMoney: Record<string, Record<number, number>>;
  /** Facility upgrades bought in the current offseason, per TeamId. */
  facilityUpgrades: Record<string, { year: number; count: number }>;
  /** Cash the owner injected to keep a team above the cash floor, per TeamId (lowers owner confidence). */
  ownerSubsidy: Record<string, number>;
  /** Additive: owner patience 0..100 per TeamId carried between seasons (finances.ts ownerConfidence). */
  ownerConfidence?: Record<string, number>;
  /** Additive: roster tenure per PlayerId (continuity for chemistry, trade/signing detection). */
  tenure?: Record<string, RosterTenure>;
  /** Additive: retired coaches kept in League.coaches only because events or awards still reference them. */
  retiredCoachIds?: string[];
  /** Additive: head-coach playoff wins/losses per CoachId (regular-season records live on Coach). */
  coachPlayoffRecord?: Record<string, { wins: number; losses: number }>;
  /** Additive: closed seasons of books per TeamId, oldest first (last 10 kept). */
  financeHistory?: Record<string, ClubFinanceRecord[]>;
  /** Additive: event-driven chemistry adjustment per TeamId; decays weekly toward 0. */
  chemistryBonus?: Record<string, number>;
  /** Additive: home games played this season and summed attendance share per TeamId (reset at season close). */
  attendance?: Record<string, { games: number; pctSum: number }>;
  /** Additive: season year whose offseason staff turnover (coach aging) already ran (0 = never); guards double aging. */
  staffYear?: number;
  /** Additive: the last week advanceClubWeek processed and its games (repeating that week with no new game is a no-op). */
  lastClubWeek?: { year: number; phase: SeasonPhase; week: number; gameIds: string[] } | null;
  /** Additive: contract-extension talks per PlayerId for the current season (franchise/extension-talks.ts). */
  extensionTalks?: Record<string, ExtensionTalks>;
  /** Additive: in-season weekly practice plan per TeamId (franchise/practice-plan.ts); absent = 'normal'. */
  practicePlan?: Record<string, PracticePlan>;
}
