/**
 * Retro contact sheet (dev page): the figure frames at 1x on the 480x270-grid scale, shown at `z` (default 4).
 * Singles for both kits (home colour / away white), the 8 facings, and the contact pairs (hand fight, drive,
 * pancake, wrap-and-drag, tackle to the ground) posed the way the game places them (ENGAGE_GAP / DRIVE_GAP apart).
 * Served by Vite at /src/tools/retro-sheet.html; it is the reference the owner approved the retro look from.
 */
import type { AnimId } from '@/ui/render/anim-ids';
import { clipTiming, makeKit, painterFor, type FigureBuild, type FrameRequest } from '@/ui/render/anim';
import { SpriteAtlas, drawAtlasFrame } from '@/ui/render/atlas';
import { resolveTeamPalettes, teamUniforms } from '@/ui/render/palette';
import { FACINGS, type Facing8 } from '@/ui/render/sprites';
import { drawText } from '@/ui/render/text';
import { DRIVE_GAP, ENGAGE_GAP } from '@/ui/render/figures/look-contact';
import '@/ui/render/figures/contact-install';
import '@/ui/render/figures/install';

const q = new URLSearchParams(location.search);
const Z = Math.max(1, Number(q.get('z') ?? 4));
const pal = resolveTeamPalettes(
  { primary: '#b3202a', secondary: '#1c1c22', accent: '#f2c14e', helmet: '#b3202a' },
  { primary: '#1f3c88', secondary: '#c8a24a', accent: '#ffffff', helmet: '#1f3c88' }, 'none');
const u = teamUniforms(pal);
const kits = { home: makeKit('home', pal.home, u.home), away: makeKit('away', pal.away, u.away) };
const atlas = new SpriteAtlas({ maxEntries: 20000, frameBudgetMs: 1e9 });

interface Fig { clip: AnimId; frame: number; facing: Facing8; build: FigureBuild; side: 'home' | 'away'; num: number; ball?: boolean; skin?: number; dx?: number; dy?: number }
interface Row { label: string; cells: Fig[][]; cw: number }
const rows: Row[] = [];
const single = (label: string, clip: AnimId, build: FigureBuild, side: 'home' | 'away', facing: Facing8, num: number, ball = false, skin = 2): Row => {
  const n = clipTiming(clip).frames;
  return { label, cw: 34, cells: Array.from({ length: n }, (_, f) => [{ clip, frame: f, facing, build, side, num, ball, skin }]) };
};
const H: 'home' = 'home'; const A: 'away' = 'away';
rows.push(single('RB run (home)', 'carry', 'back', H, 'e', 28, true, 3));
rows.push(single('RB run (away)', 'carry', 'back', A, 'w', 33, true, 1));
rows.push(single('WR sprint', 'sprint', 'slim', H, 'e', 81, false, 4));
rows.push(single('WR sprint (away)', 'sprint', 'slim', A, 'w', 11, false, 0));
rows.push(single('LB jog', 'jog', 'power', A, 'w', 54, false, 2));
rows.push({ label: 'stances', cw: 34, cells: [
  [{ clip: 'stance3', frame: 0, facing: 'e', build: 'bigO', side: H, num: 72 }], [{ clip: 'snapStance', frame: 0, facing: 'e', build: 'bigO', side: H, num: 60, ball: true }],
  [{ clip: 'qbUnderCenter', frame: 0, facing: 'e', build: 'qb', side: H, num: 12 }], [{ clip: 'stance2', frame: 0, facing: 'e', build: 'slim', side: H, num: 88 }],
  [{ clip: 'stance3', frame: 0, facing: 'w', build: 'bigD', side: A, num: 94 }], [{ clip: 'dbReady', frame: 0, facing: 'w', build: 'slim', side: A, num: 24 }],
  [{ clip: 'stance2', frame: 0, facing: 'w', build: 'power', side: A, num: 52 }], [{ clip: 'qbShotgun', frame: 0, facing: 'e', build: 'qb', side: H, num: 12, ball: true }],
] });
rows.push(single('QB dropback', 'dropback', 'qb', H, 'e', 12, true, 1));
rows.push(single('QB throw', 'throw', 'qb', H, 'e', 12, true, 1));
rows.push(single('catch chest', 'catchChest', 'slim', H, 'e', 81, true, 4));
rows.push(single('catch high', 'catchHigh', 'slim', A, 'w', 11, true, 0));
rows.push(single('juke', 'juke', 'back', H, 'e', 28, true, 3));
const facingRow = (label: string, clip: AnimId, frame: number, build: FigureBuild, side: 'home' | 'away', num: number): Row =>
  ({ label, cw: 34, cells: FACINGS.map((f) => [{ clip, frame, facing: f, build, side, num, ball: clip === 'carry' }]) });
rows.push(facingRow('8 facings (RB)', 'carry', 1, 'back', H, 28));
rows.push(facingRow('8 facings (OL)', 'run', 1, 'bigO', A, 66));
// pairs: blocker (home, facing e) and defender (away, facing w), feet ENGAGE_GAP apart
const pair = (label: string, bClip: AnimId, dClip: AnimId, gap: number, bBuild: FigureBuild = 'bigO', dBuild: FigureBuild = 'bigD', frames?: number, drift = 0): Row => {
  const n = frames ?? Math.max(clipTiming(bClip).frames, clipTiming(dClip).frames);
  return { label, cw: 52, cells: Array.from({ length: n }, (_, f) => [
    { clip: bClip, frame: Math.min(f, clipTiming(bClip).frames - 1), facing: 'e', build: bBuild, side: H, num: 75, dx: -gap / 2 + f * drift, skin: 4 },
    { clip: dClip, frame: Math.min(f, clipTiming(dClip).frames - 1), facing: 'w', build: dBuild, side: A, num: 91, dx: gap / 2 + f * drift, skin: 1 },
  ]) };
};
rows.push(pair('line: punch', 'punch', 'punch', ENGAGE_GAP));
rows.push(pair('line: hand fight', 'handFight', 'handFight', ENGAGE_GAP));
rows.push(pair('line: drive block', 'driveBlock', 'driven', DRIVE_GAP, 'bigO', 'bigD', 4, 1));
rows.push(pair('line: bull rush', 'anchor', 'bullRush', DRIVE_GAP, 'bigO', 'bigD', 4, -1));
rows.push(pair('line: swim / beaten', 'beaten', 'swim', DRIVE_GAP, 'bigO', 'bigD', 6));
rows.push(pair('line: pancake', 'pancake', 'knockdown', 14, 'bigO', 'bigD', 5, 2));
// tackles: carrier (home, facing e) and tackler (away)
const tackle = (label: string, cClip: AnimId, tClip: AnimId, tFacing: Facing8, gap: number, drift = 0): Row => {
  const n = Math.max(clipTiming(cClip).frames, clipTiming(tClip).frames);
  return { label, cw: 56, cells: Array.from({ length: n }, (_, f) => [
    { clip: cClip, frame: Math.min(f, clipTiming(cClip).frames - 1), facing: 'e', build: 'back', side: H, num: 28, ball: true, skin: 3, dx: -gap / 2 + f * drift, dy: 0 },
    { clip: tClip, frame: Math.min(f, clipTiming(tClip).frames - 1), facing: tFacing, build: 'power', side: A, num: 54, skin: 2, dx: gap / 2 + f * drift, dy: 1 },
  ]) };
};
rows.push(tackle('tackle: head-on to ground', 'tackledBack', 'wrap', 'w', 12, -1));
rows.push(tackle('tackle: wrap and drag', 'struggle', 'hangOn', 'e', -9, 1));
rows.push(tackle('tackle: from behind', 'tackledFwd', 'diveTackle', 'e', -14, 2));
rows.push(tackle('tackle: big hit', 'blownUp', 'bigHit', 'w', 12, -2));
rows.push(single('get up', 'getUp', 'back', H, 'e', 28, false, 3));
rows.push(single('celebrate', 'celebrateSpike', 'slim', H, 'e', 81, true, 4));

const LABEL = 86; const RH = 40;
const W = LABEL + Math.max(...rows.map((r) => r.cells.length * r.cw)) + 8;
const Ht = rows.length * RH + 4;
const art = document.createElement('canvas');
art.width = W; art.height = Ht;
const ctx = art.getContext('2d') as CanvasRenderingContext2D;
ctx.imageSmoothingEnabled = false;
ctx.fillStyle = '#11161c'; ctx.fillRect(0, 0, W, Ht);
const req = (f: Fig): FrameRequest => ({ clip: f.clip, frame: f.frame, facing: f.facing, build: f.build, bodyVar: 1, tier: 1, kit: kits[f.side], skin: f.skin ?? 2, number: f.num, ball: f.ball ?? false, accessory: (f.num * 2654435761) >>> 0, lighting: 'day' });
rows.forEach((row, r) => {
  const y0 = r * RH + 2;
  drawText(ctx, row.label.toUpperCase(), 2, y0 + RH / 2 - 4, { color: '#cfd6e0', size: 1 });
  row.cells.forEach((figs, c) => {
    const x0 = LABEL + c * row.cw;
    ctx.fillStyle = (r + c) % 2 ? '#3d8a3a' : '#418f3d';
    ctx.fillRect(x0, y0, row.cw - 1, RH - 2);
    const sorted = [...figs].sort((a, b) => (a.dy ?? 0) - (b.dy ?? 0));
    for (const f of sorted) {
      const rq = req(f);
      const painter = painterFor(rq.clip);
      if (!painter) continue;
      const canon = painter.normalize?.(rq) ?? rq;
      const frame = atlas.paintNow(`${painter.id}|${JSON.stringify({ ...canon, kit: canon.kit.id })}`, () => painter.paint(canon));
      const x = Math.round(x0 + row.cw / 2 + (f.dx ?? 0)); const y = y0 + RH - 7 + (f.dy ?? 0);
      ctx.fillStyle = 'rgba(8,20,10,0.35)';
      ctx.fillRect(x - 6, y - 1, 13, 2);
      drawAtlasFrame(ctx, frame, x, y);
      painter.decorate?.(ctx, frame, rq, x, y);
    }
  });
});
const canvas = document.getElementById('sheet') as HTMLCanvasElement;
canvas.width = W * Z; canvas.height = Ht * Z;
const out = canvas.getContext('2d') as CanvasRenderingContext2D;
out.imageSmoothingEnabled = false;
out.drawImage(art, 0, 0, W * Z, Ht * Z);
document.title = `Retro sheet ${W}x${Ht}`;
