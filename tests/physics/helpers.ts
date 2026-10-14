import type { PlayerId } from '@/core/ids';
import type { Athlete } from '@/game/play-types';
import type { WeatherState } from '@/game/types';
import { ATTRIBUTE_KEYS, type AttributeSet } from '@/players/types';

/** Full attribute set at one value with overrides. */
export const makeAttrs = (value = 70, overrides: Partial<AttributeSet> = {}): AttributeSet => {
  const out = {} as AttributeSet;
  for (const k of ATTRIBUTE_KEYS) out[k] = value;
  return { ...out, ...overrides };
};

export const clearWeather = (overrides: Partial<WeatherState> = {}): WeatherState => ({
  type: 'clear', windDir: 0, windMph: 0, temperatureF: 70, precipitation: 0, visibility: 1, fieldSlick: 0, ...overrides,
});

export type AthleteOverrides = Partial<Omit<Athlete, 'attrs' | 'baseAttrs'>> & { attrs?: Partial<AttributeSet>; base?: number };

let counter = 0;

/** A fully-formed Athlete fixture (defaults: 70s across the board, idle at the origin, 200 lb, 6'0"). */
export const makeAthlete = (overrides: AthleteOverrides = {}): Athlete => {
  const { attrs: attrOverrides, base, ...rest } = overrides;
  const attrs = makeAttrs(base ?? 70, attrOverrides);
  counter++;
  return {
    id: `off:A${counter}`,
    playerId: `p_${counter}` as PlayerId,
    teamSide: 'home',
    side: 'offense',
    position: 'RB',
    role: 'RB',
    number: counter,
    name: `Athlete ${counter}`,
    pos: { x: 26, y: 30 },
    vel: { x: 0, y: 0 },
    facing: Math.PI / 2,
    radius: 0.5,
    massLb: 200,
    heightIn: 72,
    attrs,
    baseAttrs: { ...attrs },
    fatigue: 0,
    state: 'idle',
    stateTimer: 0,
    hasBall: false,
    controlled: false,
    assignment: { type: 'carry' },
    ai: {
      targetPos: null, targetAthleteId: null, reactionTimer: 0, routeIndex: 0, routeTimer: 0, readIndex: 0,
      lastDecisionTick: 0, decision: '', zoneCenter: null, blockTargetId: null, recognizedRun: false, recognizedPass: false, scratch: {},
    },
    engagedWith: null,
    burst: 1,
    specialMoveCooldown: 0,
    brokenTacklesThisPlay: 0,
    eligible: true,
    active: true,
    contactTimer: 0,
    ...rest,
  };
};
