import { describe, expect, it } from 'vitest';
import type { PlayEvent } from '@/game/play-events';
import { clipSeconds, MAX_RENDER_OFFSET } from '@/ui/render/anim';
import { shedChoice, SHED_CLIP } from '@/ui/render/figures/contact-events';
import { athlete, frameAt, memory, place } from './contact-fixture';

const OG = 'off:LG';
const DT = 'def:DT1';
const pair = (bWy: number, dWy: number, extra: Partial<Parameters<typeof athlete>[0]> = {}) => [
  place(athlete({ id: OG, engagedWith: DT, ...extra }), 26, bWy),
  place(athlete({ id: DT, side: 'defense', position: 'DT', role: 'DT1', engagedWith: OG, facing: -Math.PI / 2 }), 26, dWy),
];

describe('line play: engaged pairs', () => {
  it('opens with the punch, then hand-fights facing each other within the render offset cap', () => {
    const mem = memory();
    // the view has been watching the play (the tracker's first frame is before the engagement, not a seek into it)
    frameAt(mem, 90, [place(athlete({ id: OG, state: 'moving', engagedWith: null }), 26, 39.5)]);
    const first = frameAt(mem, 100, pair(40, 41.1));
    expect(first.get(OG)?.clip).toBe('punch');
    expect(first.get(DT)?.clip).toBe('punch');
    let later = first;
    for (let t = 101; t <= 140; t++) later = frameAt(mem, t, pair(40, 41.1));
    const b = later.get(OG); const d = later.get(DT);
    expect(b?.clip).toBe('handFight');
    expect(d?.clip).toBe('handFight');
    expect(b?.facing).toBe('e');
    expect(d?.facing).toBe('w');
    for (const l of [b, d]) {
      expect(Math.abs(l?.dx ?? 99)).toBeLessThanOrEqual(MAX_RENDER_OFFSET);
      expect(Math.abs(l?.dy ?? 99)).toBeLessThanOrEqual(MAX_RENDER_OFFSET);
    }
    // the pair is pulled toward the hands-on-chest gap: 24.2 art px apart -> the blocker leans in, the defender too
    expect((b?.dx ?? 0) - (d?.dx ?? 0)).toBeGreaterThan(0);
  });

  it('reads a pair moving downfield as a drive block and one walked back as a bull rush', () => {
    const drive = memory();
    let l = frameAt(drive, 0, pair(40, 41.1));
    // (found engaged on the view's first frame: already established, so no punch here)
    for (let t = 1; t <= 40; t++) l = frameAt(drive, t, pair(40 + t / 60, 41.1 + t / 60));
    expect(l.get(OG)?.clip).toBe('driveBlock');
    expect(l.get(DT)?.clip).toBe('driven');
    const bull = memory();
    for (let t = 0; t <= 40; t++) l = frameAt(bull, t, pair(40 - t / 60, 41.1 - t / 60));
    expect(l.get(OG)?.clip).toBe('anchor');
    expect(l.get(DT)?.clip).toBe('bullRush');
  });

  it('puts the second blocker of a double team into the hip while the defender splits it', () => {
    const mem = memory();
    const placed = () => [...pair(40, 41.1), place(athlete({ id: 'off:C', position: 'C', role: 'C', engagedWith: DT }), 25.2, 40.2)];
    let l = frameAt(mem, 0, placed());
    for (let t = 1; t <= 30; t++) l = frameAt(mem, t, placed());
    expect(l.get('off:C')?.clip).toBe('doubleTeam');
    expect(l.get(DT)?.clip).toBe('splitDouble');
  });
});

describe('line play: sheds, pancakes, sets', () => {
  it('plays the (deterministic) shed move for the defender and the beaten blocker lunging after him', () => {
    const shed: PlayEvent = { type: 'blockShed', tick: 200, defender: DT, blocker: OG };
    const placed = [
      place(athlete({ id: OG, state: 'stumbling', engagedWith: null }), 26, 40),
      place(athlete({ id: DT, side: 'defense', position: 'DT', role: 'DT1', state: 'shedding', engagedWith: null, vx: 1, vy: -4 }), 26.6, 41),
    ];
    const clip = SHED_CLIP[shedChoice(DT, 'DT', 200)];
    const a = frameAt(memory(), 204, placed, [shed]);
    const b = frameAt(memory(), 204, placed, [shed]);
    expect(a.get(DT)?.clip).toBe(clip);
    expect(b.get(DT)).toEqual(a.get(DT));
    expect(a.get(OG)?.clip).toBe('beaten');
    // the move plays to its end, then the defender is back to the core look
    const after = frameAt(memory(), 200 + Math.ceil(clipSeconds(clip) * 60) + 2, placed, [shed]);
    expect(after.get(DT)?.clip).not.toBe(clip);
  });

  it('weights shed moves by role: interior linemen never spin, edge rushers use every move', () => {
    const dt = new Set<string>(); const de = new Set<string>();
    for (let t = 0; t < 400; t++) { dt.add(shedChoice('def:DT1', 'DT', t)); de.add(shedChoice('def:DE1', 'DE', t)); }
    expect(dt.has('spinMove')).toBe(false);
    expect([...de].sort()).toEqual(['longArmShed', 'rip', 'spinMove', 'swim']);
  });

  it('pancakes on the pancake event (over the stumbling fallback): knockdown onto his back, the blocker on top', () => {
    const mem = memory();
    const ev: PlayEvent = { type: 'pancake', tick: 300, blocker: OG, defender: DT };
    const placed = (dState: 'stumbling' | 'down') => [
      place(athlete({ id: OG, state: 'moving', engagedWith: null }), 26, 40),
      place(athlete({ id: DT, side: 'defense', position: 'DT', role: 'DT1', state: dState, engagedWith: null }), 26, 41.1),
    ];
    frameAt(mem, 280, pair(40, 41.1));
    // a seek straight into an engagement treats it as established: hand fight, no punch
    expect(frameAt(memory(), 280, pair(40, 41.1)).get(OG)?.clip).toBe('handFight');
    const l = frameAt(mem, 306, placed('stumbling'), [ev]);
    expect(l.get(DT)?.clip).toBe('knockdown');
    expect(l.get(OG)?.clip).toBe('pancake');
    const top = frameAt(mem, 322, placed('down'), [ev]).get(OG);
    expect(top?.frame).toBe(3);
    expect(top?.layer).toBe(1);
    // once the knockdown has played, the defender lies on his back until he gets up
    expect(frameAt(mem, 360, placed('down'), [ev]).get(DT)?.clip).toBe('downBack');
  });

  it('kick-slides unengaged linemen in a pass set and fires them out on a run', () => {
    const snap: PlayEvent = { type: 'snap', tick: 0 };
    const qb = place(athlete({ id: 'off:QB', position: 'QB', role: 'QB', state: 'dropback', hasBall: true }), 26, 36);
    const og = place(athlete({ id: OG, state: 'blocking', engagedWith: null, vy: -0.3, facing: Math.PI / 2 }), 26, 39.5);
    const set = frameAt(memory(), 60, [qb, og], [snap], { ball: { x: 26, y: 36, phase: 'held', carrierId: 'off:QB' } });
    expect(set.get(OG)?.clip).toBe('passSet');
    const run = place(athlete({ id: OG, state: 'moving', engagedWith: null, vy: 3, facing: Math.PI / 2 }), 26, 40.2);
    expect(frameAt(memory(), 6, [qb, run], [snap], { ball: { x: 26, y: 36, phase: 'held', carrierId: 'off:QB' } }).get(OG)?.clip).toBe('fireOut');
  });
});
