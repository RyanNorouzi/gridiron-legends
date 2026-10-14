/**
 * Pure helpers behind the game session: result / play-by-play text, penalty prompt wording, the defensive
 * control-role list, live-play metadata (receiver slots, materialized routes) and play-call requests.
 */
import type { Rng } from '@/core/rng';
import type { CameraContext } from '@/core/settings';
import type { FoulType, PenaltyInfo } from '@/game/play-events';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import { halfOf } from '@/game/game-state';
import { betweenPlayPhase } from '@/game/rules';
import { isNullifying, isReturnFoul } from '@/game/rules/penalties';
import { formatDown } from '@/game/rules/downs';
import { otherSide, type GameSetup, type GameState, type PendingDecision, type PlayLogEntry, type TeamSide } from '@/game/types';
import { materializePlay, type PlaybookRegistry } from '@/playbook/loader';
import { isSpecialPlay } from '@/playbook/special-teams';
import { receiverSlots, type DefensivePlay, type OffensivePlay, type RouteDef } from '@/playbook/types';
import { shortName } from '@/players/types';
import { kickKindOf, nullifyingFoul, scoredTouchdown } from './highlights';
import { fourthDownChoice, situationFor } from './playcaller';
import type { IntermissionReason, LivePlayMeta, PenaltyPrompt, PlaycallRequest, Playcaller, PostPlaySummary } from './session-types';

const FOUL_NAMES: Readonly<Record<FoulType, string>> = {
  falseStart: 'FALSE START', offsides: 'OFFSIDES', encroachment: 'ENCROACHMENT', delayOfGame: 'DELAY OF GAME',
  illegalFormation: 'ILLEGAL FORMATION', tooManyMen: 'TOO MANY MEN', illegalMotion: 'ILLEGAL MOTION', illegalShift: 'ILLEGAL SHIFT',
  offsideFreeKick: 'OFFSIDE ON THE KICK', holdingOffense: 'HOLDING', holdingDefense: 'DEFENSIVE HOLDING',
  passInterferenceOffense: 'OFFENSIVE PASS INTERFERENCE', passInterferenceDefense: 'PASS INTERFERENCE', facemask: 'FACEMASK',
  roughingPasser: 'ROUGHING THE PASSER', unnecessaryRoughness: 'UNNECESSARY ROUGHNESS', intentionalGrounding: 'INTENTIONAL GROUNDING',
  illegalBlockInBack: 'ILLEGAL BLOCK IN THE BACK', illegalContact: 'ILLEGAL CONTACT', horseCollar: 'HORSE COLLAR',
  illegalForwardPass: 'ILLEGAL FORWARD PASS', roughingKicker: 'ROUGHING THE KICKER', runningIntoKicker: 'RUNNING INTO THE KICKER',
  kickCatchInterference: 'KICK CATCH INTERFERENCE', illegalTouching: 'ILLEGAL TOUCHING', unsportsmanlike: 'UNSPORTSMANLIKE CONDUCT',
  taunting: 'TAUNTING',
};

/** Display name of a foul. */
export const foulName = (foul: FoulType): string => FOUL_NAMES[foul];

const signed = (n: number): string => (n >= 0 ? `+${Math.round(n)}` : `${Math.round(n)}`);

/** How a kick ended when nobody returned it (touchback, fair catch, out of bounds), as a headline suffix; null for a return. */
const kickEnding = (o: PlayOutcome): string | null => {
  const has = (t: string): boolean => o.events.some((e) => e.type === t);
  if (has('touchback')) return ' · TOUCHBACK';
  if (has('fairCatch')) return ' · FAIR CATCH';
  if (o.returnYards === 0 && o.events.some((e) => e.type === 'outOfBounds' && e.athlete === null)) return ' · OUT OF BOUNDS';
  return null;
};

/** Headline for a finished play, from the applied outcome (penalty-aware). */
export const resultText = (o: PlayOutcome, special: PlayContext['special'] | 'none' = 'none'): string => {
  const accepted = o.penalties.filter((p) => p.accepted);
  if (o.result === 'penalty') return accepted[0] ? `FLAG · ${foulName(accepted[0].foul)}` : 'NO PLAY';
  if (o.safety) return 'SAFETY';
  if (o.touchdown) {
    const wiped = nullifyingFoul(o);
    if (wiped) return `NO TOUCHDOWN · FLAG · ${foulName(wiped.foul)}`;
    return o.turnover ? 'DEFENSIVE TOUCHDOWN' : 'TOUCHDOWN';
  }
  switch (o.result) {
    case 'interception': return `INTERCEPTION${o.returnYards ? ` · RETURNED ${Math.round(o.returnYards)}` : ''}`;
    case 'sack': return `SACK ${signed(o.yards)}`;
    case 'incomplete': return 'INCOMPLETE';
    case 'kneel': return 'KNEEL DOWN';
    case 'spike': return 'SPIKE · CLOCK STOPPED';
    // kickMade null: no kick happened (the holder was tackled or the snap was lost).
    case 'fieldGoal': return o.kickMade === true ? `FIELD GOAL GOOD · ${Math.round(o.kickDistance ?? 0)} YDS` : o.kickMade === false ? 'FIELD GOAL NO GOOD' : 'FIELD GOAL TRY STOPPED';
    case 'extraPoint': return o.kickMade === true ? 'EXTRA POINT GOOD' : o.kickMade === false ? 'EXTRA POINT NO GOOD' : 'EXTRA POINT TRY STOPPED';
    case 'twoPoint': return o.points === 2 || (o.endBallOn >= 100 && !o.turnover) ? 'TWO-POINT GOOD' : 'TWO-POINT FAILED';
    case 'punt': return o.turnover ? 'PUNT · MUFFED & RECOVERED' : `PUNT ${Math.round(o.kickDistance ?? 0)} YDS${kickEnding(o) ?? (o.returnYards ? ` · RETURN ${signed(o.returnYards)}` : '')}`;
    case 'kickoff': return o.turnover ? 'KICKOFF · RECOVERED' : `KICKOFF${kickEnding(o) ?? (o.returnYards !== 0 ? ` · RETURN ${signed(o.returnYards)}` : ' · NO RETURN')}`;
    case 'onside': return o.turnover ? 'ONSIDE KICK · RECOVERED' : 'ONSIDE KICK · FAILED';
    default: break;
  }
  const fumbled = o.turnoverType === 'fumble' ? ' · FUMBLE LOST' : '';
  const kind = o.result === 'pass' ? 'PASS' : o.result === 'scramble' ? 'SCRAMBLE' : 'RUN';
  const fd = o.firstDown && !o.turnover ? ' · 1ST DOWN' : '';
  const flag = accepted.length > 0 ? ` · FLAG` : '';
  const kindLabel = special !== 'none' && special !== 'twoPoint' ? 'FAKE ' : '';
  return `${kindLabel}${kind} ${signed(o.yards)}${fumbled}${fd}${flag}`;
};

const playerName = (setup: GameSetup, id: string | null): string | null => {
  if (!id) return null;
  const p = setup.home.players[id as keyof typeof setup.home.players] ?? setup.away.players[id as keyof typeof setup.away.players];
  return p ? shortName(p) : null;
};

/** Sentence case for an all-caps headline ("FIELD GOAL GOOD · 44 YDS" -> "Field goal good, 44 yds"). */
const sentence = (headline: string): string => {
  const t = headline.toLowerCase().replace(/ · /g, ', ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * One clean play-by-play line built from the applied outcome's facts (names, rounded yards, kick distance). Used
 * when the executor produced no lines, and as the post-play caption: the executor's own last line is often only
 * "First down." or a raw dead-ball note, which says nothing about the play.
 */
export const generatedPbp = (setup: GameSetup, entry: PlayLogEntry): string => {
  const o = entry.outcome;
  const off = setup[entry.possession].team.abbr;
  const carrier = playerName(setup, o.ballCarrierId);
  const passer = playerName(setup, o.passerId);
  const receiver = playerName(setup, o.receiverId);
  const yards = (n: number): string => `${Math.abs(Math.round(n))} yard${Math.abs(Math.round(n)) === 1 ? '' : 's'}`;
  const gain = (n: number): string => (Math.round(n) < 0 ? `a loss of ${yards(n)}` : Math.round(n) === 0 ? 'no gain' : yards(n));
  const accepted = o.penalties.find((p) => p.accepted);
  const flagTeam = (side: PenaltyInfo['side']): string => (side === 'offense' ? off : setup[otherSide(entry.possession)].team.abbr);
  let text: string;
  if (o.result === 'penalty' && accepted) text = `${foulName(accepted.foul).toLowerCase()} on ${flagTeam(accepted.side)}, no play`;
  else if (o.result === 'pass') text = `${passer ?? 'Pass'} complete to ${receiver ?? 'a receiver'} for ${gain(o.yards)}`;
  else if (o.result === 'incomplete') text = `${passer ? `${passer} incomplete` : 'Incomplete pass'}${receiver ? ` intended for ${receiver}` : ''}`;
  else if (o.result === 'interception') text = `${passer ? `${passer} is intercepted` : 'Intercepted'}${o.returnYards ? `, returned ${yards(o.returnYards)}` : ''}`;
  else if (o.result === 'sack') text = `${passer ?? 'The quarterback'} sacked for ${gain(o.yards)}`;
  else if (o.result === 'run' || o.result === 'scramble') {
    const who = carrier ? `${carrier} ${o.result === 'scramble' ? 'scrambles' : 'rushes'}` : o.result === 'scramble' ? 'Quarterback scramble' : 'Run';
    text = `${who} for ${gain(o.yards)}`;
  }
  else text = sentence(resultText(o));
  // An accepted foul that is enforced from the previous spot wipes the play out (an interception that never counted
  // must not read as one); any other accepted foul is added on top of the play.
  if (accepted && o.result !== 'penalty') {
    const flag = `${foulName(accepted.foul).toLowerCase()} on ${flagTeam(accepted.side)}`;
    text += isNullifying(accepted) && !isReturnFoul(accepted, kickKindOf(o.result)) ? `, wiped out by ${flag}` : `, plus ${flag}`;
  }
  const wiped = nullifyingFoul(o) !== null;
  // A wiped-out play keeps only the foul's own result (an automatic first down), never its score or turnover.
  const tail = wiped ? (o.firstDown ? ', first down' : '') : o.touchdown && !/touchdown/i.test(text) ? ', TOUCHDOWN' : o.turnover && !/intercept|recovered|fumble/i.test(text) ? ', turnover' : o.firstDown && !o.touchdown ? ', first down' : '';
  const special = o.result === 'kickoff' || o.result === 'onside' || o.result === 'extraPoint' || o.result === 'twoPoint' || o.result === 'fieldGoal' || o.result === 'punt';
  const lead = special ? `${off}: ` : `(${formatDown(entry.down, entry.distance, entry.ballOn)}) ${off}: `;
  return `${lead}${text}${tail}.`;
};

/** The post-play caption: a description of the play itself (never just "First down."). */
export const playCaption = (setup: GameSetup, summary: PostPlaySummary): string => generatedPbp(setup, summary.entry);

const CAMEL_WORDS: Readonly<Record<string, string>> = {
  fieldGoal: 'field goal', extraPoint: 'extra point', twoPoint: 'two-point try', onside: 'onside kick',
  kickMade: 'kick good', kickMissed: 'kick missed', kickDowned: 'kick downed', fairCatch: 'fair catch',
  outOfBounds: 'out of bounds', forwardProgress: 'forward progress', blockedKick: 'blocked kick',
};

/**
 * Display clean-up for an executor play-by-play line: decimals are rounded ("44.2188-yard" -> "44-yard") and
 * internal camelCase identifiers read as words ("fieldGoal" -> "field goal").
 */
export const cleanPbpLine = (line: string): string =>
  line
    .replace(/\d+\.\d+/g, (m) => String(Math.round(Number(m))))
    .replace(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g, (w) => CAMEL_WORDS[w] ?? w.replace(/([A-Z])/g, ' $1').toLowerCase());

/** Post-play summary from the last logged entry. */
export const summaryFor = (setup: GameSetup, entry: PlayLogEntry, special: PlayContext['special'], simulated: boolean): PostPlaySummary => {
  const o = entry.outcome;
  // A play wiped out by a foul is described from the applied facts (the executor's lines still call the TD).
  const wiped = nullifyingFoul(o) !== null;
  const pbp = o.playByPlay.length > 0 && !wiped ? o.playByPlay.map(cleanPbpLine) : [generatedPbp(setup, entry)];
  return { entry, outcome: o, resultText: resultText(o, special), pbp, replayId: o.replayId, bigPlay: !wiped && (o.bigPlay || scoredTouchdown(o) || o.turnover), simulated };
};

/** Wording for the human penalty prompt: what accepting or declining leads to. */
export const penaltyPromptFor = (state: GameState, outcome: PlayOutcome, pd: PendingDecision, index: number): PenaltyPrompt => {
  const penalty = outcome.penalties[index] ?? outcome.penalties[0];
  if (!penalty) throw new Error('penaltyPromptFor: outcome carries no penalty');
  const foulingSide: TeamSide = penalty.side === 'offense' ? state.possession : otherSide(state.possession);
  const returnFoul = isReturnFoul(penalty, kickKindOf(outcome.result));
  return {
    side: pd.side,
    penalty,
    foulingSide,
    title: `${foulName(penalty.foul)} · ${returnFoul ? 'RETURN TEAM' : penalty.side === 'offense' ? 'OFFENSE' : 'DEFENSE'}`,
    acceptText: `Accept: ${penaltyAcceptText(penalty, pd.side !== state.possession, returnFoul)}`,
    declineText: `Decline: the play stands (${resultText(outcome).toLowerCase()})`,
  };
};

/**
 * What accepting a foul does, in one consistent clause: the yardage (or the spot, for a spot foul), then the
 * down consequence. An automatic first down replaces the down wording (never "replay the down, automatic
 * first down"), and a zero-yard spot foul names where the ball goes instead of "0 yards". A kick-return foul
 * (`returnFoul`) never replays the kick: the receiving team keeps the ball.
 */
export const penaltyAcceptText = (penalty: PenaltyInfo, defenseView = false, returnFoul = false): string => {
  const yards = Math.round(Math.abs(penalty.yards));
  const spotFoul = penalty.enforcement === 'spotOfFoul';
  const spot = penalty.spotBallOn !== null ? spotText(penalty.spotBallOn, defenseView) : null;
  let where: string;
  if (spotFoul && yards === 0) where = spot ? `ball placed at the ${spot}, the spot of the foul` : 'ball placed at the spot of the foul';
  else if (spotFoul) where = `${yards} yards from the spot of the foul${spot ? ` (${spot})` : ''}`;
  else if (penalty.enforcement === 'previousSpot') where = `${yards} yards from the previous spot`;
  else where = `${yards} yards added to the end of the play`;
  let down: string;
  if (returnFoul) down = 'receiving team keeps the ball';
  else if (penalty.automaticFirstDown) down = 'automatic first down';
  else if (penalty.lossOfDown) down = 'loss of down';
  else if (penalty.replayDown) down = 'replay the down';
  else down = 'next down';
  return `${where}, ${down}`;
};

/** Defensive roles the user may control for a defensive play, default first. Returners lead on kicks. */
export const controlRolesFor = (play: DefensivePlay, registry: PlaybookRegistry): string[] => {
  const formation = registry.defensiveFormations[play.formation];
  const roles = formation ? formation.slots.map((s) => s.role) : Object.keys(play.assignments);
  const returners = roles.filter((r) => play.assignments[r]?.type === 'returner');
  if (returners.length > 0) return returners;
  const preferred = ['FS', 'SS', 'MLB', 'OLB1', 'OLB2', 'CB1', 'CB2'].filter((r) => roles.includes(r));
  return preferred.length > 0 ? preferred : roles.slice(0, 3);
};

/** Slots, routes and formation for the live play (offense side); routes are empty on non-route plays. */
export const liveMetaFor = (ctx: PlayContext, registry: PlaybookRegistry, spectating: boolean): LivePlayMeta => {
  const formation = registry.offensiveFormations[ctx.offensivePlay.formation] ?? null;
  let routes: Record<string, RouteDef> = {};
  let slots: string[] = [];
  if (formation) {
    try {
      routes = materializePlay(ctx.offensivePlay, formation, registry.routes).routes;
    } catch {
      routes = {};
    }
    slots = receiverSlots(ctx.offensivePlay, formation);
  } else {
    slots = [ctx.offensivePlay.primary, ...ctx.offensivePlay.progression].filter((r, i, a) => a.indexOf(r) === i).slice(0, 5);
  }
  return { ctx, receiverSlots: slots, routes, formation, spectating };
};

/**
 * Ball spot as "OWN 34", "50" or "OPP 12". `ballOn` is offense-perspective; with `defenseView` the label is read
 * from the defense's side of the ball (the offense's own 14 is the defense's "OPP 14").
 */
export const spotText = (ballOn: number, defenseView = false): string => {
  // A live spot is never a goal line (a ball that reached it scored): 99.5 reads OPP 1, not OPP 0.
  const y = Math.min(99, Math.max(1, Math.round(ballOn)));
  if (y === 50) return '50';
  const offenseHalf = y < 50;
  const yards = offenseHalf ? y : 100 - y;
  return offenseHalf !== defenseView ? `OWN ${yards}` : `OPP ${yards}`;
};

/**
 * "2ND & 7 · OPP 34"-style line (kickoff / PAT aware). The spot is read from `viewer`'s side: the offense's view
 * when the viewer has the ball or is nobody (spectators), the defense's view otherwise.
 */
export const situationSummary = (state: Pick<GameState, 'kickoffPending' | 'patPending' | 'down' | 'distance' | 'ballOn' | 'phase' | 'possession'> & Partial<Pick<GameState, 'overtime'>>, viewer: TeamSide | null = null): string => {
  if (state.phase === 'final') return 'FINAL';
  // No down and distance before the toss (the regulation spot would linger behind the overtime toss).
  if (state.phase === 'coinToss') return state.overtime ? 'OVERTIME' : 'COIN TOSS';
  if (state.kickoffPending) return 'KICKOFF';
  if (state.patPending) return 'POINT AFTER';
  return `${formatDown(state.down, state.distance, state.ballOn).toUpperCase()} · ${spotText(state.ballOn, viewer !== null && viewer !== state.possession)}`;
};

/**
 * A copy of a saved mid-game state a new session can continue: the setup's controllers and user side apply, and a
 * play that was in progress (or a penalty answer that was pending) is rolled back to the snap before it.
 */
export const resumeState = (saved: Readonly<GameState>, setup: Pick<GameSetup, 'controllers' | 'userSide'>): GameState => {
  const st = structuredClone(saved) as GameState;
  st.controllers = { ...setup.controllers };
  st.userSide = setup.userSide;
  if (st.phase === 'presnap' || st.phase === 'live' || st.pendingDecision?.kind === 'penaltyDecision') {
    st.pendingDecision = null;
    st.phase = betweenPlayPhase(st);
    st.clock.playClockRunning = false;
  }
  return st;
};

/** Camera context for the local user: watch when not playing, kick / punt on special teams, else offense / defense. */
export const cameraContextFor = (s: Readonly<GameState>, user: TeamSide | null, ctx: PlayContext | null): CameraContext => {
  if (!user || s.controllers[user] !== 'human') return 'watch';
  const special = ctx?.special ?? (s.kickoffPending ? 'kickoff' : s.patPending ? 'extraPoint' : 'none');
  if (special === 'punt') return 'punt';
  if (special !== 'none' && special !== 'twoPoint') return 'kick';
  return (ctx?.offense ?? s.possession) === user ? 'offense' : 'defense';
};

/** Intermission card owed for this state (null when none or already announced in `announced`). */
export const intermissionFor = (s: Readonly<GameState>, announced: ReadonlySet<string>): IntermissionReason | null => {
  const check = (key: string, reason: IntermissionReason): IntermissionReason | null => (announced.has(key) ? null : reason);
  if (s.phase === 'halftime') return check('halftime', 'halftime');
  if (s.phase === 'twoMinute') return check(`twoMinute:${halfOf(s.clock.quarter)}`, 'twoMinute');
  if (s.overtime && s.playLog.length > 0) return check(`overtime:${s.overtime.period}`, 'overtime');
  if (s.clock.quarter > 1 && s.clock.secondsRemaining === s.ruleset.quarterLengthSec && s.playLog.length > 0 && !s.overtime && s.clock.quarter !== 3) {
    return check(`quarter:${s.clock.quarter}`, 'quarterEnd');
  }
  return null;
};

/** Key an intermission is remembered under once shown. */
export const intermissionKey = (s: Readonly<GameState>, reason: IntermissionReason): string => {
  switch (reason) {
    case 'halftime': return 'halftime';
    case 'twoMinute': return `twoMinute:${halfOf(s.clock.quarter)}`;
    case 'overtime': return `overtime:${s.overtime?.period ?? 0}`;
    case 'quarterEnd': return `quarter:${s.clock.quarter}`;
  }
};

export type PlaybookComplexity = 'simple' | 'standard' | 'advanced';

/**
 * Trims a play list to the playbook complexity setting: 'simple' keeps the core ('base') plays plus the coach's
 * suggestion so the situational call is always there (all plays when a playbook has no base plays); 'standard'
 * and 'advanced' keep everything.
 */
export const playsForComplexity = <T extends { id: string; tags: readonly string[] }>(plays: readonly T[], complexity: PlaybookComplexity, keepId: string | null = null): T[] => {
  if (complexity !== 'simple') return [...plays];
  const core = plays.filter((p) => p.tags.includes('base') || p.id === keepId);
  return core.length > 0 ? core : [...plays];
};

/**
 * Whether an offensive play may run in the current situation: only kickoff units on a kickoff, only the extra
 * point or a two-point play during a PAT, and no kickoff / PAT units on a scrimmage down.
 */
export const playFitsSituation = (state: Readonly<GameState>, play: OffensivePlay): boolean => {
  const kind = isSpecialPlay(play);
  if (state.kickoffPending) return kind === 'kickoff' || kind === 'onside';
  if (state.patPending) return kind === 'extraPoint' || kind === 'twoPoint';
  return kind !== 'kickoff' && kind !== 'onside' && kind !== 'extraPoint' && kind !== 'twoPoint';
};

/** The request the play-call screen renders for `side`. */
export const buildPlaycallRequest = (state: GameState, setup: GameSetup, side: TeamSide, playcaller: Playcaller, registry: PlaybookRegistry, rng: Rng, complexity: PlaybookComplexity = 'standard'): PlaycallRequest => {
  const offense = state.possession;
  const unit = side === offense ? 'offense' : 'defense';
  const offensePlays = setup[offense].offensePlays;
  const defensePlays = setup[otherSide(offense)].defensePlays;
  const regularOffense = offensePlays.filter((p) => playFitsSituation(state, p) && (state.patPending ? isSpecialPlay(p) === 'twoPoint' : isSpecialPlay(p) === 'none'));
  const regularDefense = defensePlays.filter((p) => !p.tags.includes('kickReturn') && !p.tags.includes('puntReturn') && !p.tags.includes('fgBlock'));
  const suggestion = unit === 'offense' ? playcaller.suggestOffense(state, regularOffense, rng) : playcaller.suggestDefense(state, regularDefense, rng);
  const roles = unit === 'defense' && regularDefense[0] ? controlRolesFor(regularDefense[0], registry) : [];
  const keep = suggestion?.id ?? null;
  const special = unit === 'offense' ? playcaller.specialOptions(state, offensePlays) : [];
  // On 4th down the coach's pick is the kick when he would kick (a pass on 4th & 16 at your own 19 is no advice).
  const kick = unit === 'offense' && state.down === 4 && !state.kickoffPending && !state.patPending ? fourthDownChoice(state, setup[offense].headCoach) : 'go';
  const kickPick = kick !== 'go' && special.some((o) => o.id === kick) ? `special:${kick}` : null;
  return {
    side, unit, offense,
    situation: situationFor(state),
    offensePlays: unit === 'offense' ? playsForComplexity(regularOffense, complexity, keep) : [],
    defensePlays: unit === 'defense' ? playsForComplexity(regularDefense, complexity, keep) : [],
    // The simple playbook leaves trick plays (fake punt / fake field goal) off the SPECIAL tab.
    special: complexity === 'simple' ? special.filter((o) => o.id !== 'fakePunt' && o.id !== 'fakeFieldGoal') : special,
    complexity,
    suggestion: kickPick ?? suggestion?.id ?? null,
    controlRoles: roles,
    summary: situationSummary(state, side),
    clockRunning: state.clock.running,
  };
};

/** Formation role the engine should hand the human on this play, validated against the defensive formation. */
export const resolveControlRole = (unit: 'offense' | 'defense', requested: string | null | undefined, play: OffensivePlay | DefensivePlay, registry: PlaybookRegistry): string | null => {
  if (unit === 'offense') return requested ?? null;
  const roles = controlRolesFor(play as DefensivePlay, registry);
  if (requested && roles.includes(requested)) return requested;
  return roles[0] ?? null;
};

/** Bundled plays plus both teams' playbooks, keyed by id: what pre-snap audibles may resolve to. */
export const audiblePlaysFor = (setup: Pick<GameSetup, 'home' | 'away'>, registry: PlaybookRegistry): { offensePlays: Record<string, OffensivePlay>; defensePlays: Record<string, DefensivePlay> } => {
  const byId = <T extends { id: string }>(...lists: readonly (readonly T[])[]): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const list of lists) for (const p of list) out[p.id] = p;
    return out;
  };
  return {
    offensePlays: { ...registry.offensePlays, ...byId(setup.home.offensePlays, setup.away.offensePlays) },
    defensePlays: { ...registry.defensePlays, ...byId(setup.home.defensePlays, setup.away.defensePlays) },
  };
};
