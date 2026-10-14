/**
 * Difficulty tuning (Settings > DIFFICULTY TUNING): nudges individual difficulty knobs away from the chosen preset
 * (AI football IQ, reaction speed, pursuit and tackling; the user's pass, tackle and ball-security assists), each
 * -2..+2 steps, with a live readout of the resulting values. Edits the GameplayPrefs record in place; new games
 * use the tuned profile (see gameplay-prefs.ts tunedDifficulty).
 *
 * Layout: the knob list scrolls inside the panel when it does not fit (large text), and the readout below it
 * shrinks to the highlighted knob's own value when the full readout has no room.
 */
import type { DifficultyProfile } from '@/game/types';
import { getDifficulty } from '@/game/rulesets';
import { DIFFICULTY_TWEAKS, difficultyBlurb, stepTweak, tunedDifficulty, tweakLabel, type DifficultyTweak, type GameplayPrefs } from '../gameplay-prefs';
import type { InputState } from '../input/types';
import { drawText, wrapText } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import type { RenderContext, Screen, ScreenServices } from './screen';

const pct = (v: number | undefined): string => `${Math.round((v ?? 0) * 100)}%`;

/** The CPU team's performance edge of a profile ("CPU EDGE: SPEED +15% · STRENGTH +20% · SKILL +25%", or none). */
export const cpuEdgeReadout = (d: DifficultyProfile): string => {
  const e = (v: number | undefined): string => `+${Math.round((v ?? 0) * 100)}%`;
  const any = (d.cpuSpeedEdge ?? 0) > 0 || (d.cpuStrengthEdge ?? 0) > 0 || (d.cpuSkillEdge ?? 0) > 0;
  return any ? `CPU EDGE: SPEED ${e(d.cpuSpeedEdge)} · STRENGTH ${e(d.cpuStrengthEdge)} · SKILL ${e(d.cpuSkillEdge)}` : 'CPU EDGE: NONE';
};

/** The tuned value one knob controls ("AI IQ 72%"), for the compact readout. */
export const tweakReadout = (id: string, d: DifficultyProfile): string | null => {
  switch (id) {
    case 'aiSmarts': return `AI IQ ${pct(d.qbDecisionQuality)}`;
    case 'aiReaction': return `REACTION ${d.aiReactionDelay.toFixed(2)}S`;
    case 'aiPursuit': return `PURSUIT ${pct(d.pursuitQuality)}`;
    case 'passAssist': return `PASS ASSIST ${pct(d.userPassAssist)}`;
    case 'tackleAssist': return `TACKLE ASSIST ${pct(d.userTackleAssist)}`;
    case 'ballSecurity': return `BALL SECURITY ${pct(d.userBallSecurityAssist)}`;
    default: return null;
  }
};

export class DifficultyTuningScreen implements Screen {
  readonly id = 'difficulty-tuning';
  private menu: MenuList;
  private services: ScreenServices | null = null;
  private rowsShown = 0;

  constructor(private readonly prefs: GameplayPrefs, private readonly persist: () => void = () => undefined) {
    this.menu = new MenuList(this.items());
  }

  get list(): MenuList {
    return this.menu;
  }

  private items(): MenuItem[] {
    return [
      ...DIFFICULTY_TWEAKS.map((t) => ({ id: t.id, label: t.label, value: tweakLabel(this.prefs.tweaks[t.id]) })),
      { id: 'reset', label: 'RESET TO PRESET' },
      { id: 'back', label: 'BACK' },
    ];
  }

  /** Moves one knob by `delta` steps (exported for tests). */
  change(id: string, delta: number): void {
    const known = DIFFICULTY_TWEAKS.find((t) => t.id === id);
    if (!known) return;
    const next = stepTweak(this.prefs.tweaks[id as DifficultyTweak], delta);
    if (next === 0) delete this.prefs.tweaks[id as DifficultyTweak];
    else this.prefs.tweaks[id as DifficultyTweak] = next;
    this.persist();
    this.menu.setItems(this.items());
  }

  enter(services: ScreenServices): void {
    this.services = services;
  }

  exit(): void {
    this.services = null;
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back' || (ev.type === 'activate' && ev.item.id === 'back')) {
      services.audio?.onGameEvent({ type: 'menuBack' });
      services.stack.pop();
    } else if (ev.type === 'activate' && ev.item.id === 'reset') {
      this.prefs.tweaks = {};
      this.persist();
      this.menu.setItems(this.items());
    } else if (ev.type === 'change') this.change(ev.item.id, ev.delta);
    else if (ev.type === 'activate') this.change(ev.item.id, 1);
    else if (ev.type === 'select') services.audio?.onGameEvent({ type: 'menuMove' });
  }

  render(rc: RenderContext): void {
    const { ctx, width, height } = rc;
    const theme = this.services?.theme ?? rc.theme;
    const c = theme.colors;
    const s = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    const hintH = theme.glyphH + 4 * s;
    const base = getDifficulty(this.prefs.difficulty);
    const tuned = tunedDifficulty(base, this.prefs.tweaks);
    const content = drawPanel(ctx, theme, theme.pad, theme.pad, width - theme.pad * 2, height - hintH - theme.pad * 3, { style: 'raised', title: `DIFFICULTY TUNING · ${tuned.name.toUpperCase()}` });
    const full = [
      `AI IQ ${pct(tuned.qbDecisionQuality)} · REACTION ${tuned.aiReactionDelay.toFixed(2)}S · PURSUIT ${pct(tuned.pursuitQuality)}`,
      `PASS ASSIST ${pct(tuned.userPassAssist)} · TACKLE ASSIST ${pct(tuned.userTackleAssist)} · BALL SECURITY ${pct(tuned.userBallSecurityAssist)}`,
      cpuEdgeReadout(tuned),
      difficultyBlurb(this.prefs.difficulty).toUpperCase(),
      'APPLIES TO NEW GAMES AND NEW LEAGUES',
    ].flatMap((l) => wrapText(l, content.w, s));
    const room = (lines: number): number => Math.floor((content.h - theme.gap - lines * theme.lineHeight) / theme.lineHeight);
    // The whole list plus the full readout when they fit; else the whole (or scrolling) list and one readout line.
    const allRows = this.menu.items.length;
    const fitsFull = room(full.length) >= allRows;
    const rows = fitsFull ? allRows : Math.max(1, room(1));
    const want = rows >= allRows ? 0 : rows;
    if (want !== this.rowsShown) {
      this.rowsShown = want;
      this.menu = new MenuList(this.menu.items, { maxVisible: want, initialIndex: Math.max(0, this.menu.selectedIndex) });
    }
    const used = this.menu.draw(ctx, theme, content.x, content.y, content.w, { time: rc.time });
    const selected = tweakReadout(this.menu.selected?.id ?? '', tuned);
    const lines = fitsFull ? full : [selected ?? 'APPLIES TO NEW GAMES AND NEW LEAGUES'];
    let y = content.y + used + theme.gap;
    for (const line of lines) {
      if (y + theme.glyphH > content.y + content.h) break;
      drawText(ctx, line, content.x, y, { color: c.textDim, size: s });
      y += theme.lineHeight;
    }
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: `${input?.glyph('menuLeft') ?? '←'} ${input?.glyph('menuRight') ?? '→'}`, label: 'ADJUST' },
      { glyph: input?.glyph('back') ?? 'B', label: 'BACK' },
    ], width, height - hintH - theme.pad);
  }
}
