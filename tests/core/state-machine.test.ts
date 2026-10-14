import { describe, expect, it } from 'vitest';
import { StateMachine } from '@/core/state-machine';

type S = 'idle' | 'running' | 'done';

describe('StateMachine', () => {
  it('runs enter/exit hooks and update-driven transitions', () => {
    const log: string[] = [];
    const sm = new StateMachine<{ ticks: number }, S>(
      { ticks: 0 },
      {
        idle: { enter: () => log.push('enter idle'), update: (ctx) => (ctx.ticks++ > 1 ? 'running' : undefined), exit: () => log.push('exit idle') },
        running: { enter: (_c, from) => log.push(`enter running from ${from}`), update: () => 'done' },
        done: { enter: () => log.push('enter done') },
      },
      'idle',
    );
    expect(sm.state).toBe('idle');
    sm.update(1);
    sm.update(1);
    sm.update(1);
    expect(sm.state).toBe('running');
    sm.update(1);
    expect(sm.state).toBe('done');
    expect(log).toEqual(['enter idle', 'exit idle', 'enter running from idle', 'enter done']);
  });
  it('tracks elapsed time per state', () => {
    const sm = new StateMachine<Record<string, never>, S>({}, { idle: {}, running: {}, done: {} }, 'idle');
    sm.update(0.5);
    sm.update(0.25);
    expect(sm.elapsed).toBeCloseTo(0.75);
    sm.transition('running');
    expect(sm.elapsed).toBe(0);
  });
});
