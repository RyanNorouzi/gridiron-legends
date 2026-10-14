/**
 * Sideline civilians (art bible §10.4), painted in code: coaches (team-colour polo, slacks, cap and headset, the
 * head coach with a clipboard), chain-crew members (white vest over black) and photographers (dark clothes,
 * crouched behind a long lens). Each is a small RGBA sprite designed on a 16 x 28 grid at tier 1, scaled to the
 * figure tier with every rectangle rounded to whole art pixels, drawn from the front, the back or either side, in
 * two idle frames (a slight arm / weight shift; a coach's arms go up on big plays). Pure (Node-tested) and cached.
 */
import { darken, lighten } from '../palette';
import { Lru, newPx, rectPx, type Px } from './art';

/** Kinds of sideline civilian. */
export type PersonKind = 'coach' | 'headCoach' | 'chainCrew' | 'photographer';
/** Which side of the person faces the camera. */
export type PersonView = 'front' | 'back' | 'left' | 'right';

/** A painted person: pixels plus the feet anchor. */
export interface PersonSprite { px: Px; ax: number; ay: number }

const SKIN = ['#f1c7a3', '#d9a27b', '#b07850', '#7b4f32', '#5a3a26'];

/** Paints a person (pure). `color` is the team colour (coaches' polo and cap), `scale` the tier scale. */
export const paintPerson = (kind: PersonKind, view: PersonView, color: string, scale: number, frame: 0 | 1 | 2, skinIdx: number): PersonSprite => {
  const W = Math.ceil(20 * scale) + 4;
  const H = Math.ceil(30 * scale) + 4;
  const px = newPx(W, H);
  const ax = Math.round(W / 2);
  const ay = H - 2;
  const skin = SKIN[((skinIdx % SKIN.length) + SKIN.length) % SKIN.length] as string;
  // design units: x from -8..8 around the centre, y from 0 (feet) up to 28
  const r = (x: number, y: number, w: number, h: number, c: string): void => {
    const x0 = Math.round(ax + x * scale);
    const x1 = Math.round(ax + (x + w) * scale);
    const y0 = Math.round(ay - (y + h) * scale);
    const y1 = Math.round(ay - y * scale);
    rectPx(px, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0), c);
  };
  const side = view === 'left' || view === 'right';
  const dir = view === 'left' ? -1 : 1;
  const crouch = kind === 'photographer';
  const shirt = kind === 'chainCrew' ? '#f2f2ea' : kind === 'photographer' ? '#2b2d35' : color;
  const pants = kind === 'coach' || kind === 'headCoach' ? '#3a3a42' : '#1d1e24';
  const outline = '#15161b';
  const legH = crouch ? 5 : 11;
  const bodyY = legH;
  const bodyH = crouch ? 8 : 9;
  const headY = bodyY + bodyH;
  const hw = side ? 3 : 3.5;
  // legs and shoes
  if (crouch) {
    r(-4, 0, 8, 2, outline);
    r(-4 + dir * 1, 1, 7, legH - 1, pants);
  } else {
    r(-3.5, 0, 3, 1.5, outline);
    r(0.5, 0, 3, 1.5, outline);
    r(-3.5, 1.5, 3, legH - 1.5, pants);
    r(0.5, 1.5, 3, legH - 1.5, darken(pants, 0.2));
  }
  // torso with a lit left edge and a shaded right edge
  const tw = side ? 7 : 9;
  r(-tw / 2 - 0.5, bodyY, tw + 1, bodyH + 0.5, outline);
  r(-tw / 2, bodyY, tw, bodyH, shirt);
  r(-tw / 2, bodyY + 1, 1, bodyH - 2, lighten(shirt, 0.18));
  r(tw / 2 - 1, bodyY, 1, bodyH, darken(shirt, 0.25));
  if (kind === 'chainCrew') {
    r(-tw / 2, bodyY + bodyH - 2, tw, 1, '#1d1e24');
    r(-tw / 2, bodyY + 3, tw, 1, '#1d1e24');
  }
  if (kind === 'coach' || kind === 'headCoach') r(-1, bodyY + bodyH - 2, 2, 2, lighten(color, 0.35));
  // arms
  const armsUp = frame === 2 && !crouch;
  const sway = frame === 1 ? 0.5 : 0;
  if (armsUp) {
    r(-tw / 2 - 2, bodyY + bodyH - 1, 2, 7, shirt);
    r(tw / 2, bodyY + bodyH - 1, 2, 7, shirt);
    r(-tw / 2 - 2, bodyY + bodyH + 5, 2, 2, skin);
    r(tw / 2, bodyY + bodyH + 5, 2, 2, skin);
  } else if (!side) {
    r(-tw / 2 - 2, bodyY + 2 + sway, 2, bodyH - 2, darken(shirt, 0.1));
    r(tw / 2, bodyY + 2, 2, bodyH - 2, darken(shirt, 0.2));
    r(-tw / 2 - 2, bodyY + 1 + sway, 2, 1.5, skin);
    r(tw / 2, bodyY + 1, 2, 1.5, skin);
  } else r(-1, bodyY + 1 + sway, 2, bodyH - 2, darken(shirt, 0.15));
  if (kind === 'headCoach' && !armsUp) {
    // clipboard held at the chest
    const cx = view === 'back' ? -3 : side ? dir * 2 : 1;
    r(cx - 1, bodyY + 2, 4, 5, '#8a6a3a');
    if (view !== 'back') r(cx - 0.5, bodyY + 2.5, 3, 4, '#f4f1e6');
  }
  if (crouch) {
    // camera and long lens pointing the way the photographer faces
    r(side ? dir * 2 - 1.5 : -1.5, bodyY + bodyH - 2, 3, 3, '#1b1c21');
    r(side ? (dir > 0 ? 3 : -8) : -1, bodyY + bodyH - 1.5, side ? 5 : 2, 2, '#6b6f7a');
  }
  // head
  const hy = headY;
  r(-hw - 0.5, hy - 0.5, hw * 2 + 1, 6.5, outline);
  r(-hw, hy, hw * 2, 5.5, view === 'back' ? darken(skin, 0.1) : skin);
  if (view === 'front') {
    r(-hw + 1.5, hy + 2.5, 1, 1, '#2a1d18');
    r(hw - 2.5, hy + 2.5, 1, 1, '#2a1d18');
  } else if (side) r(dir > 0 ? hw - 1.5 : -hw + 0.5, hy + 2.5, 1, 1, '#2a1d18');
  const cap = kind === 'coach' || kind === 'headCoach' ? color : kind === 'chainCrew' ? '#1d1e24' : '#3b2a1e';
  r(-hw, hy + 3.5, hw * 2, 2, cap);
  if (kind !== 'photographer') {
    if (view === 'front') r(-hw - 0.5, hy + 3.5, hw * 2 + 1, 0.8, darken(cap, 0.3));
    else if (side) r(dir > 0 ? hw - 0.5 : -hw - 2, hy + 3.5, 2.5, 0.8, darken(cap, 0.3));
  }
  if (kind === 'coach' || kind === 'headCoach') {
    // headset band and mic
    r(-hw - 0.5, hy + 1.5, 1, 3, '#15161b');
    if (view === 'front' || side) r(side ? dir * (hw - 1) : -hw + 0.5, hy + 1, side ? dir * 2 : 2, 0.8, '#15161b');
  }
  return { px, ax, ay };
};

const cache = new Lru<PersonSprite>(160);

/** Cached person sprite. */
export const personSprite = (kind: PersonKind, view: PersonView, color: string, scale: number, frame: 0 | 1 | 2, skinIdx: number): PersonSprite =>
  cache.getOr(`${kind}|${view}|${color}|${scale}|${frame}|${skinIdx}`, () => paintPerson(kind, view, color, scale, frame, skinIdx));
