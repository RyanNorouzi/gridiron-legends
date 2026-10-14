/**
 * Human control through the real engine with the real AI around the controlled athlete: a scripted defender
 * runs the ball carrier down and ends the play (and wins the one-on-one about as often as a real safety), switchPlayer
 * hands control to the nearest defender, and a scripted quarterback throw to slot 0 launches the ball at that
 * receiver on the press tick (USER_THROW_WINDUP is zero), a second press right after it changing nothing.
 */
import { describe, expect, it } from 'vitest';
import { decideIntent } from '@/ai/index';
import { registerAll } from '@/ai/register';
import { dist, normalize, sub, vec2 } from '@/core/vec2';
import { ballCarrier, findAthlete } from '@/game/athlete';
import { idleIntent, type IntentDecider } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import { createPlayEngine, DEFAULT_MAX_TICKS } from '@/game/play-engine';
import type { PlayState, UserInputs, UserPlayInput } from '@/game/play-types';
import { ballFocus, receiverSlotsFor } from '@/game/user-control';
import { buildPlayState } from '../fixtures/play-state';

registerAll();

const noInput = (): UserPlayInput => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false,
});

const BLOCKERS = new Set(['runBlock', 'passBlock', 'leadBlock', 'chipRelease']);

/**
 * Real AI for the quarterback and the back; the blockers stand still and every defender except the human's FS
 * waits out of the way, so the play is the human's one-on-one to end.
 */
const onlyTheHuman: IntentDecider = (a, s, dt) => (a.side === 'defense' || BLOCKERS.has(a.assignment.type) ? idleIntent('idle') : decideIntent(a, s, dt));

/** How the scripted human plays the one-on-one once he is near the back (he always sprints straight at him). */
type Press = (d: number) => Partial<UserPlayInput>;

interface OneOnOne {
  /** The play ended with the human's own tackle. */
  tackled: boolean;
  /** The back beat the human on his first try (broke it, made him miss, or ran round him untouched). */
  beaten: boolean;
}

/**
 * The human's free safety against the real AI back, ten statues around him: whatever the human does not stop is a
 * long touchdown. Validates each outcome.
 */
const oneOnOne = (seed: number, press: Press): OneOnOne => {
  const f = buildPlayState({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', ballOn: 30, seed, ruleset: 'arcade', userSide: 'away', controlRole: 'FS' });
  const engine = createPlayEngine(f.state.ctx, { registries: f.registry, decider: onlyTheHuman });
  const fsId = engine.state.controlledIds.away ?? null;
  expect(fsId).toBe('def:FS');
  // The other ten defenders wait out of the way by the far sideline, well downfield of the human.
  for (const a of engine.state.athletes) {
    if (a.side === 'defense' && a.id !== fsId) a.pos = vec2(1, engine.state.losY + f.state.ctx.direction * 45);
  }
  const inputs = (state: PlayState): UserInputs => {
    const fs = findAthlete(state, fsId);
    const carrier = ballCarrier(state);
    if (!fs || !carrier || carrier.side !== 'offense') return { away: noInput() };
    return { away: { ...noInput(), move: normalize(sub(carrier.pos, fs.pos)), sprint: true, ...press(dist(fs.pos, carrier.pos)) } };
  };
  const outcome = engine.run(inputs, DEFAULT_MAX_TICKS);
  assertValidOutcome(outcome);
  expect(engine.isDead).toBe(true);
  expect(engine.state.deadReason).not.toBeNull();
  const events = engine.state.events;
  const first = events.find((e) => (e.type === 'tackle' && e.tackler === fsId) || ((e.type === 'brokenTackle' || e.type === 'missedTackle') && e.defender === fsId));
  return { tackled: events.some((e) => e.type === 'tackle' && e.tackler === fsId), beaten: first?.type !== 'tackle' };
};

/** Two dozen seeds (each a different generated back and safety): enough to measure a rate, not a lucky seed. */
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
/**
 * A safety who breaks down and wraps up makes 75-85% of his open-field tackles in real football; the bar is 70%
 * (17 of 24). The engine measures ~83% at pro over 48 seeds with either script.
 */
const OPEN_FIELD_BAR = 17;

describe('human on defense', () => {
  it('a scripted free safety runs the carrier down and ends the play with his own tackle', () => {
    const results = SEEDS.map((seed) => oneOnOne(seed, (d) => ({ tackle: d <= 1.6 })));
    expect(results.filter((r) => r.tackled).length).toBeGreaterThanOrEqual(OPEN_FIELD_BAR);
  });

  it('pressing tackle only once he is in contact range wins the one-on-one just as often', () => {
    const results = SEEDS.map((seed) => oneOnOne(seed, (d) => ({ tackle: d <= 1.25 })));
    expect(results.filter((r) => r.tackled).length).toBeGreaterThanOrEqual(OPEN_FIELD_BAR);
  });

  it('sprinting in for the hit stick is the gamble: the back beats him more often than a broken-down wrap', () => {
    const wrap = SEEDS.map((seed) => oneOnOne(seed, (d) => ({ tackle: d <= 1.6 })));
    // Commits to the big hit from three yards out (pressed once, as the pad button fires), no breakdown.
    const hit = SEEDS.map((seed) => {
      let pressed = false;
      return oneOnOne(seed, (d) => {
        if (pressed || d > 3) return {};
        pressed = true;
        return { hitStick: true };
      });
    });
    const count = (rs: OneOnOne[], k: keyof OneOnOne): number => rs.filter((r) => r[k]).length;
    expect(count(hit, 'beaten')).toBeGreaterThan(count(wrap, 'beaten'));
    expect(count(hit, 'tackled')).toBeLessThan(count(wrap, 'tackled'));
  });

  it('switchPlayer moves control to the defender nearest the ball', () => {
    const f = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', ballOn: 40, seed: 4, ruleset: 'arcade', userSide: 'away', controlRole: 'FS' });
    const engine = createPlayEngine(f.state.ctx, { registries: f.registry });
    expect(engine.state.controlledIds.away).toBe('def:FS');
    const before = engine.state;
    const focus = ballFocus(before);
    const nearest = before.athletes
      .filter((a) => a.side === 'defense' && a.active && a.id !== 'def:FS')
      .sort((p, q) => dist(p.pos, focus) - dist(q.pos, focus))[0]!;
    engine.tick({ away: { ...noInput(), switchPlayer: true } });
    expect(engine.state.controlledIds.away).toBe(nearest.id);
    expect(engine.state.controlledId).toBe(nearest.id);
    expect(findAthlete(engine.state, nearest.id)?.controlled).toBe(true);
    expect(findAthlete(engine.state, 'def:FS')?.controlled).toBe(false);
    expect(engine.state.events.some((e) => e.type === 'switchPlayer' && e.to === nearest.id && e.side === 'away')).toBe(true);
  });
});

describe('human on offense', () => {
  it('a scripted throw to slot 0 launches the ball at the primary receiver', () => {
    const f = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', ballOn: 35, seed: 5, ruleset: 'arcade', userSide: 'home', controlRole: 'QB' });
    const engine = createPlayEngine(f.state.ctx, { registries: f.registry });
    expect(engine.state.controlledIds.home).toBe('off:QB');
    const slots = receiverSlotsFor(engine.state, { registries: f.registry });
    expect(slots.length).toBeGreaterThan(0);
    const primary = engine.state.athletes.find((a) => a.side === 'offense' && a.role === slots[0])!;
    let ticks = 0;
    while (engine.state.ball.carrierId !== 'off:QB' && ticks < 300) { engine.tick({ home: { ...noInput(), snap: true } }); ticks += 1; }
    expect(engine.state.phase).toBe('live');
    // Let the routes develop for a second, then let it go.
    for (let i = 0; i < 60 && !engine.isDead; i++) engine.tick({ home: noInput() });
    engine.tick({ home: { ...noInput(), throwTo: 0, throwType: 'bullet' } });
    const thrown = engine.state.events.find((e) => e.type === 'throw');
    expect(thrown).toBeDefined();
    expect(thrown?.type === 'throw' && thrown.thrower).toBe('off:QB');
    expect(thrown?.type === 'throw' && thrown.target).toBe(primary.id);
    expect(engine.state.ball.phase).toBe('inAir');
    expect(engine.state.ball.targetId).toBe(primary.id);
    const outcome = engine.run(() => ({ home: noInput() }), DEFAULT_MAX_TICKS);
    assertValidOutcome(outcome);
    expect(['pass', 'incomplete', 'interception']).toContain(outcome.result);
  });

  it('a second throw press right after the release changes nothing: one throw, on the press tick, at the first receiver', () => {
    const f = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', ballOn: 35, seed: 5, ruleset: 'arcade', userSide: 'home', controlRole: 'QB' });
    const engine = createPlayEngine(f.state.ctx, { registries: f.registry });
    const slots = receiverSlotsFor(engine.state, { registries: f.registry });
    expect(slots.length).toBeGreaterThan(1);
    const [first, second] = [slots[0], slots[1]].map((role) => engine.state.athletes.find((a) => a.side === 'offense' && a.role === role)!);
    for (let n = 0; engine.state.ball.carrierId !== 'off:QB' && n < 300; n++) engine.tick({ home: { ...noInput(), snap: true } });
    for (let i = 0; i < 60 && !engine.isDead; i++) engine.tick({ home: noInput() });
    engine.tick({ home: { ...noInput(), throwTo: 0, throwType: 'bullet' } });
    const pressTick = engine.state.tick;
    engine.tick({ home: { ...noInput(), throwTo: 1, throwType: 'lob' } });
    for (let i = 0; i < 10; i++) engine.tick({ home: noInput() });
    const throws = engine.state.events.filter((e) => e.type === 'throw');
    expect(throws).toHaveLength(1);
    const t = throws[0]!;
    expect(t.type === 'throw' && t.target).toBe(first!.id);
    expect(t.type === 'throw' && t.target).not.toBe(second!.id);
    expect(t.type === 'throw' && t.throwType).toBe('bullet');
    expect(t.tick).toBe(pressTick);
  });
});
