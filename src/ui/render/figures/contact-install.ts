/**
 * Chain B installer (art bible §16.9): registers the line-play and tackle poses (anims-line.ts, anims-tackle.ts) in
 * chain A's pose registry, so A's figure painter draws every §6.2 / §6.3 clip in all facings, builds and tiers, and
 * registers the contact look override: line play (look-contact.ts), then tackles (look-tackle.ts, which win for an
 * athlete in both), then the post-whistle get-up: after the whistle every body left lying on the ground gets up in
 * a staggered order (tacklers on top first, the ball carrier last), plays getUp and stands; and the frame's effect
 * cues for chain C (contact-effects.ts). Imported once from
 * world-layer-install.ts; tests import it directly. Idempotent.
 */
import type { AnimId } from '../anim-ids';
import { clipSeconds, clipTiming, frameAt, registerClip, type Look } from '../anim';
import { idHash, registerLookOverride, type LookContext } from '../anim-select';
import { facingFromScreenVector } from '../sprites';
import { registerPoseSet } from './anims';
import { LINE_POSES } from './anims-line';
import { TACKLE_POSES } from './anims-tackle';
import { lastPlayEvent } from './contact-events';
import { collectCues } from './contact-effects';
import { lineLooks } from './look-contact';
import { tackleLooks } from './look-tackle';

/** Seconds after the whistle before the first body gets up, and the stagger between bodies. */
export const GET_UP_DELAY = 0.9;
export const GET_UP_STAGGER = 0.14;

const isLying = (l: Look): boolean => l.lying === true || (clipTiming(l.clip).lying === true && l.frame >= clipTiming(l.clip).frames - 1) || l.clip === 'down' || l.clip === 'downBack';

/** Post-whistle get-ups over the final looks (core + contact). */
const getUps = (ctx: LookContext, core: ReadonlyMap<string, Look>, out: Map<string, Look>): void => {
  if (ctx.ball.phase !== 'dead') return;
  const whistle = lastPlayEvent(ctx.mem, 'whistle');
  if (!whistle) return;
  const since = ctx.mem.timeSince(whistle);
  for (const p of ctx.placed) {
    const l = out.get(p.a.id) ?? core.get(p.a.id);
    if (!l || l.clip === 'injuredDown' || !(isLying(l) || l.clip === 'getUp')) continue;
    if (ctx.mem.lastEvent(p.a.id, 'injury')) continue;
    const order = p.a.id === ctx.ball.carrierId ? 4 : (l.layer ?? 0) > 0 ? 0 : 2;
    const at = GET_UP_DELAY + order * GET_UP_STAGGER + (idHash(p.a.id) % 5) * 0.07;
    const t = since - at;
    if (t < 0) continue;
    const facing = l.facing ?? facingFromScreenVector(p.dir.x, p.dir.y);
    const clip: AnimId = t < clipSeconds('getUp') ? 'getUp' : 'idle';
    out.set(p.a.id, { clip, frame: clip === 'getUp' ? frameAt('getUp', t) : 0, facing, dx: 0, dy: 0 });
  }
};

/** The contact override (line play, tackles, get-ups). */
export const contactOverride = (ctx: LookContext, core: ReadonlyMap<string, Look>): Map<string, Look> => {
  const out = lineLooks(ctx);
  for (const [id, l] of tackleLooks(ctx)) out.set(id, l);
  getUps(ctx, core, out);
  collectCues(ctx, out);
  return out;
};

let installed: (() => void) | null = null;

/** Registers chain B's poses and look override (once). */
export const installContact = (): void => {
  // the hit stick drives through into the ground: its last frame lies on the carrier
  registerClip('bigHit', { lying: true });
  registerPoseSet({ ...LINE_POSES, ...TACKLE_POSES }, 'B');
  if (!installed) installed = registerLookOverride(contactOverride);
};

/** Removes the look override (tests). */
export const uninstallContact = (): void => {
  installed?.();
  installed = null;
};

installContact();
