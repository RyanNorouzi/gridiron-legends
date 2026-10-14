/**
 * Placeholder figure painter: reuses the legacy 16x16 procedural sprites (sprites.ts) for every clip id, scaled
 * nearest-neighbour to the figure height of each tier (FIGURE_HEIGHT_ART = 26 art px at tier 1, 22 / 18 / 14 at
 * tiers 2-4), so the figure sizes of the tiers already hold and the world layer works end to end before
 * the art chains register their painters (anim.ts `registerPainter`; a specific registration always beats this
 * fallback). Each AnimId maps to the closest legacy pose family and frame. Pure and Node-safe (RGBA output).
 */
import type { PositionGroup } from '@/players/types';
import type { AnimId } from './anim-ids';
import { clipTiming, hasFallbackPainter, registerPainter, type FigureBuild, type FramePainter, type FrameRequest, type PaintedFrame } from './anim';
import { ANIM_FRAMES, generateAthleteSprite, SKIN_TONES, SpriteCache, type SpriteAnim } from './sprites';
import { FIGURE_HEIGHT_ART, TIER_SCALE, type FigureTier } from './world-layer';

/** Legacy pose family for every clip. */
const FAMILY: Readonly<Record<AnimId, SpriteAnim>> = Object.freeze({
  idle: 'idle', stance2: 'idle', stance3: 'block', snapStance: 'block', qbUnderCenter: 'idle', qbShotgun: 'idle', dbReady: 'idle',
  returnerReady: 'catch', jog: 'run', run: 'run', sprint: 'run', carry: 'run', carrySprint: 'run', carryHigh: 'run', switchHands: 'run',
  backpedal: 'run', shuffle: 'run', cut: 'run', juke: 'run', spin: 'run', stiffArm: 'block', hurdle: 'run', truck: 'block',
  stumble: 'run', dropback: 'run', setFeet: 'idle', throw: 'throw', throwLob: 'throw', throwRun: 'throw', handoff: 'throw',
  takeHandoff: 'catch', pitch: 'throw', slide: 'tackled', kneel: 'idle', spike: 'throw', reachOut: 'catch', catchChest: 'catch',
  catchHigh: 'catch', catchDive: 'dive', catchSideline: 'catch', catchTurn: 'catch', drop: 'catch', swat: 'catch', jumpContest: 'catch',
  kickoff: 'kick', punt: 'kick', fieldGoal: 'kick', holdPlace: 'idle', longSnap: 'block', snap: 'block', fairCatch: 'catch',
  getUp: 'falling', injuredDown: 'down', celebrateSpike: 'celebrate', celebrateLeap: 'celebrate', celebratePoint: 'celebrate',
  celebrateFlex: 'celebrate', highFive: 'celebrate', sackDance: 'celebrate', fistPump: 'celebrate', dejected: 'idle', down: 'down',
  downBack: 'down',
  passSet: 'block', fireOut: 'block', punch: 'block', handFight: 'block', driveBlock: 'block', driven: 'block', anchor: 'block',
  bullRush: 'block', doubleTeam: 'block', splitDouble: 'block', swim: 'run', rip: 'run', spinMove: 'run', longArmShed: 'block',
  beaten: 'run', pancake: 'block', knockdown: 'falling', knockback: 'run',
  tackleLunge: 'wrapping', wrap: 'wrapping', tackledBack: 'tackled', tackledFwd: 'falling', hangOn: 'wrapping', struggle: 'wrapped',
  armGrab: 'wrapping', spunDown: 'falling', diveTackle: 'dive', tripped: 'falling', bigHit: 'wrapping', blownUp: 'tackled',
  pileOn: 'down', buried: 'down', openFieldWrap: 'wrapping', rolledDown: 'falling', stripChop: 'wrapping', fumbleReach: 'wrapped',
  scoopUp: 'catch', fallOnBall: 'down', whiff: 'dive', shrugged: 'run', fallFwd: 'falling', fallBack: 'tackled',
});

/** Clips whose last frames lie on the ground (the legacy 'down' sprite finishes them). */
const ENDS_DOWN: ReadonlySet<AnimId> = new Set<AnimId>([
  'wrap', 'tackledBack', 'tackledFwd', 'spunDown', 'tripped', 'blownUp', 'rolledDown', 'fallFwd', 'fallBack', 'knockdown', 'openFieldWrap',
]);

/** One representative clip per legacy pose family (frames of every clip in a family are the same sprites). */
const FAMILY_CLIP: Readonly<Record<SpriteAnim, AnimId>> = Object.freeze({
  idle: 'idle', run: 'run', block: 'handFight', throw: 'throw', catch: 'catchChest', kick: 'kickoff', dive: 'catchDive',
  celebrate: 'celebrateFlex', wrapped: 'struggle', wrapping: 'hangOn', falling: 'fallFwd', tackled: 'tackledBack', down: 'down',
});

const GROUP: Readonly<Record<FigureBuild, PositionGroup>> = Object.freeze({ bigO: 'OL', bigD: 'DL', power: 'LB', back: 'RB', qb: 'QB', slim: 'WR', kick: 'ST' });

/** Legacy family and frame for a clip frame. */
export const legacyPose = (clip: AnimId, frame: number, frames: number): { anim: SpriteAnim; frame: number } => {
  if (ENDS_DOWN.has(clip) && frame >= Math.max(1, frames - 2)) return { anim: 'down', frame: 0 };
  const anim = FAMILY[clip];
  const n = ANIM_FRAMES[anim];
  return { anim, frame: ((frame % n) + n) % n };
};

/** Upscale factor of the 16-px legacy sprite per tier (FIGURE_HEIGHT_ART / 16 x the tier scale). */
export const legacyScale = (tier: FigureTier): number => (FIGURE_HEIGHT_ART / 16) * TIER_SCALE[tier];

const FACING_X: Readonly<Record<string, number>> = Object.freeze({ e: 1, ne: 1, se: 1, w: -1, nw: -1, sw: -1, n: 0, s: 0 });

/** Creates the placeholder painter (its own small legacy sprite cache). */
export const createLegacyPainter = (): FramePainter => {
  const sprites = new SpriteCache();
  return {
    id: 'legacy16',
    bakesNumber: true,
    normalize(req: FrameRequest): FrameRequest {
      const pose = legacyPose(req.clip, req.frame, clipTiming(req.clip).frames);
      return { ...req, clip: FAMILY_CLIP[pose.anim], frame: pose.frame, bodyVar: 1, accessory: 0, lighting: 'day' };
    },
    paint(req: FrameRequest): PaintedFrame {
      const pose = legacyPose(req.clip, req.frame, clipTiming(req.clip).frames);
      const s = generateAthleteSprite(sprites, {
        palette: req.kit.uniform, skinTone: SKIN_TONES[req.skin % SKIN_TONES.length] as string, group: GROUP[req.build],
        facing: req.facing, anim: pose.anim, frame: pose.frame, number: req.number,
      });
      const k = legacyScale(req.tier);
      const w = Math.round(s.width * k);
      const h = Math.round(s.height * k);
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(s.height - 1, Math.floor(((y + 0.5) * s.height) / h));
        for (let x = 0; x < w; x++) {
          const si = (sy * s.width + Math.min(s.width - 1, Math.floor(((x + 0.5) * s.width) / w))) * 4;
          const di = (y * w + x) * 4;
          rgba[di] = s.data[si] ?? 0;
          rgba[di + 1] = s.data[si + 1] ?? 0;
          rgba[di + 2] = s.data[si + 2] ?? 0;
          rgba[di + 3] = s.data[si + 3] ?? 0;
        }
      }
      const fx = FACING_X[req.facing] ?? 0;
      const ay = h - 1;
      const r = (v: number): number => Math.round(v * k);
      return {
        width: w, height: h, ax: Math.round(s.anchorX * k), ay, rgba,
        attach: {
          helmetTop: { x: 0, y: -r(14) }, torsoCentre: { x: 0, y: -r(8) },
          ball: { x: fx * r(4), y: -r(6) }, feet: [{ x: -r(2), y: 0 }, { x: r(2), y: 0 }],
        },
      };
    },
  };
};

/**
 * Registers the placeholder as the fallback painter for every clip, unless a fallback is already registered. Specific
 * painters (the art chains' clips) never suppress it: every clip they do not cover yet still needs a figure.
 */
export const installLegacyPainter = (): void => {
  if (hasFallbackPainter()) return;
  registerPainter(createLegacyPainter());
};
