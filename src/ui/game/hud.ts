/**
 * In-game HUD (broadcast slab, art bible §12.1): score bug (team-colour tabs with emblems, scores, quarter, clock,
 * timeout pips, possession football), the down & distance / ball spot line, play clock, the post-play result and last play-by-play line.
 * `buildHudData` is a pure projection of GameState (+ live play) so the drawing stays data-driven and
 * testable; every dimension derives from the theme (large text simply grows the bug).
 */
import { formatClock, TICK_RATE } from '@/core/time';
import type { KickMeterState, PlayState } from '@/game/play-types';
import type { GameSetup, GameState, TeamSide, WeatherState } from '@/game/types';
import { liveClockScale } from '@/game/rules/clock';
import { UI_SLAB, darken, textColorOn } from '../render/palette';
import { drawTeamLogo } from '../render/logo';
import type { TeamColors } from '@/teams/types';
import { drawFootballGlyph, drawSlab, drawTab, fillAlpha, type ArtCtx } from '../widgets/ui-art';
import { drawText, measureText, type FillCtx, fitLines } from '../render/text';
import type { Theme } from '../theme';
import type { ResolvedPalettes } from '../render/palette';
import { situationSummary } from './session-flow';

export interface HudTeam {
  abbr: string;
  score: number;
  timeouts: number;
  color: string;
  textColor: string;
  /** Emblem seed and (colour-blind resolved) colours for the team tab; absent = no emblem. */
  logoSeed?: number;
  colors?: TeamColors;
}

export interface HudData {
  home: HudTeam;
  away: HudTeam;
  possession: TeamSide | null;
  /** "Q3", "OT", "OT2" */
  period: string;
  clock: string;
  /** Seconds on the play clock, or null between plays. */
  playClock: number | null;
  /** "2ND & 7 · OPP 34" or "KICKOFF" / "PAT". */
  situation: string;
  resultText: string | null;
  pbpLine: string | null;
  kickMeter: KickMeterState | null;
  final: boolean;
  /** Clock is running (drawn brighter). */
  clockRunning: boolean;
  /** "WIND 31 MPH · HEADWIND" (relative to the team with the ball) when the wind is worth noting, else null. */
  wind?: string | null;
}

/** Wind under which it is not shown (it barely moves a kick). */
export const WIND_SHOWN_MPH = 5;

/**
 * Wind readout for the team with the ball: HEADWIND when it blows against the way the offense attacks (kicks
 * fall short), TAILWIND with it, CROSSWIND when it mostly blows across the field. Null for a calm day.
 */
export const windText = (weather: Pick<WeatherState, 'windDir' | 'windMph'>, direction: 1 | -1): string | null => {
  if (!(weather.windMph >= WIND_SHOWN_MPH)) return null;
  const along = Math.sin(weather.windDir) * direction;
  const across = Math.cos(weather.windDir);
  const kind = Math.abs(across) > Math.abs(along) ? 'CROSSWIND' : along > 0 ? 'TAILWIND' : 'HEADWIND';
  return `WIND ${Math.round(weather.windMph)} MPH · ${kind}`;
};

export interface HudOptions {
  play?: PlayState | null;
  resultText?: string | null;
  pbpLine?: string | null;
  palettes: ResolvedPalettes;
}

/** Game-clock seconds run during the live play (0 before it starts, on untimed tries and between plays), scaled as the outcome charges them. */
export const liveClockElapsed = (play: PlayState | null): number => {
  if (!play || play.phase !== 'live') return 0;
  const start = play.clockStartTick;
  if (start === undefined || start === null) return 0;
  return Math.max(0, (play.tick - start) / TICK_RATE) * liveClockScale(play.ctx.special);
};

const periodLabel = (state: GameState): string => (state.overtime ? (state.overtime.period > 1 ? `OT${state.overtime.period}` : 'OT') : `Q${state.clock.quarter}`);

/** Projects the state into the HUD's data. */
export const buildHudData = (state: GameState, setup: GameSetup, opts: HudOptions): HudData => {
  const team = (side: TeamSide, color: string): HudTeam => ({
    abbr: setup[side].team.abbr, score: state.score[side], timeouts: state.timeouts[side], color, textColor: textColorOn(color),
    logoSeed: setup[side].team.logoSeed, colors: opts.palettes[side],
  });
  const play = opts.play ?? null;
  const playClock = play && play.phase === 'presnap' ? Math.max(0, play.playClock) : play && play.phase === 'live' ? null : state.clock.playClockRunning && state.phase !== 'final' ? state.clock.playClock : null;
  // From the local player's side of the ball: while he defends, the offense's own 14 reads "OPP 14". Someone only
  // watching (no human at the controls on his side) gets the offense's view, like any spectator.
  const viewer = state.userSide !== null && state.controllers[state.userSide] === 'human' ? state.userSide : null;
  const situation = situationSummary(state, viewer);
  return {
    home: team('home', opts.palettes.home.primary),
    away: team('away', opts.palettes.away.primary),
    possession: state.phase === 'final' ? null : state.possession,
    period: periodLabel(state),
    clock: formatClock(Math.max(0, state.clock.secondsRemaining - liveClockElapsed(play))),
    playClock,
    situation,
    resultText: opts.resultText ?? null,
    // The last play's caption runs along the bottom sideline: hidden while the ball is live so it never covers the action.
    pbpLine: play && play.phase === 'live' ? null : opts.pbpLine ?? null,
    kickMeter: play?.kickMeter ?? null,
    final: state.phase === 'final',
    clockRunning: state.clock.running,
    wind: state.phase === 'final' ? null : windText(state.weather, state.direction),
  };
};

export interface ScoreBugRect { x: number; y: number; w: number; h: number }

/** Height of one team row of the score bug. */
const bugRowH = (theme: Theme): number => theme.glyphH + 6 * theme.textScale;

/** Geometry of the score bug at the top-left, in logical pixels. */
export const scoreBugRect = (theme: Theme, width: number): ScoreBugRect => {
  const h = bugRowH(theme) * 2 + 3 * theme.textScale + 1;
  const w = Math.min(width - theme.pad * 2, 112 * theme.textScale + theme.pad * 2);
  return { x: theme.pad, y: theme.pad, w, h };
};

/**
 * Timeout pips: short gold bars with a dark rim, spent ones a hollow dark slot (a shape cue, not only colour); drawn
 * under the abbreviation so they never read as text.
 */
const drawPips = (ctx: ArtCtx, x: number, y: number, count: number, max: number, on: string, scale: number): void => {
  const w = 4 * scale;
  const h = scale + 1;
  for (let i = 0; i < max; i++) {
    const px = x + i * (w + 2 * scale);
    ctx.fillStyle = UI_SLAB.edge;
    ctx.fillRect(px - 1, y - 1, w + 2, h + 2);
    if (i < count) {
      ctx.fillStyle = on;
      ctx.fillRect(px, y, w, h);
    }
  }
};

/**
 * Draws the score bug (broadcast slab, art bible §12.1): per team a team-colour tab with its emblem, abbreviation
 * and timeout pips, the possession football, the score on the ink slab, then a clock block (period over the game
 * clock, gold while it runs). Returns its rectangle so other HUD elements can stack under it.
 */
export const drawScoreBug = (ctx: FillCtx, theme: Theme, hud: HudData, width: number, maxTimeouts = 3): ScoreBugRect => {
  const r = scoreBugRect(theme, width);
  const art = ctx as ArtCtx;
  const c = theme.colors;
  const s = theme.textScale;
  const rowH = bugRowH(theme);
  drawSlab(art, r.x, r.y, r.w, r.h, { fill: c.shadow, alpha: 0.9, outline: UI_SLAB.edge, texture: false, drop: true });
  const clockW = measureText('00:00', s).width + theme.gap * 2;
  const clockX = r.x + r.w - 1 - clockW;
  const logo = rowH - 2 * s;
  const scoreW = measureText('00', s).width + theme.gap * 2;
  const scoreX = clockX - scoreW - 1;
  const tabW = scoreX - (r.x + 1) - 7 * s;
  const rows: { team: HudTeam; side: TeamSide }[] = [{ team: hud.away, side: 'away' }, { team: hud.home, side: 'home' }];
  rows.forEach(({ team, side }, i) => {
    const y = r.y + 1 + s + i * (rowH + s);
    drawTab(art, r.x + 1, y, tabW, rowH, team.color, { cut: 3 * s });
    let tx = r.x + 1 + s;
    if (team.logoSeed !== undefined && team.colors) {
      drawTeamLogo(art, team.logoSeed, team.colors, logo, tx, y + Math.round((rowH - logo) / 2));
      tx += logo + 2 * s;
    }
    const ty = y + 2 * s;
    drawText(ctx, team.abbr, tx, ty, { color: team.textColor, size: s });
    drawPips(art, tx, ty + theme.glyphH + Math.round(1.5 * s), team.timeouts, maxTimeouts, c.accent, s);
    if (hud.possession === side) drawFootballGlyph(art, r.x + 1 + tabW + 3 * s, y + Math.round(rowH / 2));
    // Score well: a darker slab with a bevel, the score centred in it.
    drawSlab(art, scoreX, y, scoreW, rowH, { fill: UI_SLAB.edge, bevel: null, shade: UI_SLAB.bevel, texture: false });
    drawText(ctx, String(team.score), scoreX + scoreW / 2, y + Math.round((rowH - theme.glyphH) / 2), { color: c.text, size: s, align: 'center' });
  });
  // Clock block: a slightly lighter slab on the right with a gold rule while the clock runs.
  drawSlab(art, clockX, r.y + 1, clockW, r.h - 2, { fill: UI_SLAB.ink, bevel: UI_SLAB.bevel, texture: false });
  ctx.fillStyle = hud.clockRunning && !hud.final ? c.accent : c.panelBorder;
  ctx.fillRect(clockX, r.y + 1, 2, r.h - 2);
  const cx = clockX + clockW / 2 + 1;
  const topY = r.y + 1 + s + Math.round((rowH - theme.glyphH) / 2);
  drawText(ctx, hud.period, cx, topY, { color: c.textDim, size: s, align: 'center' });
  drawText(ctx, hud.final ? 'FINAL' : hud.clock, cx, topY + rowH + s, { color: hud.clockRunning ? c.accent : c.text, size: s, align: 'center', shadow: UI_SLAB.edge });
  return r;
};

/** Splits "2ND & 7 · OPP 34" into the down & distance and the spot (null when the situation has no spot). */
export const splitSituation = (situation: string): { main: string; spot: string | null } => {
  const i = situation.indexOf(' · ');
  return i < 0 ? { main: situation, spot: null } : { main: situation.slice(0, i), spot: situation.slice(i + 3) };
};

/**
 * Down & distance slab under the score bug (gold down & distance, dim ball spot), the play clock in its own box
 * (red from 5 s, and a bar that drains), and the wind line under them when it blows.
 */
export const drawSituation = (ctx: FillCtx, theme: Theme, hud: HudData, bug: ScoreBugRect): void => {
  const art = ctx as ArtCtx;
  const c = theme.colors;
  const s = theme.textScale;
  const y = bug.y + bug.h + theme.gap - 1;
  const { main, spot } = splitSituation(hud.situation);
  const mm = measureText(main, s);
  const sm = spot ? measureText(spot, s) : { width: 0, height: 0 };
  const boxH = mm.height + 4 * s;
  // The spot sits after a 2-px divider with the same air on both sides of it.
  const air = theme.gap - 1;
  const boxW = mm.width + (spot ? sm.width + air * 2 + 2 : 0) + theme.gap * 2 + 2;
  drawSlab(art, bug.x, y, boxW, boxH, { fill: c.shadow, alpha: 0.95, texture: false });
  ctx.fillStyle = c.accent;
  ctx.fillRect(bug.x, y, 2, boxH);
  drawText(ctx, main, bug.x + theme.gap + 2, y + 2 * s, { color: c.accent, size: s, shadow: UI_SLAB.edge });
  if (spot) {
    const sx = bug.x + theme.gap + 2 + mm.width + air;
    ctx.fillStyle = c.panelBorder;
    ctx.fillRect(sx, y + 2 * s, 2, mm.height);
    drawText(ctx, spot, sx + 2 + air, y + 2 * s, { color: c.text, size: s });
  }
  if (hud.playClock !== null) {
    const secs = Math.ceil(hud.playClock);
    const pc = `:${String(secs).padStart(2, '0')}`;
    const pm = measureText(pc, s);
    const px = bug.x + boxW + theme.gap - 1;
    const urgent = hud.playClock <= 5;
    const pw = pm.width + theme.gap * 2;
    drawSlab(art, px, y, pw, boxH, { fill: urgent ? darken(c.danger, 0.55) : c.shadow, alpha: 0.95, texture: false, outline: urgent ? c.danger : null });
    drawText(ctx, pc, px + theme.gap, y + 2 * s, { color: urgent ? c.danger : c.text, size: s, shadow: UI_SLAB.edge });
    // Drain bar along the foot of the box (40 s full).
    const frac = Math.max(0, Math.min(1, hud.playClock / 40));
    ctx.fillStyle = urgent ? c.danger : c.accent2;
    ctx.fillRect(px + 1, y + boxH - 2, Math.max(1, Math.round((pw - 2) * frac)), 1);
  }
  if (hud.wind) {
    // The wind moves kicks and deep passes: shown under the down and distance whenever it blows.
    const wy = y + boxH + 2;
    const wm = measureText(hud.wind, s);
    fillAlpha(art, c.shadow, 0.88, bug.x, wy - s, wm.width + theme.gap * 2, wm.height + 2 * s);
    drawText(ctx, hud.wind, bug.x + theme.gap, wy, { color: c.textDim, size: s });
  }
};

/**
 * Post-play caption (lower third): the result headline on a slab with a gold tab, and the last play-by-play line in
 * a dimmer strip under it. Returns the top y of what it drew (the screen's bottom padding line when nothing), so
 * hint buttons can stack above without overlapping.
 */
export const drawResultLine = (ctx: FillCtx, theme: Theme, hud: HudData, width: number, height: number, captionWidth?: number): number => {
  const art = ctx as ArtCtx;
  const c = theme.colors;
  const s = theme.textScale;
  const lineH = theme.glyphH + theme.gap;
  let y = height - theme.pad - lineH;
  if (hud.pbpLine) {
    // Wrapped to the screen (two lines at most, "..." if longer), drawn bottom-up.
    const lines = fitLines(hud.pbpLine, Math.max(60, Math.min(width - theme.pad * 4, captionWidth ?? width)), 2, s);
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i] as string;
      const m = measureText(text, s);
      const bx = Math.round((width - m.width) / 2) - theme.gap;
      fillAlpha(art, c.shadow, 0.9, bx, y - 1, m.width + theme.gap * 2, m.height + 2);
      ctx.fillStyle = UI_SLAB.bevel;
      if (i === 0) ctx.fillRect(bx, y - 1, m.width + theme.gap * 2, 1);
      drawText(ctx, text, width / 2, y, { color: c.textDim, size: s, align: 'center' });
      y -= lineH;
    }
    y -= theme.gap;
  }
  if (hud.resultText) {
    const m = measureText(hud.resultText, s);
    const bw = m.width + theme.gap * 4;
    const bx = Math.round((width - bw) / 2);
    // Outline, a 2-px gold cap, then a pixel of air above the text (and air + outline below it).
    const bh = m.height + 2 * s + 4;
    const by = y - s - 3;
    drawSlab(art, bx, by, bw, bh, { fill: c.shadow, alpha: 0.92, outline: UI_SLAB.edge, texture: false });
    ctx.fillStyle = c.accent;
    ctx.fillRect(bx + 1, by + 1, bw - 2, 2);
    ctx.fillRect(bx + 1, by + 1, 2, bh - 2);
    ctx.fillRect(bx + bw - 3, by + 1, 2, bh - 2);
    drawText(ctx, hud.resultText, width / 2, y, { color: c.text, size: s, align: 'center', shadow: UI_SLAB.edge });
    return by - 1;
  }
  return hud.pbpLine ? y + lineH + theme.gap - 1 : height - theme.pad;
};

/**
 * Whole HUD in one call (kick meter is drawn by kick-meter-view from hud.kickMeter by the screen). Returns the top
 * y of the bottom result / caption stack. `captionWidth` narrows the centred caption (e.g. clear of touch buttons).
 */
export const drawHud = (ctx: FillCtx, theme: Theme, hud: HudData, width: number, height: number, maxTimeouts = 3, captionWidth?: number): number => {
  const bug = drawScoreBug(ctx, theme, hud, width, maxTimeouts);
  drawSituation(ctx, theme, hud, bug);
  return drawResultLine(ctx, theme, hud, width, height, captionWidth);
};
