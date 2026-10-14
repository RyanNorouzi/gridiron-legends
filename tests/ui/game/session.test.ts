import { describe, expect, it } from 'vitest';
import { makePenalty, outcomeAt } from '@/game/outcome-factory';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import type { GameSession } from '@/ui/game/session-types';
import { autoplay, baseScript, incompleteScript, makeSession } from './fixtures';

const isStage = (kind: GameSession['stage']['kind']) => (s: GameSession): boolean => s.stage.kind === kind;

describe('AI vs AI session', () => {
  it('runs from start to final through the fast sim with summaries, banners and play-by-play', () => {
    const f = makeSession({ setup: { seed: 11, ruleset: { quarterLengthSec: 150 } } });
    f.session.start();
    expect(f.session.userSide).toBeNull();
    const steps = autoplay(f.session, { until: isStage('final') });
    expect(steps).toBeGreaterThan(20);
    expect(f.session.state.phase).toBe('final');
    expect(f.plays).toHaveLength(0);
    expect(f.fastSim.mock.calls.length).toBe(f.session.state.playLog.length);
    const stage = f.session.stage;
    if (stage.kind !== 'final') throw new Error('expected final');
    expect(stage.result.score).toEqual(f.session.state.score);
    expect(stage.result.playLog.length).toBe(f.session.state.playLog.length);
    expect(f.events.some((e) => e.type === 'banner' && e.text === 'TOUCHDOWN')).toBe(true);
    expect(f.events.some((e) => e.type === 'banner' && e.text === 'FINAL')).toBe(true);
    expect(f.events.filter((e) => e.type === 'pbp').length).toBe(f.session.state.playLog.length);
    expect(f.events.some((e) => e.type === 'game' && e.event.type === 'halftime')).toBe(true);
    expect(f.session.cameraContext()).toBe('watch');
  });

  it('is deterministic per seed', () => {
    const a = makeSession({ setup: { seed: 5, ruleset: { quarterLengthSec: 120 } } });
    const b = makeSession({ setup: { seed: 5, ruleset: { quarterLengthSec: 120 } } });
    autoplay(a.session, { until: isStage('final') });
    autoplay(b.session, { until: isStage('final') });
    expect(a.session.state.score).toEqual(b.session.state.score);
    expect(a.session.state.playLog.length).toBe(b.session.state.playLog.length);
  });
});

describe('human session flow', () => {
  const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

  it('surfaces the coin toss, runs the kickoff return live with the returner and then asks for a play call', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    f.session.start();
    const first = f.session.stage;
    expect(['coinToss', 'playcall', 'live']).toContain(first.kind);
    if (first.kind === 'coinToss') {
      expect(first.side).toBe('home');
      f.session.answerCoinToss('receive');
    }
    autoplay(f.session, { until: isStage('playcall'), coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    expect(stage.request.side).toBe('home');
    expect(stage.request.unit).toBe('offense');
    expect(stage.request.offensePlays.map((p) => p.id)).toContain('pass-curl');
    expect(stage.request.offensePlays.every((p) => p.concept !== 'kickoff' && p.concept !== 'punt')).toBe(true);
    expect(stage.request.summary).toMatch(/1ST & 10/);
    const kickReturn = f.plays.find((p) => p.ctx.special === 'kickoff');
    if (f.session.state.receivedOpeningKickoff === 'home') {
      expect(kickReturn).toBeDefined();
      expect(kickReturn?.ctx.controlRole).toBe('KR');
      expect(kickReturn?.ctx.offense).toBe('away');
    }
    f.session.callPlay({ offensivePlayId: 'pass-curl' });
    const live = f.session.stage;
    if (live.kind !== 'live') throw new Error('expected live');
    expect(live.meta.ctx.offensivePlay.id).toBe('pass-curl');
    expect(live.meta.ctx.controlRole).toBeNull();
    expect(live.meta.spectating).toBe(false);
    expect(live.meta.receiverSlots).toEqual(['WR1', 'WR2', 'TE1']);
    expect(f.session.cameraContext()).toBe('offense');
    const inputs = { home: { ...live.play.state.intents, move: { x: 0, y: 1 } } } as never;
    f.session.tick(inputs);
    const play = f.plays[f.plays.length - 1]!;
    expect(play.inputs).toHaveLength(1);
    expect(play.state.tick).toBe(1);
    while (f.session.stage.kind === 'live') f.session.tick();
    const post = f.session.stage;
    if (post.kind !== 'postPlay') throw new Error('expected postPlay');
    expect(post.summary.resultText).toMatch(/PASS|RUN|INCOMPLETE/);
    expect(post.summary.simulated).toBe(false);
    expect(post.summary.pbp.length).toBeGreaterThan(0);
    expect(f.session.lastSummary).toBe(post.summary);
    expect(f.session.displayPlay).toBe(play);
    f.session.update(0.5);
    expect(f.session.stage.kind).toBe('postPlay');
    f.session.continue();
    expect(f.session.stage.kind).not.toBe('postPlay');
  });

  it('the defensive call carries the controlled role and a kick by the offense overrides it with the return unit', () => {
    const f = makeSession({ setup: { ...human, seed: 3 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'defense', coinToss: 'kick' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    expect(stage.request.controlRoles).toEqual(expect.arrayContaining(['FS', 'SS', 'MLB']));
    expect(stage.request.defensePlays.map((p) => p.id)).toEqual(['cover3', 'man-blitz']);
    f.session.callPlay({ defensivePlayId: 'man-blitz', controlRole: 'MLB' });
    const live = f.session.stage;
    if (live.kind !== 'live') throw new Error('expected live');
    expect(live.meta.ctx.defensivePlay.id).toBe('man-blitz');
    expect(live.meta.ctx.controlRole).toBe('MLB');
    expect(f.session.cameraContext()).toBe('defense');
  });

  it('a penalty on the AI surfaces a decision for the human and the answer is applied', () => {
    let flagged = false;
    const script = (ctx: PlayContext): PlayOutcome => {
      if (ctx.special === 'none' && ctx.offense === 'home' && !flagged) {
        flagged = true;
        return outcomeAt(ctx.ballOn, { result: 'pass', yards: 6, timeElapsed: 6, penalties: [makePenalty('offsides')] }, 'home');
      }
      return baseScript(ctx);
    };
    const f = makeSession({ setup: { ...human, seed: 7 }, script });
    autoplay(f.session, { until: isStage('penalty'), coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'penalty') throw new Error('expected penalty');
    expect(stage.prompt.side).toBe('home');
    expect(stage.prompt.foulingSide).toBe('away');
    expect(stage.prompt.title).toContain('OFFSIDES');
    expect(stage.prompt.acceptText).toContain('5 yards');
    const before = f.session.state.playLog.length;
    f.session.answerPenalty(true);
    const post = f.session.stage;
    if (post.kind !== 'postPlay') throw new Error('expected postPlay');
    expect(f.session.state.playLog).toHaveLength(before + 1);
    expect(post.summary.entry.outcome.penalties[0]?.accepted).toBe(true);
    expect(post.summary.resultText).toContain('FLAG');
    expect(f.events.some((e) => e.type === 'banner' && e.text === 'FLAG')).toBe(true);
  });

  it('a close ruling against the human opens a challenge window; challenging can overturn it', () => {
    let reviewed = false;
    const script = (ctx: PlayContext): PlayOutcome => {
      if (ctx.special === 'none' && ctx.offense === 'home' && !reviewed) {
        reviewed = true;
        const ruled = outcomeAt(ctx.ballOn, { result: 'incomplete', incomplete: true, timeElapsed: 6 }, 'home');
        const alt = outcomeAt(ctx.ballOn, { result: 'pass', yards: 25, firstDown: true, timeElapsed: 6 }, 'home');
        return { ...ruled, review: { call: { kind: 'catch', tick: 90, athleteId: 'off:WR1', confidence: 0 }, ifOverturned: alt } };
      }
      return baseScript(ctx);
    };
    const f = makeSession({ setup: { ...human, seed: 7 }, script });
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.challenge !== null, coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'postPlay' || !stage.challenge) throw new Error('expected challenge window');
    expect(stage.challenge.side).toBe('home');
    expect(stage.challenge.call.kind).toBe('catch');
    const ballBefore = f.session.state.ballOn;
    expect(f.session.challenge()).toBe(true);
    const after = f.session.stage;
    if (after.kind !== 'postPlay') throw new Error('expected postPlay after the review');
    expect(after.challenge).toBeNull();
    expect(after.summary.resultText).toContain('PASS +25');
    expect(f.session.state.ballOn).toBe(ballBefore + 25);
    expect(f.events.some((e) => e.type === 'banner' && e.text === 'CALL OVERTURNED')).toBe(true);
    expect(f.session.challenge()).toBe(false);
  });

  it('a challenge window that times out is declined and play moves on', () => {
    const script = (ctx: PlayContext): PlayOutcome => {
      if (ctx.special === 'none' && ctx.offense === 'home' && ctx.playIndex < 6) {
        const ruled = outcomeAt(ctx.ballOn, { result: 'incomplete', incomplete: true, timeElapsed: 6 }, 'home');
        const alt = outcomeAt(ctx.ballOn, { result: 'pass', yards: 25, firstDown: true, timeElapsed: 6 }, 'home');
        return { ...ruled, review: { call: { kind: 'catch', tick: 90, athleteId: 'off:WR1', confidence: 0.9 }, ifOverturned: alt } };
      }
      return baseScript(ctx);
    };
    const f = makeSession({ setup: { ...human, seed: 7 }, script });
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.challenge !== null, coinToss: 'receive' });
    const challenges = f.session.state.challenges.home;
    f.session.update(30);
    expect(f.session.stage.kind).toBe('playcall');
    expect(f.session.state.challenges.home).toBe(challenges);
  });

  it('skipping a live play the user controls fast-sims it and clears the field', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'live' && s.stage.meta.ctx.special === 'none', coinToss: 'receive' });
    const calls = f.fastSim.mock.calls.length;
    f.session.skipPlay();
    expect(f.fastSim.mock.calls.length).toBe(calls + 1);
    const stage = f.session.stage;
    if (stage.kind !== 'postPlay') throw new Error('expected postPlay');
    expect(stage.summary.simulated).toBe(true);
    expect(f.session.live).toBeNull();
    expect(f.session.displayPlay).toBeNull();
  });

  it('a fast-simmed play leaves no stale live play on the field', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && !s.stage.summary.simulated && s.state.playLog.length > 1, coinToss: 'receive' });
    expect(f.session.displayPlay).not.toBeNull();
    f.session.skipPlay();
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.summary.simulated });
    expect(f.session.displayPlay).toBeNull();
    expect(f.session.displayMeta).toBeNull();
  });

  it('calling a timeout from the play-call screen charges one and keeps the flow', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense', coinToss: 'receive' });
    expect(f.session.callTimeout()).toBe(true);
    expect(f.session.state.timeouts.home).toBe(2);
    expect(f.session.stage.kind).toBe('playcall');
    expect(f.events.some((e) => e.type === 'banner' && e.text === 'TIMEOUT')).toBe(true);
  });

  it('replays of live plays are available after the snap', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && !s.stage.summary.simulated, coinToss: 'receive' });
    expect(f.session.lastReplay()).not.toBeNull();
    expect(f.session.lastReplay()?.id).toBe(f.session.lastSummary?.replayId);
  });
});

describe('defense watch mode and spectating', () => {
  it('simulates the human defense until a third down prompt; jumping in yields a defensive call', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 9 }, settings: { defenseMode: 'watch' }, script: incompleteScript });
    autoplay(f.session, { until: isStage('watchPrompt'), coinToss: 'kick' });
    const stage = f.session.stage;
    if (stage.kind !== 'watchPrompt') throw new Error('expected watch prompt');
    expect(stage.prompt.reason).toBe('thirdDown');
    expect(stage.prompt.side).toBe('home');
    expect(stage.prompt.title).toMatch(/3RD/);
    expect(f.session.state.possession).toBe('away');
    expect(f.session.state.down).toBe(3);
    // The first two downs were simulated, not played live.
    expect(f.plays.filter((p) => p.ctx.offense === 'away' && p.ctx.special === 'none')).toHaveLength(0);
    expect(f.fastSim.mock.calls.length).toBeGreaterThanOrEqual(2);
    f.session.answerWatchPrompt(true);
    const call = f.session.stage;
    if (call.kind !== 'playcall') throw new Error('expected defensive playcall');
    expect(call.request.unit).toBe('defense');
    expect(call.request.controlRoles[0]).toBe('FS');
    f.session.callPlay({ defensivePlayId: 'cover3', controlRole: 'SS' });
    const live = f.session.stage;
    if (live.kind !== 'live') throw new Error('expected live');
    expect(live.meta.ctx.controlRole).toBe('SS');
    expect(live.meta.spectating).toBe(false);
  });

  it('declining the prompt simulates the play', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 9 }, settings: { defenseMode: 'watch' }, script: incompleteScript });
    autoplay(f.session, { until: isStage('watchPrompt'), coinToss: 'kick' });
    const calls = f.fastSim.mock.calls.length;
    f.session.answerWatchPrompt(false);
    expect(f.fastSim.mock.calls.length).toBe(calls + 1);
    const stage = f.session.stage;
    if (stage.kind !== 'postPlay') throw new Error('expected postPlay');
    expect(stage.summary.simulated).toBe(true);
  });

  it('playcall-only defense: the human calls, the play is simulated', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 9 }, settings: { defenseMode: 'playcallOnly' }, script: incompleteScript });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'defense', coinToss: 'kick' });
    const calls = f.fastSim.mock.calls.length;
    f.session.callPlay({ defensivePlayId: 'man-blitz' });
    expect(f.fastSim.mock.calls.length).toBe(calls + 1);
    expect(f.session.stage.kind).toBe('postPlay');
    expect(f.session.state.playLog[f.session.state.playLog.length - 1]?.defensivePlayId).toBe('man-blitz');
  });

  it('watch mode shows AI vs AI live at sim speed, can skip and can jump in', () => {
    const f = makeSession({ setup: { controllers: { home: 'watch', away: 'ai' }, userSide: 'home', seed: 4 }, settings: { simSpeed: 4 }, ticksToDead: 40 });
    autoplay(f.session, { until: (s) => s.stage.kind === 'live' && s.stage.meta.ctx.special === 'none' });
    expect(f.session.watching).toBe(true);
    expect(f.session.speed).toBe(4);
    const stage = f.session.stage;
    if (stage.kind !== 'live') throw new Error('expected live');
    expect(stage.meta.spectating).toBe(true);
    expect(f.session.cameraContext()).toBe('watch');
    f.session.tick();
    expect(stage.play.state.tick).toBe(4);
    f.session.setSpeed(8);
    f.session.tick();
    expect(stage.play.state.tick).toBe(12);
    const calls = f.fastSim.mock.calls.length;
    f.session.skipPlay();
    // The watched play is finished, not re-rolled by the fast sim; its last frame stays on screen.
    expect(f.fastSim.mock.calls.length).toBe(calls);
    expect(stage.play.isDead).toBe(true);
    expect(f.session.stage.kind).toBe('postPlay');
    expect(f.session.displayPlay).toBe(stage.play);
    const card = f.session.stage;
    if (card.kind !== 'postPlay') throw new Error('expected postPlay');
    expect(card.summary.outcome.result).toBe(stage.play.outcome?.result);
    f.session.jumpIn();
    expect(f.session.watching).toBe(false);
    expect(f.session.state.controllers.home).toBe('human');
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' || s.stage.kind === 'live' });
    const next = f.session.stage;
    expect(next.kind === 'playcall' || (next.kind === 'live' && !next.meta.spectating)).toBe(true);
    f.session.resumeWatching();
    expect(f.session.watching).toBe(true);
  });
});

describe('session wiring details', () => {
  const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

  it('hands the play registries to the live engine so pre-snap audibles can resolve', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'live' && s.stage.meta.ctx.special === 'none', coinToss: 'receive' });
    const play = f.plays[f.plays.length - 1]!;
    expect(play.opts.plays?.offensePlays?.['pass-curl']).toBeDefined();
    expect(play.opts.plays?.defensePlays?.['cover3']).toBeDefined();
    expect(play.opts.plays?.offensePlays?.['shotgun-mesh']).toBeDefined();
    expect(play.opts.registries?.offensiveFormations).toBeDefined();
  });

  it('keeps the post-play card up for the whole challenge window the controller granted', () => {
    const script = (ctx: PlayContext): PlayOutcome => {
      if (ctx.special === 'none' && ctx.offense === 'home' && ctx.playIndex < 6) {
        const ruled = outcomeAt(ctx.ballOn, { result: 'incomplete', incomplete: true, timeElapsed: 6 }, 'home');
        const alt = outcomeAt(ctx.ballOn, { result: 'pass', yards: 25, firstDown: true, timeElapsed: 6 }, 'home');
        return { ...ruled, review: { call: { kind: 'catch', tick: 90, athleteId: 'off:WR1', confidence: 0.9 }, ifOverturned: alt } };
      }
      return baseScript(ctx);
    };
    const f = makeSession({ setup: { ...human, seed: 7 }, script });
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.challenge !== null, coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'postPlay' || !stage.challenge) throw new Error('expected challenge window');
    expect(stage.remaining).toBeGreaterThanOrEqual(stage.challenge.remainingSec);
    f.session.update(stage.challenge.remainingSec - 1);
    expect(f.session.stage.kind).toBe('postPlay');
    expect(f.session.challenge()).toBe(true);
    // The ruling stays on screen (H2-15) instead of the next play call opening at once.
    expect(f.session.stage.kind).toBe('postPlay');
  });

  it('a spectator who jumps in from the prompt under defense mode "watch" plays the next snap live', () => {
    const f = makeSession({ setup: { controllers: { home: 'watch', away: 'ai' }, userSide: 'home', seed: 9 }, settings: { defenseMode: 'watch' }, script: incompleteScript });
    autoplay(f.session, { until: (s) => s.stage.kind === 'watchPrompt' && s.state.possession === 'away' });
    f.session.answerWatchPrompt(true);
    expect(f.session.watching).toBe(false);
    const call = f.session.stage;
    if (call.kind !== 'playcall') throw new Error(`expected a defensive play call, got ${call.kind}`);
    expect(call.request.unit).toBe('defense');
    f.session.callPlay({ defensivePlayId: 'cover3' });
    const live = f.session.stage;
    if (live.kind !== 'live') throw new Error(`expected live, got ${live.kind}`);
    expect(live.meta.spectating).toBe(false);
  });
});
