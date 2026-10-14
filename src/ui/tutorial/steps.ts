/**
 * Tutorial script (data). Interactive steps run a drill scenario on the live field and finish when the player does
 * the thing (see goals.ts); info steps are illustrated pages. `{action}` tokens in any text become the player's
 * current button glyphs (prompts.ts). Order: movement, passing, catching, running, tackling, defense (switch,
 * coverage, jump / swat), play calling, clock management, franchise management.
 */
import { getDrill } from '@/game/practice/drills';
import type { DrillDefinition } from '@/game/practice/types';
import type { DifficultyId } from '@/game/types';
import type { IllustrationId } from './illustrations';

/** Subject of a step (the script covers them in order). */
export type TutorialTopic = 'basics' | 'movement' | 'passing' | 'catching' | 'running' | 'tackling' | 'defense' | 'playcalling' | 'clock' | 'franchise';

/** What an interactive step waits for. */
export type TutorialGoal =
  | { kind: 'moveYards'; yards: number }
  | { kind: 'throwToPrimary' }
  /** Throw a pull-back pass (to a spot, not with a receiver's button). */
  | { kind: 'spotThrow' }
  | { kind: 'catchBall' }
  | { kind: 'gainYards'; yards: number }
  | { kind: 'makeTackle' }
  | { kind: 'switchPlayer' }
  | { kind: 'playTheBall' };

/** One illustrated page of an info step. */
export interface TutorialPage {
  heading: string;
  lines: string[];
  art?: IllustrationId;
}

/** A step of illustrated pages the player reads through. */
export interface InfoStep {
  kind: 'info';
  id: string;
  topic: TutorialTopic;
  title: string;
  pages: TutorialPage[];
}

/** A step played on the field; it finishes when the goal is reached. */
export interface InteractiveStep {
  kind: 'interactive';
  id: string;
  topic: TutorialTopic;
  title: string;
  /** Instructions shown while the step runs. */
  lines: string[];
  drill: DrillDefinition;
  difficulty: DifficultyId;
  goal: TutorialGoal;
  /** Shown after an attempt that did not reach the goal. */
  retry: string;
  /** Shown when the goal is reached. */
  success: string;
}

/** Any tutorial step. */
export type TutorialStep = InfoStep | InteractiveStep;

/** Movement lesson: the user's receiver roams an empty field while the quarterback waits. */
export const MOVEMENT_DRILL: DrillDefinition = Object.freeze({ ...getDrill('catching'), name: 'MOVEMENT', script: 'freeRoam', summary: 'Move around the field' });

/** The tutorial script, in order. */
export const TUTORIAL_STEPS: readonly TutorialStep[] = Object.freeze([
  {
    kind: 'info', id: 'welcome', topic: 'basics', title: 'WELCOME',
    pages: [
      { heading: 'WELCOME TO GRIDIRON LEGENDS', art: 'field', lines: [
        'This tutorial covers every control on the field, then the coaching side of the game.',
        'Button prompts always match the device you are using.',
        'Press {pause} at any time to skip a step or leave the tutorial.',
      ] },
    ],
  },
  {
    kind: 'interactive', id: 'movement', topic: 'movement', title: 'MOVEMENT',
    lines: ['You control the player with the ring under him.', 'Move with {move}. Hold {sprint} to sprint.', 'Run 10 yards in any direction.'],
    drill: MOVEMENT_DRILL, difficulty: 'rookie', goal: { kind: 'moveYards', yards: 10 },
    retry: 'Keep moving with {move} - 10 yards gets it done.', success: 'Nice footwork!',
  },
  {
    kind: 'interactive', id: 'passing', topic: 'passing', title: 'PASSING',
    lines: ['Press {snap} to snap the ball.', 'Each receiver shows the button that throws to him.', 'Throw to your primary receiver with {throw1}.'],
    drill: getDrill('passRoutes'), difficulty: 'rookie', goal: { kind: 'throwToPrimary' },
    retry: 'That was not the primary. Look for the {throw1} icon over his head.', success: 'Right on target!',
  },
  {
    kind: 'interactive', id: 'pullBack', topic: 'passing', title: 'PULL-BACK PASS',
    lines: [
      'Press {snap}, then aim with {aim}: pull AWAY from where you want the ball (keys steer the ring).',
      'The arc and ring show where it lands. A longer pull throws deeper. Let go to throw.',
      'Back inside the start circle cancels. {aimLob} = lob. Hold {sprint} as you let go for a bullet.',
    ],
    drill: getDrill('passRoutes'), difficulty: 'rookie', goal: { kind: 'spotThrow' },
    retry: 'Aim with {aim} and let go - the receiver nearest the ring runs to it.', success: 'Dropped it in the bucket!',
  },
  {
    kind: 'interactive', id: 'catching', topic: 'catching', title: 'CATCHING',
    lines: ['Now you are the receiver. Press {snap} or wait for the throw.', 'Run under the ball: its shadow shows where it lands.', 'Press {jumpSwat} to go up for it, {dive} to dive.'],
    drill: getDrill('catching'), difficulty: 'rookie', goal: { kind: 'catchBall' },
    retry: 'Watch the shadow and get there early.', success: 'Great hands!',
  },
  {
    kind: 'interactive', id: 'running', topic: 'running', title: 'RUNNING',
    lines: ['Press {snap}. You take over the runner after the handoff.', 'Hold {sprint} to burst. {juke} jukes, {spin} spins, {stiffArm} stiff-arms.', 'Gain 5 yards: downfield is to the RIGHT.'],
    drill: getDrill('running'), difficulty: 'rookie', goal: { kind: 'gainYards', yards: 5 },
    retry: 'Find the hole and hit {sprint} through it.', success: 'Five yards and a cloud of dust!',
  },
  {
    kind: 'interactive', id: 'tackling', topic: 'tackling', title: 'TACKLING',
    lines: ['On defense you control the ringed defender.', 'Close on the runner with {move} and press {tackle} to wrap him up.', '{hitStick} is a big hit - it can miss.'],
    drill: getDrill('tackling'), difficulty: 'rookie', goal: { kind: 'makeTackle' },
    retry: 'Take an angle ahead of him, then press {tackle} up close.', success: 'Big stop!',
  },
  {
    kind: 'interactive', id: 'switch', topic: 'defense', title: 'SWITCH PLAYER',
    lines: ['Press {switchPlayer} to take over the defender closest to the ball.', 'Switch any time, before or after the snap.'],
    drill: getDrill('coverage'), difficulty: 'rookie', goal: { kind: 'switchPlayer' },
    retry: 'Press {switchPlayer} to change defenders.', success: 'Switched!',
  },
  {
    kind: 'interactive', id: 'coverage', topic: 'defense', title: 'COVERAGE',
    lines: ['Shadow your receiver. {strafe} keeps you facing the ball.', 'When the pass is in the air, press {jumpSwat} to jump the route or swat it away.'],
    drill: getDrill('coverage'), difficulty: 'rookie', goal: { kind: 'playTheBall' },
    retry: 'Stay close and press {jumpSwat} while the ball is in the air.', success: 'You played the ball!',
  },
  {
    kind: 'info', id: 'playcalling', topic: 'playcalling', title: 'PLAY CALLING',
    pages: [
      { heading: 'THE PLAY CALL SCREEN', art: 'playcall', lines: [
        'Before every snap you pick a play: offense chooses a formation and a play, defense a front and a coverage.',
        'Move with {menuUp} {menuDown}, change pages with {menuTabLeft} {menuTabRight}, call it with {confirm}.',
      ] },
      { heading: 'SAMPLE CALL: GUN SLANTS', art: 'playcall', lines: [
        'Three receivers run quick slants. Your primary read carries the {throw1} icon at the line.',
        'Throw it early: slants beat zone before the linebackers can drop.',
      ] },
      { heading: 'AT THE LINE', art: 'playcall', lines: [
        'Hold {showPlayArt} to see every route before the snap.',
        'Hold {audible} and press a direction to audible to a play that beats the defense you see.',
      ] },
    ],
  },
  {
    kind: 'info', id: 'clock', topic: 'clock', title: 'CLOCK MANAGEMENT',
    pages: [
      { heading: 'TIMEOUTS', art: 'clock', lines: ['Press {callTimeout} to stop the clock. You get three per half - save them for the end.'] },
      { heading: 'SPIKE AND KNEEL', art: 'clock', lines: [
        'Call SPIKE to stop the clock in a hurry. It costs you a down.',
        'Leading late? Call KNEEL and let the clock run out.',
      ] },
      { heading: 'OUT OF BOUNDS', art: 'clock', lines: [
        'Running out of bounds stops the clock late in a half.',
        'Stay in bounds to keep it running; get out of bounds to save time.',
      ] },
    ],
  },
  {
    kind: 'info', id: 'franchise', topic: 'franchise', title: 'FRANCHISE',
    pages: [
      { heading: 'YOUR ROSTER', art: 'roster', lines: ['Every player has ratings, an age and a potential. Young players grow; veterans slow down.'] },
      { heading: 'DEPTH CHART', art: 'depthChart', lines: ['The depth chart decides who starts at each position and who comes in when a starter tires or gets hurt.'] },
      { heading: 'CONTRACTS AND THE CAP', art: 'cap', lines: ['Every contract counts against the salary cap. Stay under it: stars cost money, so plan for next year too.'] },
      { heading: 'THE DRAFT', art: 'draft', lines: ['Scout college prospects, then draft them. Rookies are cheap and can become stars.'] },
      { heading: 'FREE AGENCY', art: 'freeAgency', lines: ['Players without a team sign with the best offer - money, role and your team\'s chances all matter.'] },
      { heading: 'TRADES', art: 'trade', lines: ['Swap players and draft picks with other teams. A fair offer gets accepted; a lopsided one does not.'] },
    ],
  },
  {
    kind: 'info', id: 'finish', topic: 'basics', title: 'READY',
    pages: [
      { heading: "YOU'RE READY", art: 'field', lines: ['Practice mode has drills for every skill. Good luck out there, coach!', 'Press {confirm} to finish.'] },
    ],
  },
] satisfies TutorialStep[]);

/** Step ids in order (progress bookkeeping). */
export const TUTORIAL_STEP_IDS: readonly string[] = Object.freeze(TUTORIAL_STEPS.map((s) => s.id));
