import { describe, expect, it } from 'vitest';
import { idleIntent, type AthleteIntent, type DevCommand, type DevHooks } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import type { PlayEngine } from '@/game/play-engine';
import type { Athlete, PlayState } from '@/game/play-types';
import { FIELD_LENGTH, FIELD_WIDTH } from '@/game/types';
import { ahead, build, hasEvent, scripted, ticksSinceSnap, toward } from '../game/engine/helpers';

const rbRun = { 'off:RB': (a: Athlete, s: PlayState): AthleteIntent => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) };
/** Defenders stand still: nothing but the dev command decides the play. */
const quiet = scripted(rbRun, () => idleIntent('idle'));
const runPlay = { offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', ruleset: 'arcade' as const };

/** Ticks until `ready` holds (or the play dies), then queues `cmd` on the engine. */
const tickUntil = (engine: PlayEngine, ready: (s: PlayState) => boolean, max = 600): void => {
  for (let i = 0; i < max && !engine.isDead && !ready(engine.state); i++) engine.tick();
  expect(engine.isDead).toBe(false);
};
const rbHasBall = (s: PlayState): boolean => s.ball.carrierId === 'off:RB';
const finish = (engine: PlayEngine) => assertValidOutcome(engine.run());

describe('dev commands', () => {
  it('teleport moves an athlete (and the ball he carries) next tick without phantom fatigue distance', () => {
    const { engine } = build({ ...runPlay, seed: 5 }, {}, { decider: quiet, dev: {} });
    tickUntil(engine, rbHasBall);
    const target = { x: 10, y: engine.state.losY + 15 };
    engine.queueDevCommand({ type: 'teleport', athleteId: 'off:RB', pos: target });
    engine.tick();
    const rb = engine.state.athletes.find((a) => a.id === 'off:RB')!;
    expect(Math.hypot(rb.pos.x - target.x, rb.pos.y - target.y)).toBeLessThan(0.5);
    expect(Math.hypot(engine.state.ball.pos.x - rb.pos.x, engine.state.ball.pos.y - rb.pos.y)).toBeLessThan(1e-9);
    expect(engine.debugEnv().tracks['off:RB']!.distance).toBeLessThan(12);
    expect(String(engine.state.debug.dev)).toContain('teleport off:RB');
    // Out-of-field targets are clamped inside.
    engine.queueDevCommand({ type: 'teleport', athleteId: 'def:FS', pos: { x: -40, y: 500 } });
    engine.tick();
    const fs = engine.state.athletes.find((a) => a.id === 'def:FS')!;
    expect(fs.pos.x).toBeGreaterThanOrEqual(0);
    expect(fs.pos.y).toBeLessThanOrEqual(FIELD_LENGTH);
    finish(engine);
  });

  it('teleports apply pre-snap while ball commands wait for the snap', () => {
    const { engine } = build({ ...runPlay, seed: 5 }, {}, { decider: quiet, dev: {} });
    engine.tick();
    expect(engine.state.phase).toBe('presnap');
    engine.queueDevCommand({ type: 'forceTouchdown', side: 'home' });
    engine.queueDevCommand({ type: 'teleport', athleteId: 'off:WR1', pos: { x: 3, y: engine.state.losY - 1 } });
    engine.tick();
    expect(engine.state.athletes.find((a) => a.id === 'off:WR1')!.pos.x).toBeLessThan(3.5);
    expect(engine.pendingDevCommands.map((c) => c.type)).toEqual(['forceTouchdown']);
    const o = finish(engine);
    expect(engine.pendingDevCommands).toHaveLength(0);
    expect(o.touchdown).toBe(true);
  });

  it('forceTouchdown scores for the offense through the live rules', () => {
    const { engine } = build({ ...runPlay, seed: 7 }, {}, { decider: quiet, dev: {} });
    tickUntil(engine, rbHasBall);
    engine.queueDevCommand({ type: 'forceTouchdown', side: 'home' });
    const o = finish(engine);
    expect(engine.state.deadReason).toBe('touchdown');
    expect(engine.state.events.some((e) => e.type === 'touchdown' && e.scorer === 'off:RB' && e.side === 'offense')).toBe(true);
    expect(o.touchdown).toBe(true);
    expect(o.turnover).toBe(false);
    expect(o.endBallOn).toBe(100);
  });

  it('forceTouchdown for the defending team strips the carrier and returns it for a defensive score', () => {
    const { engine } = build({ ...runPlay, seed: 7 }, {}, { decider: quiet, dev: {} });
    tickUntil(engine, rbHasBall);
    engine.queueDevCommand({ type: 'forceTouchdown', side: 'away' });
    const o = finish(engine);
    expect(hasEvent(engine, 'fumble')).toBe(true);
    expect(engine.state.events.some((e) => e.type === 'touchdown' && e.side === 'defense')).toBe(true);
    expect(o.touchdown).toBe(true);
    expect(o.turnover).toBe(true);
    expect(o.turnoverType).toBe('fumble');
  });

  it('forceTurnover: the carrier fumbles and the nearest opponent recovers through the fumble path', () => {
    for (const seed of [2, 9]) {
      const { engine } = build({ ...runPlay, seed }, {}, { decider: quiet, dev: {} });
      tickUntil(engine, (s) => rbHasBall(s) && ticksSinceSnap(s) > 30);
      const rb = engine.state.athletes.find((a) => a.id === 'off:RB')!;
      const nearest = engine.state.athletes.filter((a) => a.side === 'defense').sort((p, q) => Math.hypot(p.pos.x - rb.pos.x, p.pos.y - rb.pos.y) - Math.hypot(q.pos.x - rb.pos.x, q.pos.y - rb.pos.y))[0]!;
      engine.queueDevCommand({ type: 'forceTurnover' });
      engine.tick();
      const fumble = engine.state.events.find((e) => e.type === 'fumble');
      const recovery = engine.state.events.find((e) => e.type === 'recovery');
      expect(fumble && fumble.type === 'fumble' ? fumble.carrier : null).toBe('off:RB');
      expect(recovery && recovery.type === 'recovery' ? [recovery.by, recovery.side] : null).toEqual([nearest.id, 'defense']);
      expect(engine.state.ball.carrierId).toBe(nearest.id);
      const o = finish(engine);
      expect(o.turnover).toBe(true);
      expect(o.turnoverType).toBe('fumble');
      expect(o.stats.some((d) => d.stat === 'fumblesLost')).toBe(true);
    }
  });

  it('spawnBall hands the ball to a teammate, or to an opponent as a turnover', () => {
    const mate = build({ ...runPlay, seed: 3 }, {}, { decider: quiet, dev: {} }).engine;
    tickUntil(mate, rbHasBall);
    mate.queueDevCommand({ type: 'spawnBall', mode: 'toAthlete', athleteId: 'off:WR1' });
    mate.tick();
    expect(mate.state.ball.carrierId).toBe('off:WR1');
    expect(mate.state.athletes.find((a) => a.id === 'off:WR1')!.hasBall).toBe(true);
    expect(mate.state.athletes.find((a) => a.id === 'off:RB')!.hasBall).toBe(false);
    expect(finish(mate).turnover).toBe(false);

    const opp = build({ ...runPlay, seed: 3 }, {}, { decider: quiet, dev: {} }).engine;
    tickUntil(opp, rbHasBall);
    opp.queueDevCommand({ type: 'spawnBall', mode: 'toAthlete', athleteId: 'def:MLB', pos: { x: 20, y: opp.state.losY + 5 } });
    opp.tick();
    expect(opp.state.ball.carrierId).toBe('def:MLB');
    expect(hasEvent(opp, 'recovery')).toBe(true);
    const o = finish(opp);
    expect(o.turnover).toBe(true);
  });

  it('spawnBall loose drops a live fumble at the spot', () => {
    const { engine } = build({ ...runPlay, seed: 6 }, {}, { decider: quiet, dev: {} });
    tickUntil(engine, rbHasBall);
    const spot = { x: FIELD_WIDTH / 2 + 8, y: engine.state.losY + 6 };
    engine.queueDevCommand({ type: 'spawnBall', mode: 'loose', pos: spot });
    engine.tick();
    const b = engine.state.ball;
    expect(b.phase).toBe('loose');
    expect(b.kind).toBe('fumble');
    expect(Math.hypot(b.pos.x - spot.x, b.pos.y - spot.y)).toBeLessThan(0.5);
    expect(engine.state.athletes.some((a) => a.hasBall)).toBe(false);
    expect(hasEvent(engine, 'fumble')).toBe(true);
    finish(engine);
  });

  it('drains the shared DevHooks inbox at the start of a tick and drops commands for a dead play', () => {
    const hooks: DevHooks = { commands: [] };
    const { engine } = build({ ...runPlay, seed: 8 }, {}, { decider: quiet, dev: hooks });
    tickUntil(engine, rbHasBall);
    hooks.commands!.push({ type: 'forceTouchdown', side: 'home' } satisfies DevCommand);
    engine.tick();
    expect(hooks.commands).toHaveLength(0);
    expect(engine.isDead).toBe(true);
    expect(engine.outcome?.touchdown).toBe(true);
    hooks.commands!.push({ type: 'forceTurnover' });
    engine.tick();
    expect(engine.outcome?.turnover).toBe(false);
  });

  it('discards inbox commands issued for another play', () => {
    const hooks: DevHooks = { commands: [{ type: 'forceTouchdown', side: 'home' }], commandPlayIndex: 41 };
    const { engine } = build({ ...runPlay, seed: 8 }, {}, { decider: quiet, dev: hooks });
    expect(engine.state.ctx.playIndex).not.toBe(41);
    engine.tick();
    expect(hooks.commands).toHaveLength(0);
    expect(engine.pendingDevCommands).toHaveLength(0);
    expect(String(engine.state.debug.dev)).toContain('stale');
    expect(finish(engine).touchdown).toBe(false);
  });

  it('hooks attached to a play already running take effect; detaching drops queued commands', () => {
    const { engine } = build({ ...runPlay, seed: 5 }, {}, { decider: quiet });
    engine.tick();
    engine.queueDevCommand({ type: 'forceTouchdown', side: 'home' });
    engine.attachDevHooks(null);
    expect(engine.pendingDevCommands).toHaveLength(0);
    const hooks: DevHooks = { freezeAi: true, commands: [] };
    engine.attachDevHooks(hooks);
    tickUntil(engine, (s) => s.phase === 'live' && s.tick > s.snapTick + 1);
    expect(Object.values(engine.state.intents).every((i) => i.debug === 'dev: frozen')).toBe(true);
    hooks.freezeAi = false;
    hooks.commands!.push({ type: 'forceTouchdown', side: 'home' });
    expect(finish(engine).touchdown).toBe(true);
  });

  it('a pass in the air is intercepted by forceTurnover', () => {
    const throwNow = (a: Athlete, s: PlayState): AthleteIntent =>
      (a.hasBall && ticksSinceSnap(s) > 50 ? { ...idleIntent('throw'), action: 'throw', targetId: 'off:WR2', throwType: 'lob' } : idleIntent('wait'));
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', ruleset: 'arcade', seed: 4 }, {}, {
      decider: scripted({ 'off:QB': throwNow, 'off:WR2': (_a, s) => ahead(s, 'offense') }, () => idleIntent('idle')), dev: {},
    });
    tickUntil(engine, (s) => s.ball.phase === 'inAir' && s.ball.kind === 'pass');
    engine.queueDevCommand({ type: 'forceTurnover' });
    engine.tick();
    expect(hasEvent(engine, 'interception')).toBe(true);
    const o = finish(engine);
    expect(o.turnoverType).toBe('interception');
  });
});
