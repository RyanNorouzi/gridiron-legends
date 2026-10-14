import { describe, expect, it } from 'vitest';
import { boxCount, keyCrashes, readKeyFor, rpoDecision, runBlockerCount } from '@/ai/rpo';
import { toField } from '@/ai/route-running';
import { fixture, gluePolicy, place, runSim, snapNow } from './sim';

describe('rpo', () => {
  it('counts the box and the blockers', () => {
    const fx = fixture({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover3-zone', seed: 1 });
    snapNow(fx.state);
    expect(boxCount(fx.state)).toBe(7);
    expect(runBlockerCount(fx.state)).toBe(6);
    place(fx.byRole('defense', 'OLB1'), toField({ x: -4, y: 12 }, fx.state));
    place(fx.byRole('defense', 'MLB'), toField({ x: 0, y: 12 }, fx.state));
    expect(boxCount(fx.state)).toBe(5);
  });

  it('throws against a loaded box and gives against a light one', () => {
    for (const seed of [1, 2, 3]) {
      const loaded = fixture({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover3-zone', seed });
      snapNow(loaded.state);
      const a = rpoDecision(loaded.byRole('offense', 'QB'), loaded.state);
      expect(a.boxCount).toBeGreaterThan(a.blockers);
      expect(a.decision).toBe(a.misread ? 'give' : 'throw');
      expect(a.readKey).toBe('def:OLB1');
      const light = fixture({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover3-zone', seed });
      snapNow(light.state);
      place(light.byRole('defense', 'OLB1'), toField({ x: -4, y: 12 }, light.state));
      place(light.byRole('defense', 'MLB'), toField({ x: 0, y: 12 }, light.state));
      const b = rpoDecision(light.byRole('offense', 'QB'), light.state);
      expect(b.boxCount).toBeLessThanOrEqual(b.blockers);
      expect(['give', 'keep']).toContain(b.misread ? 'throw' : b.decision);
      if (!b.misread) expect(b.decision).not.toBe('throw');
    }
  });

  it('throws when the conflict defender fills even with numbers', () => {
    const fx = fixture({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover3-zone', seed: 4 });
    snapNow(fx.state);
    place(fx.byRole('defense', 'MLB'), toField({ x: 0, y: 12 }, fx.state));
    place(fx.byRole('defense', 'DE2'), toField({ x: 12, y: 1 }, fx.state));
    const key = readKeyFor(fx.byRole('offense', 'QB'), fx.state)!;
    expect(key.id).toBe('def:OLB1');
    key.vel = { x: (fx.state.ctx.ballX - key.pos.x) * 2, y: (fx.state.losY - key.pos.y) * 2 };
    expect(keyCrashes(key, { x: fx.state.ctx.ballX, y: fx.state.losY })).toBe(true);
    const r = rpoDecision(fx.byRole('offense', 'QB'), fx.state);
    expect(r.keyCrashing).toBe(true);
    expect(r.decision).toBe(r.misread ? 'give' : 'throw');
  });

  it('zone read: gives when the end stays home, keeps when he crashes', () => {
    for (const seed of [1, 2]) {
      const home = fixture({ offensePlayId: 'pistol-zoneRead', defensePlayId: '43-cover3-zone', seed });
      snapNow(home.state);
      // The line zones right and leaves the backside (left) end unblocked: he is the man the QB reads.
      const key = readKeyFor(home.byRole('offense', 'QB'), home.state)!;
      expect(key.id).toBe('def:DE1');
      const g = rpoDecision(home.byRole('offense', 'QB'), home.state);
      expect(g.decision).toBe(g.misread ? 'keep' : 'give');
      const crash = fixture({ offensePlayId: 'pistol-zoneRead', defensePlayId: '43-cover3-zone', seed });
      snapNow(crash.state);
      const de = crash.byRole('defense', 'DE1');
      const rb = crash.byRole('offense', 'RB');
      de.vel = { x: (rb.pos.x - de.pos.x) * 1.5, y: (rb.pos.y - de.pos.y) * 1.5 };
      const k = rpoDecision(crash.byRole('offense', 'QB'), crash.state);
      expect(k.keyCrashing).toBe(true);
      expect(k.decision).toBe(k.misread ? 'give' : 'keep');
    }
  });

  it('caches the decision for the rest of the play', () => {
    const fx = fixture({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover3-zone', seed: 2 });
    snapNow(fx.state);
    const qb = fx.byRole('offense', 'QB');
    const first = rpoDecision(qb, fx.state);
    place(fx.byRole('defense', 'OLB1'), toField({ x: -4, y: 12 }, fx.state));
    place(fx.byRole('defense', 'MLB'), toField({ x: 0, y: 12 }, fx.state));
    const again = rpoDecision(qb, fx.state);
    expect(again.decision).toBe(first.decision);
    expect(again.readKey).toBe(first.readKey);
    expect(again.reason).toBe('cached');
  });

  it('the QB acts on the read: throws the slant vs a loaded box, hands off vs a light box', () => {
    const loaded = fixture({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover3-zone', seed: 1 });
    const r1 = runSim(loaded, { seconds: 3 });
    const acts1 = r1.events.filter((e) => e.id === 'off:QB');
    const qbRead = loaded.byRole('offense', 'QB').ai.scratch;
    if (qbRead.rpoMisread !== 1) {
      expect(acts1.some((e) => e.action === 'throw')).toBe(true);
      expect(acts1.some((e) => e.action === 'handoff')).toBe(false);
    }
    const light = fixture({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover3-zone', seed: 1 });
    place(light.byRole('defense', 'OLB1'), toField({ x: -4, y: 12 }, light.state));
    place(light.byRole('defense', 'MLB'), toField({ x: 0, y: 12 }, light.state));
    const r2 = runSim(light, { seconds: 3 });
    const acts2 = r2.events.filter((e) => e.id === 'off:QB');
    if (light.byRole('offense', 'QB').ai.scratch.rpoMisread !== 1) {
      expect(acts2.some((e) => e.action === 'handoff' || e.debug.startsWith('keep'))).toBe(true);
      expect(acts2.some((e) => e.action === 'throw')).toBe(false);
    }
  });

  it('tucks and runs when the quick throw is not there instead of holding the ball', () => {
    let tucks = 0;
    for (const seed of [1, 2, 3, 4]) {
      const fx = fixture({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover3-zone', seed });
      const qb = fx.byRole('offense', 'QB');
      let tuckAt = Infinity;
      const res = runSim(fx, {
        seconds: 3, defense: gluePolicy({ CB1: 'WR3', CB2: 'WR1', SS: 'WR3', FS: 'WR1' }),
        onTick: (_s, t) => { if (qb.ai.decision.startsWith('rpo tuck')) tuckAt = Math.min(tuckAt, t); },
      });
      if (qb.ai.scratch.rpoChoice !== 2) continue; // read was give/keep this seed
      expect(res.events.some((e) => e.id === qb.id && e.action === 'throw'), `seed ${seed}`).toBe(false);
      if (tuckAt < Infinity) { tucks++; expect(tuckAt).toBeLessThan(2); }
      expect(qb.ai.scratch.keep === 1 || qb.ai.scratch.scrambling === 1, `seed ${seed}`).toBe(true);
    }
    expect(tucks).toBeGreaterThanOrEqual(1);
  });
});
