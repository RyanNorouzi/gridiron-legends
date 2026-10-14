/**
 * Playoffs mode: straight to the bracket. The wizard creates a league with the chosen team; this screen
 * plays the preseason (which decides nothing here) with the quick rating-based simulator, then simulates the whole
 * regular season with the league simulator (the real whole-game fast sim, so standings, stat leaders and awards
 * come from real games; progress overlay, saved every few weeks so a reload resumes it), then shows the
 * bracket (one tab per round). If the chosen team missed the playoffs the player takes over any playoff team.
 * Start / ADVANCE offer Play (game day for the user's playoff game), Sim this round or Sim to the champion; the
 * other playoff games use the real simulator. When a champion is crowned the season summary closes the mode.
 * With a save system the run lives in its own slot (mode 'playoffs'), autosaved after the regular season, every
 * round and every play of a live game, so it can be continued from the Franchise menu.
 */
import type { TeamId } from '@/core/ids';
import { seedOf } from '@/franchise/playoffs';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { GameSimulator } from '@/franchise/sim-seam';
import type { GameState } from '@/game/types';
import type { Autosaver } from '@/save/autosave';
import type { SaveSystem } from '@/save/index';
import type { League } from '@/franchise/types';
import type { InputState } from '../input/types';
import { drawText, measureText } from '../render/text';
import type { RenderContext, Screen, ScreenServices } from '../screens/screen';
import { drawHintBar } from '../widgets/panel';
import { createFranchiseContext, type FranchiseContext } from './context';
import { GameDayScreen, type GameDayOptions } from './game-day';
import { fitCell } from './kit/data-table-view';
import { ChoiceDialog } from './kit/dialogs';
import { formatRecord } from './kit/format';
import { inRect, pressed, type Rect } from './kit/list';
import { BracketView } from './shell/bracket-view';
import { flushOnPageHide, resumableGameFor } from './shell/live-game-save';
import { advanceOptions, type AdvanceAction } from './shell/hub-model';
import { SimProgressScreen } from './shell/progress-screen';
import { buildRecap } from './shell/recap-model';
import { WeekRecapScreen } from './shell/recap-screen';
import { SeasonSummaryScreen } from './shell/season-summary';
import { SimJob, type SimJobResult, type SimTarget } from './shell/sim-job';
import { LeagueSaveGate } from './shell/sim-saves';
import { dialogRows, drawButton, glyphOf, hintBarHeight } from './shell/widgets';

/** Options of the mode. */
export interface PlayoffsModeOptions {
  league: League;
  onExit(): void;
  /** Regular-season simulator (default: the same real simulator as the playoff games). */
  seasonSimulator?: GameSimulator;
  /** Save slot of this run and the save system (absent = not saved). */
  slot?: string | null;
  saveSystem?: SaveSystem | null;
  /** A playoff game left in progress (page reload): offered for resume on entry. */
  resumeGame?: GameState | null;
  /** Playoff-game simulator (default: the real whole-game simulator). */
  simulator?: GameSimulator;
  createSession?: GameDayOptions['createSession'];
  onSettings?(): void;
}

/** The League with another user team (flags kept consistent). */
export const withUserTeam = (league: League, teamId: TeamId): League => {
  if (!league.teams[teamId]) throw new Error(`withUserTeam: unknown team ${teamId}`);
  const teams = Object.fromEntries(Object.values(league.teams).map((t) => [t.id, { ...t, isUserControlled: t.id === teamId }])) as League['teams'];
  return { ...league, userTeamId: teamId, teams };
};

/** Seeded teams of the league's bracket, best seeds first across conferences. */
export const playoffField = (league: League): TeamId[] => {
  const seeds = league.season.bracket?.seeds ?? {};
  const lists = Object.values(seeds);
  const longest = Math.max(0, ...lists.map((l) => l.length));
  const out: TeamId[] = [];
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i] as TeamId);
  return out;
};

/** The Playoffs-mode screen (bracket + advance). */
export class PlayoffsModeScreen implements Screen {
  readonly id = 'franchise-playoffs-mode';
  private services: ScreenServices | null = null;
  private current: League;
  private fcValue: FranchiseContext | null = null;
  private bracket: BracketView | null = null;
  private started = false;
  private advanceRect: Rect | null = null;
  private done = false;
  private autosaver: Autosaver | null = null;
  private liveGame: GameState | null = null;
  private detachPageHide: (() => void) | null = null;
  private readonly saves = new LeagueSaveGate(() => this.autosaver, { onError: () => this.services?.toast('Autosave failed') });

  constructor(private readonly opts: PlayoffsModeOptions) {
    if (!opts.league.userTeamId) throw new Error('PlayoffsModeScreen: the league has no user team');
    this.current = opts.league;
  }

  get league(): League { return this.current; }
  get view(): BracketView | null { return this.bracket; }
  get fc(): FranchiseContext {
    if (!this.fcValue) throw new Error('PlayoffsModeScreen: not entered yet');
    return this.fcValue;
  }

  private makeContext(services: ScreenServices): void {
    this.fcValue = createFranchiseContext({
      services, getLeague: () => this.current, setLeague: (l) => { this.current = l; }, userTeamId: this.current.userTeamId as TeamId,
      onCommit: (_l, reason) => this.saves.committed(reason),
      onLiveGame: (state) => {
        this.liveGame = state ? (structuredClone(state) as GameState) : null;
        this.autosaver?.mark('gameProgress');
      },
    });
  }

  /** The run's autosaver (null when it is not saved). */
  get saver(): Autosaver | null { return this.autosaver; }

  enter(services: ScreenServices): void {
    this.services = services;
    if (!this.fcValue) this.makeContext(services);
    const sys = this.opts.saveSystem;
    if (!this.autosaver && sys && this.opts.slot) {
      this.autosaver = sys.createAutosaver({
        enabled: true, debounceMs: 1500, slot: this.opts.slot,
        source: { league: () => this.current, game: () => this.liveGame }, onError: () => services.toast('Autosave failed'),
      });
      const saver = this.autosaver;
      this.detachPageHide = flushOnPageHide(() => { void saver.flush().catch(() => undefined); });
    }
    if (!this.started) {
      this.started = true;
      this.simulateSeason();
      this.offerResume();
    }
  }

  /** A playoff game left in progress resumes at its score (or is simmed from it); it is never replayed. */
  private offerResume(): void {
    const saved = this.opts.resumeGame ?? null;
    const game = resumableGameFor(this.current, saved, this.current.userTeamId as TeamId);
    if (!game || !saved) return;
    this.liveGame = structuredClone(saved) as GameState;
    this.fc.push(new GameDayScreen(this.fc, game.id, { ...this.gameDayOptions(), resume: saved }));
  }

  private gameDayOptions(): GameDayOptions {
    return {
      ...(this.opts.simulator ? { simulator: this.opts.simulator } : {}), ...(this.opts.createSession ? { createSession: this.opts.createSession } : {}),
      ...(this.opts.onSettings ? { onSettings: this.opts.onSettings } : {}), onFinished: () => this.afterRound(),
    };
  }

  exit(): void { this.services = null; }
  resume(): void { this.refresh(); }

  private refresh(): void {
    if (this.current.season.bracket) {
      if (this.bracket) this.bracket.refresh(this.current, this.current.userTeamId);
      else this.bracket = new BracketView(this.current, this.current.userTeamId);
    }
  }

  /**
   * Simulates the preseason (quick rating-based simulator: its games decide nothing here) and then the regular season
   * (real simulator) unless the league is already in the playoffs. Both resume from the last saved week.
   */
  simulateSeason(): void {
    const phase = this.current.season.phase;
    if (phase === 'playoffs' || phase === 'awards') return this.afterSeason();
    const onStep = (league: League, kind: 'week' | 'phase'): void => this.checkpoint(league, kind);
    if (phase === 'preseason') {
      const job = new SimJob(this.current, { kind: 'phase', phase: 'regularSeason' }, { simulator: this.opts.seasonSimulator ?? fallbackSimulator, onStep });
      this.fc.push(new SimProgressScreen(job, {
        title: 'PRESEASON', cancellable: false,
        onDone: (r) => {
          if (r.error || r.league.season.phase !== 'regularSeason') return this.seasonDone(r);
          this.current = r.league;
          this.simulateSeason();
        },
      }));
      return;
    }
    // The real whole-game simulator (SimJob's default) unless the host injects one: no placeholder stat lines.
    const simulator = this.opts.seasonSimulator ?? this.opts.simulator;
    const job = new SimJob(this.current, { kind: 'phase', phase: 'playoffs' }, { ...(simulator ? { simulator } : {}), onStep });
    this.fc.push(new SimProgressScreen(job, { title: 'REGULAR SEASON', cancellable: false, onDone: (r) => this.seasonDone(r) }));
  }

  /** A finished week / phase step of the season sim: kept, and written every few weeks (a reload resumes there). */
  private checkpoint(league: League, kind: 'week' | 'phase'): void {
    this.saves.checkpoint(kind, () => {
      this.current = league;
      this.saves.committed(kind === 'week' ? 'weekAdvance' : 'phaseChange');
    });
  }

  private seasonDone(r: SimJobResult): void {
    if (r.error || r.league.season.phase !== 'playoffs') {
      this.fc.toast(`The regular season could not be simulated: ${r.error ?? 'unknown error'}`);
      this.opts.onExit();
      return;
    }
    this.current = r.league;
    this.saves.committed('phaseChange');
    this.afterSeason();
  }

  /** Offers a playoff team when the user's team missed out; shows the bracket. */
  private afterSeason(): void {
    const user = this.current.userTeamId as TeamId;
    const bracket = this.current.season.bracket;
    if (bracket && !seedOf(bracket, user)) {
      const st = this.current.season.standings[user];
      const field = playoffField(this.current);
      this.fc.push(new ChoiceDialog('Missed the playoffs', `${this.current.teams[user]?.abbr ?? 'Your team'} finished ${st ? formatRecord(st) : ''}. Take over a playoff team:`, field.map((id) => {
        const s = seedOf(bracket, id);
        const t = this.current.teams[id];
        return { id, label: `#${s?.seed ?? '?'} ${t?.city ?? ''} ${t?.name ?? ''}`, subLabel: `${s?.conference ?? ''} - ${formatRecord(this.current.season.standings[id] ?? { wins: 0, losses: 0 })}` };
      }), (id) => {
        if (id) this.switchTeam(id as TeamId);
        else this.opts.onExit();
      }, { maxVisible: dialogRows(this.fc.services.theme, true) }));
    }
    this.refresh();
  }

  /** Makes `teamId` the user team (Playoffs mode only). */
  switchTeam(teamId: TeamId): void {
    this.current = withUserTeam(this.current, teamId);
    if (this.services) this.makeContext(this.services);
    this.autosaver?.mark('edit');
    this.refresh();
  }

  /** Advance choices for the current round. */
  options(): ReturnType<typeof advanceOptions> {
    return advanceOptions(this.current, this.current.userTeamId as TeamId, 'season');
  }

  openAdvance(): void {
    if (this.current.season.phase !== 'playoffs') return this.openSummary();
    const options = this.options();
    this.fc.push(new ChoiceDialog('Playoffs', '', options.map((o) => ({ id: o.id, label: o.label, subLabel: o.detail })), (id) => {
      const opt = options.find((o) => o.id === id);
      if (opt) this.run(opt.action);
    }, { maxVisible: dialogRows(this.fc.services.theme, true) }));
  }

  /** Runs an advance action. */
  run(action: AdvanceAction): void {
    if (action.kind === 'summary') return this.openSummary();
    if (action.kind === 'play') {
      this.fc.push(new GameDayScreen(this.fc, action.gameId, this.gameDayOptions()));
      return;
    }
    this.sim(action.target);
  }

  /** Simulates a round (or to the champion). */
  sim(target: SimTarget): SimJob {
    const before = this.current;
    const job = new SimJob(before, target, { ...(this.opts.simulator ? { simulator: this.opts.simulator } : {}) });
    this.fc.push(new SimProgressScreen(job, {
      onDone: (r) => {
        if (r.weeks.length > 0) this.fc.commit(r.league, 'weekAdvance');
        if (r.error) this.fc.toast(`Simulation stopped: ${r.error}`);
        if (r.weeks.length > 0) this.fc.push(new WeekRecapScreen(this.fc, buildRecap(before, r, this.fc.userTeamId), () => this.afterRound()));
      },
    }));
    return job;
  }

  private afterRound(): void {
    this.refresh();
    if (this.current.season.phase !== 'playoffs') this.openSummary();
  }

  /** The season summary; closing it ends the mode. */
  openSummary(): void {
    this.fc.push(new SeasonSummaryScreen(this.fc, () => this.finish(), { continueLabel: 'MAIN MENU' }));
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.detachPageHide?.();
    const saver = this.autosaver;
    if (saver) void saver.flush().catch(() => undefined).finally(() => saver.dispose());
    this.opts.onExit();
  }

  update(dt: number, input: InputState): void {
    const p = input.pointer;
    if (p?.justDown && this.advanceRect && inRect(this.advanceRect, p.x, p.y)) return this.openAdvance();
    if (pressed(input, ['pause'])) return this.openAdvance();
    const r = this.bracket?.update(dt, input) ?? (pressed(input, ['back']) ? 'back' : null);
    if (r === 'back') {
      this.fc.push(new ChoiceDialog('Leave the playoffs?', this.autosaver ? 'Your run is saved: continue it from the Franchise menu.' : 'This run is not saved.', [{ id: 'stay', label: 'Keep playing' }, { id: 'quit', label: 'Quit to menu' }], (id) => {
        if (id === 'quit') this.finish();
      }));
    } else if (r && typeof r === 'object') this.fc.openTeam(r.open);
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    const user = this.current.userTeamId as TeamId;
    const team = this.current.teams[user];
    const bracket = this.current.season.bracket;
    const seed = bracket ? seedOf(bracket, user) : null;
    const year = this.current.season.year;
    const who = team ? `${team.abbr}${seed ? ` #${seed.seed}` : ''}` : '';
    // Longest title that fits beside ADVANCE (large text drops the conference, then the word PLAYOFFS).
    const titles = [
      `${year} PLAYOFFS${team ? ` - ${who}${seed ? ` ${seed.conference}` : ''}` : ''}`,
      `${year} PLAYOFFS${team ? ` - ${who}` : ''}`,
      team ? `${year} - ${who}` : `${year} PLAYOFFS`,
    ];
    this.advanceRect = drawButton(ctx, theme, 'ADVANCE ▶', width - theme.pad, theme.pad - theme.gap, true, 'right', true);
    const titleW = this.advanceRect.x - theme.pad * 2;
    const title = titles.find((t) => measureText(t, size).width <= titleW) ?? (titles.at(-1) as string);
    drawText(ctx, fitCell(title, titleW, size), theme.pad, theme.pad, { size, color: c.accent, shadow: c.shadow });
    const hintH = hintBarHeight(theme);
    const top = theme.pad + theme.lineHeight + theme.gap;
    if (this.bracket) this.bracket.draw(ctx, theme, { x: theme.pad, y: top, w: width - theme.pad * 2, h: height - top - hintH - theme.pad * 2 });
    else drawText(ctx, 'Simulating the regular season...', width / 2, height / 2, { size, align: 'center', color: c.textDim });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: `${glyphOf(input, 'menuTabLeft')} ${glyphOf(input, 'menuTabRight')}`, label: 'Round' },
      { glyph: glyphOf(input, 'pause'), label: 'Advance' },
      { glyph: glyphOf(input, 'back'), label: 'Quit' },
    ], width, height - hintH - theme.pad);
  }
}
