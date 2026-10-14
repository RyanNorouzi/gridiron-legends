import { describe, expect, it } from 'vitest';
import { dist } from '@/core/vec2';
import { getDecider } from '@/ai/index';
import { gapLocalX, gapPoint, leadBlockIntent, passBlockIntent, passProtection, perceivedRushers, runBlockIntent, runBlockTarget, stalkBlockIntent } from '@/ai/blocking';
import { toField, toLocal } from '@/ai/route-running';
import { TICK_DT } from '@/core/time';
import { ensureOffense, fixture, place, runSim, rushPolicy, snapNow } from './sim';

const RUSHERS = ['DE1', 'DT1', 'DT2', 'DE2', 'OLB1', 'MLB'];

describe('blocking', () => {
  it('pass protection assigns every lineman a distinct rusher and picks up the inside-most blitzer first', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover0-lbBlitz', seed: 2 });
    snapNow(fx.state);
    const prot = passProtection(fx.state);
    const ol = ['LT', 'LG', 'C', 'RG', 'RT'].map((r) => `off:${r}`);
    const targets = ol.map((id) => prot.assignment.get(id));
    for (const t of targets) expect(t).toBeDefined();
    expect(new Set(targets).size).toBe(5);
    expect(prot.assignment.get('off:C')).toBe('def:MLB');
    expect(prot.overloadSide).toBe(-1);
    const rusherIds = new Set(perceivedRushers(fx.state, 1).map((r) => r.id));
    for (const t of targets) expect(rusherIds.has(t!)).toBe(true);
  });

  it('pass blockers engage the rusher they were assigned as the rush arrives', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover0-lbBlitz', seed: 2, difficulty: 'legend' });
    const ol = ['LT', 'LG', 'C', 'RG', 'RT'];
    const blocked: Record<string, Set<string>> = {};
    const targetAt08: Record<string, string | null> = {};
    for (const r of ol) blocked[r] = new Set();
    // The line now sets and lets the rush come (the centre waits in his set for the blitzing MLB, still ~3 yd off at
    // 0.8 s in this scripted rush), so the window runs to 1.1 s; the assignment is checked at 0.8 s, before the
    // scripted rushers (no engine engagements in this harness) run through the line.
    runSim(fx, {
      seconds: 1.1, defense: rushPolicy(RUSHERS, false), idleRoles: ['QB'],
      onTick: (state, t) => {
        for (const r of ol) {
          const intent = state.intents[`off:${r}`];
          if (intent?.action === 'block' && intent.targetId) blocked[r]!.add(intent.targetId);
          if (Math.abs(t - 0.8) < 0.009) targetAt08[r] = fx.byRole('offense', r).ai.blockTargetId;
        }
      },
    });
    const rusherIds = new Set(RUSHERS.map((r) => `def:${r}`));
    let engaged = 0;
    for (const r of ol) {
      const target = targetAt08[r] ?? null;
      expect(target).not.toBeNull();
      expect(rusherIds.has(target!)).toBe(true);
      if (blocked[r]!.size > 0) engaged++;
      for (const id of blocked[r]!) expect(rusherIds.has(id)).toBe(true);
    }
    expect(engaged).toBeGreaterThanOrEqual(4);
    expect(blocked.C!.has('def:MLB')).toBe(true);
  });

  it('blitz perception grows with blocking IQ', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover0-lbBlitz', seed: 2 });
    snapNow(fx.state);
    place(fx.byRole('defense', 'OLB1'), toField({ x: -2, y: 7 }, fx.state));
    const dull = perceivedRushers(fx.state, 0.2).map((r) => r.role);
    const sharp = perceivedRushers(fx.state, 1).map((r) => r.role);
    expect(sharp).toContain('OLB1');
    expect(dull).not.toContain('OLB1');
    expect(dull).toContain('DE1');
  });

  it('run blockers take the man over their gap and climb when the gap is empty', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    snapNow(fx.state);
    const rt = runBlockTarget(fx.byRole('offense', 'RT'), fx.state);
    expect(rt.mode).toBe('gap');
    expect(rt.target!.id).toBe('def:DE2');
    const lg = runBlockTarget(fx.byRole('offense', 'LG'), fx.state);
    expect(lg.mode).toBe('gap');
    expect(lg.target!.id).toBe('def:DT1');
    place(fx.byRole('defense', 'DE2'), toField({ x: 12, y: 1 }, fx.state));
    const climb = runBlockTarget(fx.byRole('offense', 'RT'), fx.state);
    expect(climb.mode).toBe('climb');
    expect(['def:OLB2', 'def:MLB', 'def:SS']).toContain(climb.target!.id);
  });

  it('run blockers get in front of their man and fire the block action', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 1, difficulty: 'legend', quality: 'elite' });
    const res = runSim(fx, { seconds: 1.0 });
    let engaged = 0;
    for (const r of ['LT', 'LG', 'C', 'RG', 'RT', 'TE1']) {
      const b = fx.byRole('offense', r);
      const last = res.last[b.id]!;
      if (last.action === 'block' && b.ai.scratch.misread === 0) {
        engaged++;
        const target = fx.state.athletes.find((a) => a.id === last.targetId)!;
        expect(dist(b.pos, target.pos)).toBeLessThan(1.6);
      }
    }
    expect(engaged).toBeGreaterThanOrEqual(4);
  });

  it('a guard pulls across the formation on power', () => {
    const fx = fixture({ offensePlayId: 'iform-power-right', defensePlayId: '43-runStop-cover1', seed: 2 });
    snapNow(fx.state);
    const lg = fx.byRole('offense', 'LG');
    expect(lg.assignment.gap).toBe('C-right');
    expect(runBlockTarget(lg, fx.state).mode).toBe('pull');
    runSim(fx, { seconds: 1.6 });
    expect(toLocal(lg.pos, fx.state).x).toBeGreaterThan(1);
    expect(lg.ai.decision.startsWith('pull')).toBe(true);
  });

  it('the fullback leads through the hole and blocks the first defender in the lane', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    const fb = fx.byRole('offense', 'FB');
    const res = runSim(fx, { seconds: 1.2 });
    const targetId = fb.ai.blockTargetId;
    expect(targetId).not.toBeNull();
    const target = fx.state.athletes.find((a) => a.id === targetId)!;
    expect(Math.abs(toLocal(target.pos, fx.state).x - gapLocalX('A-right'))).toBeLessThanOrEqual(2.2);
    expect(res.last[fb.id]!.debug.startsWith('lead')).toBe(true);
    expect(dist(fb.pos, gapPoint('A-right', fx.state))).toBeLessThan(4);
  });

  it('double teams a tackle then climbs after the hold time', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 1, difficulty: 'legend', quality: 'elite' });
    const lt = fx.byRole('offense', 'LT');
    const lg = fx.byRole('offense', 'LG');
    const seen = new Set<string>();
    runSim(fx, { seconds: 1.6, onTick: () => { seen.add(lt.ai.decision); seen.add(lg.ai.decision); } });
    const labels = [...seen];
    expect(labels.some((l) => l.includes('double') || l.includes('climb'))).toBe(true);
  });

  it('receivers stalk block the nearest defender on a run', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    const wr = fx.byRole('offense', 'WR2');
    const res = runSim(fx, { seconds: 2 });
    expect(wr.ai.blockTargetId).toBe('def:CB2');
    expect(res.last[wr.id]!.debug.startsWith('stalk')).toBe(true);
    const intent = stalkBlockIntent(wr, fx.state, fx.byRole('offense', 'RB').pos);
    expect(intent.targetId === null || intent.action === 'block').toBe(true);
  });

  it('chip release chips the edge then runs the release route', () => {
    ensureOffense();
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3 });
    const te = fx.byRole('offense', 'TE1');
    te.assignment = { type: 'chipRelease', releaseRoute: 'stick' };
    expect(getDecider(te)).toBeDefined();
    let chipTarget: string | null = null;
    runSim(fx, { seconds: 2, idleRoles: ['QB'], onTick: (_s, t) => { if (t < 0.5 && te.ai.decision.startsWith('chip')) chipTarget = te.ai.blockTargetId; } });
    expect(chipTarget).not.toBeNull();
    expect(['def:DE2', 'def:OLB2']).toContain(chipTarget);
    expect(te.ai.decision.startsWith('route stick') || te.ai.decision.startsWith('settle')).toBe(true);
    expect(te.ai.routeIndex).toBeGreaterThanOrEqual(1);
  });

  it('a blocker locked up by the engine keeps blocking that defender, and protection does not double him', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover0-lbBlitz', seed: 2 });
    snapNow(fx.state);
    const lt = fx.byRole('offense', 'LT');
    const de2 = fx.byRole('defense', 'DE2');
    place(de2, { x: lt.pos.x + 0.6, y: lt.pos.y + fx.state.ctx.direction * 0.7 });
    lt.engagedWith = de2.id;
    de2.engagedWith = lt.id;
    lt.state = 'engaged';
    de2.state = 'engaged';
    const prot = passProtection(fx.state);
    expect(prot.assignment.get(lt.id)).toBe(de2.id);
    expect([...prot.assignment.entries()].filter(([, r]) => r === de2.id)).toHaveLength(1);
    const pass = passBlockIntent(lt, fx.state);
    expect(pass.action).toBe('block');
    expect(pass.targetId).toBe(de2.id);
    const run = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    snapNow(run.state);
    const rg = run.byRole('offense', 'RG');
    const fb = run.byRole('offense', 'FB');
    const mlb = run.byRole('defense', 'MLB');
    place(mlb, { x: rg.pos.x - 0.5, y: rg.pos.y + run.state.ctx.direction * 0.8 });
    rg.engagedWith = mlb.id;
    mlb.engagedWith = rg.id;
    const rb = runBlockIntent(rg, run.state, TICK_DT);
    expect(rb.action).toBe('block');
    expect(rb.targetId).toBe(mlb.id);
    expect(rb.debug).toContain('engaged');
    fb.engagedWith = mlb.id;
    const lead = leadBlockIntent(fb, run.state);
    expect(lead.targetId).toBe(mlb.id);
  });
});
