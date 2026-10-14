import { describe, expect, it } from 'vitest';
import { EventBus } from '@/core/events';

describe('EventBus', () => {
  it('emits to subscribers and supports unsubscribe/once', () => {
    const bus = new EventBus<{ score: { points: number }; whistle: undefined }>();
    const got: number[] = [];
    const off = bus.on('score', (p) => got.push(p.points));
    bus.once('score', (p) => got.push(p.points * 100));
    bus.emit('score', { points: 3 });
    bus.emit('score', { points: 7 });
    off();
    bus.emit('score', { points: 1 });
    expect(got).toEqual([3, 300, 7]);
  });
});
