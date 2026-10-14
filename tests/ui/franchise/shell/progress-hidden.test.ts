import { afterEach, describe, expect, it, vi } from 'vitest';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { createTestFranchiseContext } from '@/ui/franchise/context';
import { SimProgressScreen } from '@/ui/franchise/shell/progress-screen';
import { SimJob, type SimJobResult } from '@/ui/franchise/shell/sim-job';
import { inlineAsyncSimulator } from '@/ui/franchise/shell/sim-workers';
import { leagueAt } from './helpers';

/** A document stand-in whose visibility the test flips (browsers pause animation frames while hidden). */
const fakeDocument = (hidden: boolean) => {
  const listeners = new Set<() => void>();
  return {
    hidden,
    addEventListener: (_t: string, cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_t: string, cb: () => void) => { listeners.delete(cb); },
    set(h: boolean) { this.hidden = h; for (const cb of [...listeners]) cb(); },
    listeners,
  };
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('SimProgressScreen in a hidden tab', () => {
  it('keeps simulating without animation frames (worker path) and finishes the job with no update() calls', async () => {
    const doc = fakeDocument(false);
    vi.stubGlobal('document', doc);
    const league = leagueAt(43, 'regularSeason');
    const fc = createTestFranchiseContext(league);
    const job = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator, remote: inlineAsyncSimulator(fallbackSimulator) });
    const done: SimJobResult[] = [];
    const screen = new SimProgressScreen(job, { onDone: (r) => done.push(r), cancellable: false });
    fc.stack.push(screen);
    expect(doc.listeners.size).toBe(1);
    doc.set(true);
    expect(screen.backgroundPumping).toBe(true);
    for (let i = 0; i < 200 && done.length === 0; i++) await new Promise<void>((r) => setTimeout(r, 0));
    expect(done).toHaveLength(1);
    expect(done[0]!.error).toBeNull();
    expect(done[0]!.weeks).toHaveLength(1);
    expect(fc.stack.top).not.toBe(screen);
    // The overlay left the stack: its listener is gone.
    expect(doc.listeners.size).toBe(0);
    const sync = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator }).runToEnd();
    expect(JSON.stringify(done[0]!.league)).toBe(JSON.stringify(sync.league));
  }, 60000);

  it('hands back to the frame loop when the tab is shown again, and a synchronous job also advances while hidden', async () => {
    const doc = fakeDocument(true);
    vi.stubGlobal('document', doc);
    const league = leagueAt(43, 'regularSeason');
    const fc = createTestFranchiseContext(league);
    const job = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator, remote: null });
    const done: SimJobResult[] = [];
    const screen = new SimProgressScreen(job, { onDone: (r) => done.push(r) });
    fc.stack.push(screen);
    expect(screen.backgroundPumping).toBe(true);
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(job.weekProgress?.done ?? 0).toBeGreaterThan(0);
    doc.set(false);
    for (let i = 0; i < 20 && screen.backgroundPumping; i++) await new Promise<void>((r) => setTimeout(r, 0));
    expect(screen.backgroundPumping).toBe(false);
    expect(done).toHaveLength(0);
    for (let i = 0; i < 400 && done.length === 0; i++) fc.tick();
    expect(done).toHaveLength(1);
    expect(done[0]!.error).toBeNull();
  }, 60000);
});
