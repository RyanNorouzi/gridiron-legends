import { describe, expect, it, vi } from 'vitest';
import { AUTO_SUB, depthStarter, roleSlotIndex, substitutionCandidates, substitutionRoles } from '@/ui/game/substitutions';
import { GameScreen } from '@/ui/screens/game';
import { PauseScreen } from '@/ui/screens/pause';
import { SubstitutionsScreen } from '@/ui/screens/substitutions';
import { makeInput } from '../render/fake-ctx';
import { autoplay, makeSession, makeUi } from './fixtures';

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

describe('manual substitutions', () => {
  it('AUTO previews the depth player for each slot of a position, skipping men sent in elsewhere', () => {
    expect([roleSlotIndex('WR1'), roleSlotIndex('WR2'), roleSlotIndex('CB3'), roleSlotIndex('MLB2'), roleSlotIndex('QB')]).toEqual([0, 1, 2, 1, 0]);
    const f = makeSession({ setup: { ...human, seed: 7 } });
    const depth = f.setup.home.team.depthChart.WR;
    expect(depthStarter(f.setup, 'home', 'WR', f.session.state, 0)?.id).toBe(depth[0]);
    expect(depthStarter(f.setup, 'home', 'WR', f.session.state, 1)?.id).toBe(depth[1]);
    expect(depthStarter(f.setup, 'home', 'WR', f.session.state, 0, new Set([depth[0]!]))?.id).toBe(depth[1]);
  });

  it('lists the roles the playbooks field and the healthy players who can take them', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    const roles = substitutionRoles(f.setup, 'home', f.session.registry);
    expect(roles[0]?.unit).toBe('offense');
    expect(roles.map((r) => r.role)).toContain('QB');
    const qbs = substitutionCandidates(f.setup, 'home', 'QB', f.session.state);
    expect(qbs.length).toBeGreaterThan(1);
    expect(qbs[0]?.position).toBe('QB');
  });

  it('are reachable from the pause menu and the chosen player takes the field at the next snap', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { ...human, seed: 7 } });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense' && s.state.kickoffPending === null, coinToss: 'receive' });
    screen.openPause(ui.services);
    const pause = ui.stack.top;
    if (!(pause instanceof PauseScreen)) throw new Error('expected pause');
    expect(pause.list.items.map((i) => i.id)).toContain('subs');
    pause.activate('subs');
    const subs = ui.stack.top;
    if (!(subs instanceof SubstitutionsScreen)) throw new Error('expected substitutions');
    subs.render(ui.rc);
    const chosen = subs.cycle('QB', 1);
    expect(chosen).not.toBeNull();
    expect(f.session.userSubstitutions?.().QB).toBe(chosen);
    expect(subs.list.items.find((i) => i.id === 'QB')?.label).toContain('*');
    ui.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(ui.stack.top).toBe(pause);
    autoplay(f.session, { until: (s) => s.stage.kind === 'live' && s.stage.meta.ctx.special === 'none' });
    const live = f.session.stage;
    if (live.kind !== 'live') throw new Error('expected live');
    expect(live.meta.ctx.offenseLineup.QB?.id).toBe(chosen);
  });

  it('each role cycles through AUTO: stepping back onto it removes the manual override', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense' && s.state.kickoffPending === null, coinToss: 'receive' });
    const subs = new SubstitutionsScreen(f.session);
    ui.stack.push(subs);
    const qbs = substitutionCandidates(f.setup, 'home', 'QB', f.session.state);
    const auto = depthStarter(f.setup, 'home', 'QB', f.session.state);
    expect(subs.list.items.find((i) => i.id === 'QB')?.value).toContain('AUTO');
    expect(subs.cycle('QB', 1)).toBe(qbs[0]?.id);
    expect(subs.cycle('QB', 1)).toBe(qbs[1]?.id);
    expect(f.session.userSubstitutions?.().QB).toBe(qbs[1]?.id);
    expect(subs.cycle('QB', -1)).toBe(qbs[0]?.id);
    expect(subs.cycle('QB', -1)).toBe(AUTO_SUB);
    expect(f.session.userSubstitutions?.().QB).toBeUndefined();
    const row = subs.list.items.find((i) => i.id === 'QB');
    expect(row?.label).not.toContain('*');
    expect(row?.value).toContain('AUTO');
    // Backwards from AUTO wraps to the last candidate.
    expect(subs.cycle('QB', -1)).toBe(qbs[qbs.length - 1]?.id);
    subs.cycle('QB', 1);
    expect(f.session.userSubstitutions?.().QB).toBeUndefined();
    autoplay(f.session, { until: (s) => s.stage.kind === 'live' && s.stage.meta.ctx.special === 'none' });
    const live = f.session.stage;
    if (live.kind !== 'live') throw new Error('expected live');
    expect(live.meta.ctx.offenseLineup.QB?.id).toBe(auto?.id);
  });
});
