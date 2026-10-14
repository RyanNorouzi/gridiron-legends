import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { registerDefense } from '@/ai/defense';
import { clearDeciders } from '@/ai/index';
import { registerOffense } from '@/ai/offense';
import { registerSpecialTeams } from '@/ai/special-teams';
import { createReplayStore } from '@/game/replay';
import { Camera, CLOSE_ZOOM } from '@/ui/camera';
import type { FieldScene, FieldViewOptions } from '@/ui/game/field-view';
import { LINE_ANIM_IDS, TACKLE_ANIM_IDS } from '@/ui/render/anim-ids';
import type { WorldLayer } from '@/ui/render/canvas';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import { drawWorldScene, type PlacedFigure } from '@/ui/render/world-layer-scene';
import { sceneFromReplay } from '@/ui/screens/replay';
import { createTheme } from '@/ui/theme';
import '@/ui/render/figures/contact-install';
import { build } from '../../../game/engine/helpers';
import { createFakeCtx } from '../fake-ctx';

const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
const options = (): FieldViewOptions => ({ theme: createTheme(DEFAULT_SETTINGS), sprites: new SpriteCache(), palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', time: 0.5, userSide: 'home' });
const layer = (): WorldLayer => ({ ctx: createFakeCtx(), width: 480, height: 270, used: false });
const B_CLIPS = new Set<string>([...LINE_ANIM_IDS, ...TACKLE_ANIM_IDS]);

/** A real play with the real AI (line play, a struggle, a gang tackle), recorded. The seed is one whose play shows every
 *  checked clip under the current pass-rush tuning (re-pick it if a rush/protection retune changes the play). */
const recorded = () => {
  const store = createReplayStore('lastPlay');
  const { engine } = build({ offensePlayId: 'shotgun-fourVerts', defensePlayId: '43-cover3-zone', seed: 3, recordFrames: true }, {}, { recordFrames: true, replayStore: store });
  const o = engine.run();
  const rec = store.get(o.replayId as string);
  if (!rec) throw new Error('no recording');
  return rec;
};

beforeAll(() => { registerOffense(); registerDefense(); registerSpecialTeams(); });
afterAll(() => clearDeciders());

describe('contact looks in replays', () => {
  it('are identical at any playback rate and survive a seek, and cover line play and the tackle', () => {
    const rec = recorded();
    const last = rec.frames.length - 1;
    const key = (f: PlacedFigure): string => `${f.scene.id}:${f.look.clip}:${f.look.frame}:${f.look.facing}`;
    const cam = (): Camera => { const c = new Camera(480, 270); c.target.x = 26.65; c.target.y = rec.losY; c.zoom = CLOSE_ZOOM.standard; return c; };
    const sample = (c: Camera, i: number): string[] => {
      const scene: FieldScene = sceneFromReplay(rec, i);
      c.target.y = scene.ball.y;
      c.target.x = scene.ball.x;
      return drawWorldScene(layer(), c, scene, options(), new Map()).map(key).sort();
    };
    const a = cam(); const b = cam();
    const through: string[][] = [];
    for (let i = 0; i <= last; i++) through.push(sample(a, i));
    for (let i = 0; i <= last; i++) {
      expect(sample(b, i), `frame ${i}`).toEqual(through[i]);
      if (i < last) sample(b, i + 0.5);
    }
    const seen = new Set(through.flat().map((s) => s.split(':')[2] as string).filter((c) => B_CLIPS.has(c)));
    for (const clip of ['punch', 'handFight', 'hangOn', 'struggle', 'wrap']) expect(seen.has(clip), clip).toBe(true);
    const k = Math.floor(last * 0.8);
    const seek = sample(cam(), k);
    const same = seek.filter((s, j) => s === through[k]?.[j]).length;
    expect(same / seek.length).toBeGreaterThan(0.85);
  });
});
