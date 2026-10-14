/**
 * Tutorial goal detection. A StepTracker watches a running DrillRep tick by tick and condenses it into a
 * StepObservation (events, athletes the user controlled, distance travelled, the user carrier's best gain,
 * whether the user played a pass in the air, whether he threw a pull-back pass to a spot); `goalStatus` is a pure function of a goal and an observation:
 * 'done' when the player performed the action, 'failed' when this attempt can no longer succeed, else 'pending'.
 */
import { dist } from '@/core/vec2';
import type { AthleteId, PlayEvent } from '@/game/play-events';
import type { PlayState } from '@/game/play-types';
import type { TeamSide } from '@/game/types';
import type { TutorialGoal } from './steps';

/** What happened so far in one attempt of an interactive step. */
export interface StepObservation {
  events: readonly PlayEvent[];
  /** Every athlete the user controlled during the attempt. */
  userIds: readonly AthleteId[];
  userSide: TeamSide;
  /** Primary read (passing) / the drill's focus athlete. */
  primaryId: AthleteId | null;
  /** Yards the user's athletes have moved in total. */
  travel: number;
  /** Best gain past the line of scrimmage by a user-controlled ball carrier on offense. */
  carrierGain: number;
  /** True once the user's athlete jumped or swatted while a pass was in the air. */
  playedBall: boolean;
  /** True once the user's quarterback threw a pull-back pass (to a spot rather than with a receiver's button). */
  spotThrow?: boolean;
  /** The attempt is over (play dead or rep finished). */
  over: boolean;
}

/** Where an attempt stands against its goal. */
export type GoalStatus = 'pending' | 'done' | 'failed';

/** An observation before anything happened. */
export const emptyObservation = (userSide: TeamSide = 'home'): StepObservation => ({
  events: [], userIds: [], userSide, primaryId: null, travel: 0, carrierGain: 0, playedBall: false, spotThrow: false, over: false,
});

const mine = (o: StepObservation, id: AthleteId | null): boolean => id !== null && o.userIds.includes(id);

/** Evaluates a goal against what has happened so far. */
export const goalStatus = (goal: TutorialGoal, o: StepObservation): GoalStatus => {
  const pendingOr = (): GoalStatus => (o.over ? 'failed' : 'pending');
  switch (goal.kind) {
    case 'moveYards':
      return o.travel >= goal.yards ? 'done' : pendingOr();
    case 'throwToPrimary': {
      const t = o.events.find((e): e is Extract<PlayEvent, { type: 'throw' }> => e.type === 'throw' && mine(o, e.thrower));
      if (t) return t.target !== null && t.target === o.primaryId ? 'done' : 'failed';
      return pendingOr();
    }
    case 'spotThrow': {
      const thrown = o.events.some((e) => e.type === 'throw' && mine(o, e.thrower));
      if (thrown) return o.spotThrow ? 'done' : 'failed';
      return pendingOr();
    }
    case 'catchBall': {
      if (o.events.some((e) => e.type === 'catch' && mine(o, e.receiver))) return 'done';
      if (o.events.some((e) => e.type === 'incomplete' || e.type === 'interception' || (e.type === 'catch' && !mine(o, e.receiver)))) return 'failed';
      return pendingOr();
    }
    case 'gainYards':
      return o.carrierGain >= goal.yards ? 'done' : pendingOr();
    case 'makeTackle':
      if (o.events.some((e) => e.type === 'tackle' && (mine(o, e.tackler) || e.assists.some((a) => mine(o, a))))) return 'done';
      return pendingOr();
    case 'switchPlayer':
      return o.events.some((e) => e.type === 'switchPlayer' && e.side === o.userSide) ? 'done' : pendingOr();
    case 'playTheBall': {
      if (o.playedBall) return 'done';
      if (o.events.some((e) => (e.type === 'incomplete' && mine(o, e.defender)) || (e.type === 'interception' && mine(o, e.defender)))) return 'done';
      if (o.events.some((e) => e.type === 'catch' || e.type === 'incomplete' || e.type === 'interception')) return 'failed';
      return pendingOr();
    }
  }
};

/** Accumulates a StepObservation from successive PlayStates of one attempt. */
export class StepTracker {
  private readonly users: AthleteId[] = [];
  private readonly last = new Map<AthleteId, { x: number; y: number }>();
  private travel = 0;
  private gain = 0;
  private played = false;
  private spot = false;

  constructor(readonly userSide: TeamSide, readonly primaryId: AthleteId | null = null) {}

  /** Folds one tick of the play in; `over` marks the end of the attempt. */
  observe(state: PlayState, over = state.phase === 'dead'): StepObservation {
    const id = state.controlledIds[this.userSide] ?? state.controlledId;
    const me = id ? state.athletes.find((a) => a.id === id) ?? null : null;
    if (me) {
      if (!this.users.includes(me.id)) this.users.push(me.id);
      const prev = this.last.get(me.id);
      if (prev) this.travel += dist(prev, me.pos);
      this.last.set(me.id, { x: me.pos.x, y: me.pos.y });
      if (me.side === 'offense' && state.ball.carrierId === me.id && state.ball.phase === 'held') {
        this.gain = Math.max(this.gain, state.ctx.direction * (state.ball.pos.y - state.losY));
      }
      const action = state.intents[me.id]?.action;
      if (state.ball.phase === 'inAir' && state.ball.kind === 'pass' && (action === 'swat' || action === 'jump')) this.played = true;
      const it = state.intents[me.id];
      if (it && it.action === 'throw' && !it.targetId && it.throwTarget) this.spot = true;
    }
    return {
      events: state.events, userIds: this.users, userSide: this.userSide, primaryId: this.primaryId,
      travel: this.travel, carrierGain: this.gain, playedBall: this.played, spotThrow: this.spot, over,
    };
  }
}
