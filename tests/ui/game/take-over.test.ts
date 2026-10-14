import { describe, expect, it } from 'vitest';
import { ballCarrier } from '@/game/athlete';
import { takeOverPlay } from '@/ui/game/take-over';
import { buildPlayState } from '../../fixtures/play-state';

describe('jumping into a running play', () => {
  it('gives the defense the free defender nearest the ball and marks the side human', () => {
    const f = buildPlayState({ offense: 'home', userSide: null, seed: 5 });
    const s = f.state;
    s.phase = 'live';
    expect(s.ctx.controllers.away).toBe('ai');
    const id = takeOverPlay(s, 'away');
    expect(id).not.toBeNull();
    expect(s.ctx.controllers.away).toBe('human');
    expect(s.controlledIds.away).toBe(id);
    const taken = s.athletes.find((a) => a.id === id)!;
    expect(taken.teamSide).toBe('away');
    expect(taken.controlled).toBe(true);
    expect(s.athletes.filter((a) => a.teamSide === 'away' && a.controlled)).toHaveLength(1);
    expect(s.events.some((e) => e.type === 'switchPlayer' && e.to === id)).toBe(true);
  });

  it('takes the ball carrier when the user side has the ball, and does nothing once the play is dead', () => {
    const f = buildPlayState({ offense: 'home', userSide: null, seed: 5 });
    const s = f.state;
    s.phase = 'live';
    const carrier = ballCarrier(s);
    const id = takeOverPlay(s, 'home');
    if (carrier && carrier.teamSide === 'home') expect(id).toBe(carrier.id);
    else expect(id).not.toBeNull();
    s.phase = 'dead';
    expect(takeOverPlay(s, 'away')).toBeNull();
  });
});
