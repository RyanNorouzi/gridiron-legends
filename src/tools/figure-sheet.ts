/**
 * Dev contact sheet of chain A's figures (art bible §14, §15.2), served by Vite at /src/tools/figure-sheet.html.
 * Query: `s=anims` (default: every clip x its frames, one build, one facing), `s=facings` (clip frame 0 in all 8
 * facings, every build), `s=kits` (home / away kits, skin tones, body variants); `clips=a,b` filters clips,
 * `build=slim`, `facing=se`, `tier=1..4`, `z=3` (display zoom), `hp=#hex&ha=#hex&hh=#hex` / `ap=..` team colours,
 * `lighting=overcast`. Numbers are stamped the way the game stamps them (the painter's `decorate`).
 */
import { ANIM_IDS, type AnimId } from '@/ui/render/anim-ids';
import { clipTiming, FIGURE_BUILDS, makeKit, painterFor, type FigureBuild, type FrameRequest } from '@/ui/render/anim';
import { SpriteAtlas, drawAtlasFrame } from '@/ui/render/atlas';
import { resolveTeamPalettes, teamUniforms } from '@/ui/render/palette';
import { FACINGS, SKIN_TONES, type Facing8 } from '@/ui/render/sprites';
import '@/ui/render/figures/contact-install';
import '@/ui/render/figures/install';
import type { FigureTier } from '@/ui/render/world-layer';

const q = new URLSearchParams(location.search);
const mode = q.get('s') ?? 'anims';
const zoom = Math.max(1, Number(q.get('z') ?? 3));
const tier = Math.min(4, Math.max(1, Number(q.get('tier') ?? 1))) as FigureTier;
const lighting = q.get('lighting') ?? 'day';
const clips = (q.get('clips')?.split(',') ?? ANIM_IDS) as AnimId[];
const pal = resolveTeamPalettes(
  { primary: q.get('hp') ?? '#b3202a', secondary: q.get('hs') ?? '#1c1c22', accent: q.get('ha') ?? '#f2c14e', helmet: q.get('hh') ?? '#b3202a' },
  { primary: q.get('ap') ?? '#1f4e9c', secondary: q.get('as') ?? '#c8a24a', accent: q.get('aa') ?? '#ffffff', helmet: q.get('ah') ?? '#1f4e9c' }, 'none');
const u = teamUniforms(pal);
const kits = { home: makeKit('home', pal.home, u.home), away: makeKit('away', pal.away, u.away) };
const atlas = new SpriteAtlas({ maxEntries: 20000, frameBudgetMs: 1e9 });
const CW = 44; const CH = 52; const LABEL = 96;

interface Cell { req: FrameRequest; col: number; row: number }
const cells: Cell[] = [];
const labels: string[] = [];
const req = (clip: AnimId, frame: number, facing: Facing8, build: FigureBuild, side: 'home' | 'away', skin = 2, bodyVar: 0 | 1 | 2 = 1): FrameRequest => ({
  clip, frame, facing, build, bodyVar, tier, kit: kits[side], skin, number: 20 + ((clip.length * 7 + frame) % 79), ball: true, accessory: (clip.length * 2654435761) >>> 0, lighting,
});
if (mode === 'facings') {
  for (const clip of clips) for (const build of FIGURE_BUILDS) {
    labels.push(`${clip} ${build}`);
    FACINGS.forEach((f, col) => cells.push({ req: req(clip, 0, f, build, labels.length % 2 ? 'home' : 'away'), col, row: labels.length - 1 }));
  }
} else if (mode === 'kits') {
  for (const build of FIGURE_BUILDS) for (const side of ['home', 'away'] as const) {
    labels.push(`${build} ${side}`);
    let col = 0;
    for (let skin = 0; skin < SKIN_TONES.length; skin++) cells.push({ req: req('idle', 0, 's', build, side, skin), col: col++, row: labels.length - 1 });
    for (const bv of [0, 1, 2] as const) cells.push({ req: req('idle', 0, 'se', build, side, 2, bv), col: col++, row: labels.length - 1 });
  }
} else {
  const build = (q.get('build') ?? 'slim') as FigureBuild;
  const facing = (q.get('facing') ?? 'se') as Facing8;
  for (const clip of clips) {
    labels.push(clip);
    for (let f = 0; f < clipTiming(clip).frames; f++) cells.push({ req: req(clip, f, facing, build, labels.length % 2 ? 'home' : 'away'), col: f, row: labels.length - 1 });
  }
}
const cols = Math.max(1, ...cells.map((c) => c.col + 1));
const canvas = document.getElementById('sheet') as HTMLCanvasElement;
const W = LABEL + cols * CW; const H = labels.length * CH;
const art = document.createElement('canvas');
art.width = W; art.height = H;
const ctx = art.getContext('2d') as CanvasRenderingContext2D;
ctx.imageSmoothingEnabled = false;
for (let r = 0; r < labels.length; r++) for (let c = 0; c < cols; c++) {
  ctx.fillStyle = (r + c) % 2 ? '#3f8a3a' : '#43913e';
  ctx.fillRect(LABEL + c * CW, r * CH, CW, CH);
}
for (const cell of cells) {
  const painter = painterFor(cell.req.clip);
  if (!painter) continue;
  const canon = painter.normalize?.(cell.req) ?? cell.req;
  const frame = atlas.paintNow(`${painter.id}|${JSON.stringify({ ...canon, kit: canon.kit.id })}`, () => painter.paint(canon));
  const x = LABEL + cell.col * CW + CW / 2; const y = cell.row * CH + CH - 8;
  drawAtlasFrame(ctx, frame, x, y);
  painter.decorate?.(ctx, frame, cell.req, x, y);
}
canvas.width = W * zoom; canvas.height = H * zoom;
const out = canvas.getContext('2d') as CanvasRenderingContext2D;
out.imageSmoothingEnabled = false;
out.drawImage(art, 0, 0, W * zoom, H * zoom);
out.fillStyle = '#cfd6e0';
out.font = `${10 + zoom}px monospace`;
labels.forEach((l, r) => out.fillText(l, 4, (r * CH + CH / 2) * zoom));
document.title = `Figure sheet (${cells.length} frames)`;
