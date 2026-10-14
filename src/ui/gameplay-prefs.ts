/**
 * Gameplay preferences the Settings record does not carry (core/settings.ts has no gameplay fields): the play
 * style (arcade / simulation ruleset), difficulty preset plus per-parameter tuning, quarter length and the
 * penalties / injuries / fatigue / weather switches. Stored as their own record (GAMEPLAY_KEY) next to the
 * settings, shared through ScreenServices.gameplay and edited in the Settings screen; every new game setup
 * (quick game, custom game, watch mode, new leagues) starts from them. Franchise leagues keep their own copy in
 * League.settings, edited from the hub's LEAGUE RULES dialog.
 */
import type { DifficultyId, DifficultyProfile, Ruleset } from '@/game/types';
import { DIFFICULTY_IDS, getDifficulty, getRuleset, isDifficultyId } from '@/game/rulesets';
import type { StorageAdapter } from '@/save/storage';

/** Difficulty knobs the player can nudge away from the preset (each -2..+2 steps). */
export type DifficultyTweak = 'aiSmarts' | 'aiReaction' | 'aiPursuit' | 'passAssist' | 'tackleAssist' | 'ballSecurity';

export const DIFFICULTY_TWEAKS: readonly { id: DifficultyTweak; label: string }[] = [
  { id: 'aiSmarts', label: 'AI FOOTBALL IQ' },
  { id: 'aiReaction', label: 'AI REACTION SPEED' },
  { id: 'aiPursuit', label: 'AI PURSUIT & TACKLING' },
  { id: 'passAssist', label: 'YOUR PASS ASSIST' },
  { id: 'tackleAssist', label: 'YOUR TACKLE ASSIST' },
  { id: 'ballSecurity', label: 'YOUR BALL SECURITY' },
];

export const TWEAK_MIN = -2;
export const TWEAK_MAX = 2;

export interface GameplayPrefs {
  ruleset: 'arcade' | 'simulation';
  difficulty: DifficultyId;
  quarterMinutes: number;
  penalties: boolean;
  injuries: boolean;
  fatigue: boolean;
  weather: boolean;
  /** Steps away from the preset per knob (absent = 0). */
  tweaks: Partial<Record<DifficultyTweak, number>>;
}

export const GAMEPLAY_KEY = 'gl:gameplay';
export const QUARTER_CHOICES: readonly number[] = [2, 3, 5, 8, 10, 15];

/** Defaults: simulation rules on Pro, 5-minute quarters, everything on, no tuning. */
export const defaultGameplay = (): GameplayPrefs => ({
  ruleset: 'simulation', difficulty: 'pro', quarterMinutes: 5, penalties: true, injuries: true, fatigue: true, weather: true, tweaks: {},
});

const clampStep = (n: number): number => Math.max(TWEAK_MIN, Math.min(TWEAK_MAX, Math.round(n)));
const unit = (n: number): number => Math.max(0, Math.min(1, Math.round(n * 100) / 100));

/** Lenient parse: wrong-typed or unknown fields fall back to the defaults. */
export const parseGameplay = (raw: unknown): GameplayPrefs => {
  const d = defaultGameplay();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const bool = (k: keyof GameplayPrefs, def: boolean): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : def);
  const tweaks: Partial<Record<DifficultyTweak, number>> = {};
  const rawTweaks = r.tweaks && typeof r.tweaks === 'object' ? (r.tweaks as Record<string, unknown>) : {};
  for (const t of DIFFICULTY_TWEAKS) {
    const v = rawTweaks[t.id];
    if (typeof v === 'number' && Number.isFinite(v) && clampStep(v) !== 0) tweaks[t.id] = clampStep(v);
  }
  return {
    ruleset: r.ruleset === 'arcade' || r.ruleset === 'simulation' ? r.ruleset : d.ruleset,
    difficulty: typeof r.difficulty === 'string' && isDifficultyId(r.difficulty) ? r.difficulty : d.difficulty,
    quarterMinutes: typeof r.quarterMinutes === 'number' && QUARTER_CHOICES.includes(r.quarterMinutes) ? r.quarterMinutes : d.quarterMinutes,
    penalties: bool('penalties', d.penalties),
    injuries: bool('injuries', d.injuries),
    fatigue: bool('fatigue', d.fatigue),
    weather: bool('weather', d.weather),
    tweaks,
  };
};

/**
 * The preset with the tuning applied: AI knobs move 0.1 per step (reaction delay 0.06 s per step, faster = shorter),
 * user assists 0.15 per step, all clamped to their ranges. The name gains " (CUSTOM)" when anything moved.
 */
export const tunedDifficulty = (base: DifficultyProfile, tweaks: Readonly<Partial<Record<DifficultyTweak, number>>>): DifficultyProfile => {
  const t = (k: DifficultyTweak): number => clampStep(tweaks[k] ?? 0);
  const out: DifficultyProfile = { ...base };
  const smarts = t('aiSmarts') * 0.1;
  out.coverageAnticipation = unit(base.coverageAnticipation + smarts);
  out.qbDecisionQuality = unit(base.qbDecisionQuality + smarts);
  out.receiverIntelligence = unit(base.receiverIntelligence + smarts);
  out.interceptionAwareness = unit(base.interceptionAwareness + smarts);
  out.playcallingIq = unit(base.playcallingIq + smarts);
  out.blockingIq = unit(base.blockingIq + smarts);
  out.aiReactionDelay = Math.max(0.02, Math.min(0.7, Math.round((base.aiReactionDelay - t('aiReaction') * 0.06) * 100) / 100));
  const pursuit = t('aiPursuit') * 0.1;
  out.pursuitQuality = unit(base.pursuitQuality + pursuit);
  out.tackleDecisionQuality = unit(base.tackleDecisionQuality + pursuit);
  out.userPassAssist = unit(base.userPassAssist + t('passAssist') * 0.15);
  out.userTackleAssist = unit((base.userTackleAssist ?? 0.5) + t('tackleAssist') * 0.15);
  out.userBallSecurityAssist = unit(base.userBallSecurityAssist + t('ballSecurity') * 0.15);
  if (DIFFICULTY_TWEAKS.some((k) => t(k.id) !== 0)) out.name = `${base.name} (Custom)`;
  return out;
};

/**
 * The ruleset with `minutes`-long quarters; the overtime period scales with them (keeping the ruleset's own
 * overtime-to-quarter ratio), so 1-minute quarters do not lead into a 10:00 overtime.
 */
export const withQuarterLength = (ruleset: Ruleset, minutes: number, floorSec = 30): Ruleset => {
  const quarterLengthSec = Math.max(floorSec, Math.round(minutes * 60));
  const ratio = ruleset.quarterLengthSec > 0 ? ruleset.overtimeLengthSec / ruleset.quarterLengthSec : 1;
  return { ...ruleset, quarterLengthSec, overtimeLengthSec: Math.max(floorSec, Math.round(quarterLengthSec * ratio)) };
};

/** Ruleset + difficulty a new game should use under these preferences. */
export const gameplayRules = (prefs: GameplayPrefs): { ruleset: Ruleset; difficulty: DifficultyProfile } => {
  const ruleset: Ruleset = withQuarterLength(getRuleset(prefs.ruleset), prefs.quarterMinutes);
  ruleset.penalties = ruleset.penalties && prefs.penalties;
  ruleset.injuries = prefs.injuries;
  ruleset.fatigue = prefs.fatigue;
  return { ruleset, difficulty: tunedDifficulty(getDifficulty(prefs.difficulty), prefs.tweaks) };
};

/** Next / previous difficulty preset id. */
export const cycleDifficulty = (id: DifficultyId, delta: number): DifficultyId => {
  const i = Math.max(0, DIFFICULTY_IDS.indexOf(id));
  return DIFFICULTY_IDS[((i + delta) % DIFFICULTY_IDS.length + DIFFICULTY_IDS.length) % DIFFICULTY_IDS.length] as DifficultyId;
};

/**
 * What each difficulty means, for the screens where it is chosen (new franchise help panel, quick game, settings,
 * custom game, difficulty tuning). `short` fits under a menu row; `long` is the full description. The selected level
 * is the CPU opponent's: your own AI teammates always play at the neutral Pro level.
 */
export const DIFFICULTY_BLURBS: Readonly<Record<DifficultyId, { short: string; long: string }>> = {
  rookie: {
    short: 'Slow, forgiving CPU. Big assists for you.',
    long: 'Rookie: the CPU reads and reacts slowly and makes mistakes. Your passes, tackles and ball security get big assists.',
  },
  pro: {
    short: 'A fair fight. Sharp CPU, no edge.',
    long: 'Pro: a sharp CPU that plays like a real team, with no performance edge. Moderate assists. The balanced game.',
  },
  allPro: {
    short: 'Smarter, faster, stronger CPU.',
    long: 'All-Pro: the CPU makes near-perfect reads, attacks your tendencies and plays faster and stronger than its ratings. Small assists.',
  },
  legend: {
    short: 'Almost impossible to stop.',
    long: 'Legend: the CPU is faster, stronger and nearly flawless - almost impossible to stop. No assists: every catch, tackle and carry is on you.',
  },
};

/** The short or long description of a difficulty preset. */
export const difficultyBlurb = (id: DifficultyId, length: 'short' | 'long' = 'long'): string => DIFFICULTY_BLURBS[id][length];

/** Signed step label ("+1", "0", "-2"). */
export const tweakLabel = (n: number | undefined): string => {
  const v = clampStep(n ?? 0);
  return v > 0 ? `+${v}` : String(v);
};

/** Tuning step after a change (clamped). */
export const stepTweak = (n: number | undefined, delta: number): number => clampStep((n ?? 0) + delta);

export interface GameplayStore {
  load(): Promise<GameplayPrefs>;
  save(prefs: GameplayPrefs): Promise<void>;
}

/** Store over the save system's storage adapter (corrupt records load as defaults). */
export const createGameplayStore = (storage: StorageAdapter): GameplayStore => ({
  load: async () => {
    const text = await storage.getItem(GAMEPLAY_KEY);
    if (text === null) return defaultGameplay();
    try {
      return parseGameplay(JSON.parse(text) as unknown);
    } catch {
      return defaultGameplay();
    }
  },
  save: (prefs) => storage.setItem(GAMEPLAY_KEY, JSON.stringify(parseGameplay(prefs))),
});
