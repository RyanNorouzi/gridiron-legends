import { describe, expect, it } from 'vitest';
import { getDrill } from '@/game/practice';
import { TutorialMachine, type MachineChange } from '@/ui/tutorial/machine';
import { TUTORIAL_STEPS, type TutorialStep } from '@/ui/tutorial/steps';

const steps: TutorialStep[] = [
  { kind: 'info', id: 'intro', topic: 'basics', title: 'INTRO', pages: [{ heading: 'A', lines: [] }, { heading: 'B', lines: [] }] },
  { kind: 'interactive', id: 'pass', topic: 'passing', title: 'PASS', lines: [], drill: getDrill('passRoutes'), difficulty: 'rookie', goal: { kind: 'throwToPrimary' }, retry: '', success: '' },
  { kind: 'info', id: 'outro', topic: 'basics', title: 'END', pages: [{ heading: 'C', lines: [] }] },
];

describe('TutorialMachine', () => {
  it('pages through info steps, forward and back', () => {
    const m = new TutorialMachine(steps);
    const log: MachineChange['type'][] = [];
    m.onChange((c) => log.push(c.type));
    expect(m.step?.id).toBe('intro');
    expect(m.prevPage()).toBe(false);
    m.nextPage();
    expect(m.page).toBe(1);
    m.prevPage();
    expect(m.page).toBe(0);
    m.nextPage();
    m.nextPage();
    expect(m.step?.id).toBe('pass');
    expect(m.isDone('intro')).toBe(true);
    expect(m.nextPage()).toBe(false);
    expect(log).toEqual(['page', 'page', 'page', 'stepDone', 'step']);
  });

  it('interactive steps advance on done, count retries on failed and ignore pending', () => {
    const m = new TutorialMachine(steps, { startIndex: 1 });
    expect(m.report('pending')).toBe('ignored');
    expect(m.report('failed')).toBe('retry');
    expect(m.report('failed')).toBe('retry');
    expect(m.attempts).toBe(2);
    expect(m.step?.id).toBe('pass');
    expect(m.report('done')).toBe('advanced');
    expect(m.step?.id).toBe('outro');
    expect(m.attempts).toBe(0);
    expect(m.completedIds).toEqual(['pass']);
    expect(m.report('done')).toBe('ignored');
    m.nextPage();
    expect(m.status).toBe('complete');
    expect(m.step).toBeNull();
  });

  it('skip a step (not marked done), restart, and skip the whole tutorial', () => {
    const m = new TutorialMachine(steps, { startIndex: 1, completed: ['intro'] });
    const changes: MachineChange[] = [];
    m.onChange((c) => changes.push(c));
    m.report('failed');
    m.restartStep();
    expect(m.attempts).toBe(0);
    m.skipStep();
    expect(m.step?.id).toBe('outro');
    expect(m.isDone('pass')).toBe(false);
    expect(m.skippedStepIds).toEqual(['pass']);
    expect(m.completedIds).toEqual(['intro']);
    m.skipAll();
    expect(m.status).toBe('skipped');
    expect(changes[changes.length - 1]).toEqual({ type: 'finished', status: 'skipped' });
    expect(() => new TutorialMachine([])).toThrow();
  });

  it('the real script covers every topic in order and every interactive step has a drill', () => {
    const topics = [...new Set(TUTORIAL_STEPS.map((s) => s.topic))];
    expect(topics).toEqual(['basics', 'movement', 'passing', 'catching', 'running', 'tackling', 'defense', 'playcalling', 'clock', 'franchise']);
    const franchise = TUTORIAL_STEPS.find((s) => s.id === 'franchise');
    expect(franchise?.kind === 'info' && franchise.pages.map((p) => p.art)).toEqual(['roster', 'depthChart', 'cap', 'draft', 'freeAgency', 'trade']);
    const goals = TUTORIAL_STEPS.flatMap((s) => (s.kind === 'interactive' ? [s.goal.kind] : []));
    // The passing lesson also teaches the pull-back pass (spotThrow).
    expect(goals).toEqual(['moveYards', 'throwToPrimary', 'spotThrow', 'catchBall', 'gainYards', 'makeTackle', 'switchPlayer', 'playTheBall']);
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(TUTORIAL_STEPS.length);
  });
});
