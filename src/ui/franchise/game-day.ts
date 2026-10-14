/**
 * Game day for the user's scheduled game (regular season, preseason or playoffs). The pre-game card shows both
 * teams (logo, record, ratings), venue, weather forecast, the rivalry flag and the rating edge, with PLAY (the
 * live game), WATCH (spectate, jump in any time), SIM (the whole week simulated) and the defense-control setting.
 *
 * Playing builds the GameSetup with buildGameSetup(league, game, { userSide, controllers }) and pushes the
 * existing game screen. At the final whistle the finished GameState becomes a UserGameResult and the week is
 * completed by a SimJob (advanceLeagueWeek with { userResults }) behind a progress overlay; the League is
 * committed ('gameEnd' + 'weekAdvance'), game day closes and the week recap opens. Quitting mid-game offers
 * "Sim the rest" (the remainder is simulated from the current score; there are no forfeits) or "Keep playing".
 * Nothing touches the League until a complete week succeeded, so a failure never corrupts it.
 */
import type { GameId } from '@/core/ids';
import type { DefenseMode } from '@/core/settings';
import { buildGameSetup, userSideOf } from '@/franchise/game-setup';
import type { UserGameResult } from '@/franchise/season-loop';
import type { GameSimulator } from '@/franchise/sim-seam';
import type { League, ScheduledGame } from '@/franchise/types';
import type { ControllerKind, GameSetup, GameState } from '@/game/types';
import { createGameSession } from '../game/session';
import { createDefaultSessionDeps } from '../game/session-defaults';
import type { GameSession } from '../game/session-types';
import type { InputState } from '../input/types';
import { drawText } from '../render/text';
import { GameScreen, type GameScreenOptions } from '../screens/game';
import { PostGameScreen } from '../screens/post-game';
import type { RenderContext, Screen, ScreenServices } from '../screens/screen';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import type { FranchiseContext } from './context';
import { fitCell } from './kit/data-table-view';
import { ChoiceDialog } from './kit/dialogs';
import { cycleOption } from './kit/list';
import { toneColor } from './kit/format';
import { matchupCard, type MatchupCard, type MatchupSide } from './shell/game-day-model';
import { simulateRestOfGame, userResultFromState } from './shell/game-result';
import { liveGameSummary } from './shell/live-game-save';
import { SimProgressScreen } from './shell/progress-screen';
import { buildRecap } from './shell/recap-model';
import { WeekRecapScreen } from './shell/recap-screen';
import { SimJob, type SimJobResult } from './shell/sim-job';
import { drawTeamBadge, glyphOf, hintBarHeight, refitMenu } from './shell/widgets';

/** Re-exported game-result bridges (GameState -> UserGameResult, sim the rest of an abandoned game). */
export { userResultFromState, simulateRestOfGame } from './shell/game-result';

/** Options of game day. */
export interface GameDayOptions {
  /** Simulator for the other games of the week (default: the real whole-game simulator). */
  simulator?: GameSimulator;
  /** Live session factory (default: the real engine over the app settings / audio); `initialState` resumes a
   *  saved game in progress. */
  createSession?(setup: GameSetup, services: ScreenServices, initialState?: GameState): GameSession;
  /** A saved game in progress (page reload mid-game): game day opens with RESUME / SIM THE REST, never a replay. */
  resume?: GameState;
  onSettings?(): void;
  /** After the week was applied and the recap closed. */
  onFinished?(result: SimJobResult): void;
}

const DEFENSE_LABELS: Record<DefenseMode, string> = { control: 'Control', watch: 'Watch', playcallOnly: 'Call only' };
const DEFENSE_MODES: readonly DefenseMode[] = ['control', 'watch', 'playcallOnly'];

/** The game screen, reporting the final whistle instead of showing the quick-game post-game screen. */
export class FranchiseGameScreen extends GameScreen {
  private reported = false;

  constructor(session: GameSession, private readonly onFinal: (state: Readonly<GameState>) => void, opts: GameScreenOptions) {
    super(session, opts);
  }

  override update(dt: number, input: InputState, services: ScreenServices): void {
    super.update(dt, input, services);
    if (this.reported || this.session.stage.kind !== 'final') return;
    this.reported = true;
    const top = services.stack.top;
    if (top instanceof PostGameScreen || top === this) services.stack.pop();
    this.onFinal(this.session.state);
  }
}

/** Pre-game card and the play / sim flow for one scheduled user game. */
export class GameDayScreen implements Screen {
  readonly id = 'franchise-game-day';
  private services: ScreenServices | null = null;
  private menu: MenuList;
  private session: GameSession | null = null;
  private busy = false;
  private resumeAsked = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly fc: FranchiseContext, readonly gameId: GameId, private readonly opts: GameDayOptions = {}) {
    this.menu = new MenuList(this.items('control'));
  }

  /** The scheduled game (throws when it is no longer on the schedule). */
  game(): ScheduledGame {
    const g = this.fc.league().season.schedule.find((x) => x.id === this.gameId);
    if (!g) throw new Error(`GameDayScreen: unknown game ${this.gameId}`);
    return g;
  }

  /** Current card view-model. */
  card(): MatchupCard {
    return matchupCard(this.fc.league(), this.game(), this.fc.userTeamId);
  }

  get list(): MenuList { return this.menu; }
  /** The live session while a game is being played. */
  get liveSession(): GameSession | null { return this.session; }

  private items(defense: DefenseMode): MenuItem[] {
    return [
      { id: 'play', label: 'Play game' },
      { id: 'watch', label: 'Watch game' },
      { id: 'sim', label: 'Sim game' },
      { id: 'defense', label: 'Defense', value: DEFENSE_LABELS[defense] },
      { id: 'back', label: 'Back' },
    ];
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.menu.setItems(this.items(services.settings.defenseMode));
    const saved = this.opts.resume;
    if (saved && !this.resumeAsked) {
      this.resumeAsked = true;
      this.fc.push(new ChoiceDialog('Game in progress', `${liveGameSummary(this.fc.league(), saved)}. Pick it up where it stopped, or simulate the rest from this score.`, [
        { id: 'resume', label: 'Resume game' },
        { id: 'sim', label: 'Sim the rest' },
      ], (id) => {
        if (id === 'sim') this.simRest(saved);
        else this.play('human', saved);
      }));
    }
  }

  exit(): void { this.services = null; }

  /** Starts the live game (`kind` 'human' plays, 'watch' spectates; `from` resumes a saved state). Returns the setup. */
  play(kind: Extract<ControllerKind, 'human' | 'watch'> = 'human', from?: GameState): GameSetup | null {
    const s = this.services;
    if (!s || this.busy) return null;
    const league = this.fc.league();
    const game = this.game();
    const userSide = userSideOf(league, game);
    if (!userSide) {
      this.fc.toast('Your team is not in this game');
      return null;
    }
    const other = userSide === 'home' ? 'away' : 'home';
    const setup = buildGameSetup(league, game, { userSide, controllers: { [userSide]: kind, [other]: 'ai' } as GameSetup['controllers'] });
    const session = this.opts.createSession
      ? this.opts.createSession(setup, s, from)
      : createGameSession(setup, { ...createDefaultSessionDeps({ settings: s.settings, audio: s.audio }, setup), ...(from ? { initialState: from } : {}) });
    this.session = session;
    // After every play the state goes into the save slot with the League (reload = resume, not a replay).
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((e) => {
      if (e.type === 'stage' && (e.stage.kind === 'postPlay' || e.stage.kind === 'intermission') && session.state.phase !== 'final') this.fc.saveLiveGame?.(session.state);
    });
    this.fc.push(new FranchiseGameScreen(session, (state) => this.finishPlayed(state), {
      onQuit: () => this.confirmLeave(),
      quitWarning: 'Leaving lets you sim the rest',
      onPlayAgain: () => undefined,
      ...(this.opts.onSettings ? { onSettings: this.opts.onSettings } : {}),
    }));
    return setup;
  }

  /** The quit-mid-game prompt (the pause menu already asked "quit?"). */
  confirmLeave(): void {
    const session = this.session;
    if (!session || session.state.phase === 'final') return;
    const st = session.state;
    const score = `${session.setup.away.team.abbr} ${st.score.away} - ${session.setup.home.team.abbr} ${st.score.home}`;
    this.fc.push(new ChoiceDialog('Leave the game?', `${score}. There are no forfeits: leaving simulates the rest of this game from the current score.`, [
      { id: 'sim', label: 'Sim the rest' },
      { id: 'stay', label: 'Keep playing' },
    ], (id) => { if (id === 'sim') this.simRest(); }));
  }

  /** Simulates the remainder of the live game (or of a saved one) and completes the week. */
  simRest(saved?: GameState): void {
    const session = this.session;
    const from = session ? { setup: session.setup, state: session.state } : saved ? this.savedGame(saved) : null;
    if (!from) return;
    let final: GameState | null = null;
    try {
      final = simulateRestOfGame(from.setup, from.state);
    } catch {
      this.fc.toast('The game could not be resumed; it was simulated from kickoff');
    }
    this.closeGame();
    this.completeWeek(final ? { [this.gameId]: userResultFromState(final) } : {}, final !== null);
  }

  /** Final whistle of the live game. */
  finishPlayed(state: Readonly<GameState>): void {
    this.closeGame();
    let result: UserGameResult | null = null;
    try {
      result = userResultFromState(state);
    } catch (err) {
      this.fc.toast(err instanceof Error ? err.message : 'The game result could not be read');
    }
    this.completeWeek(result ? { [this.gameId]: result } : {}, result !== null);
  }

  /** The setup of this game day's game paired with a saved state of it (null when the user is not in it). */
  private savedGame(state: GameState): { setup: GameSetup; state: GameState } | null {
    const league = this.fc.league();
    const game = this.game();
    const userSide = userSideOf(league, game);
    if (!userSide) return null;
    const other = userSide === 'home' ? 'away' : 'home';
    return { setup: buildGameSetup(league, game, { userSide, controllers: { [userSide]: 'human', [other]: 'ai' } as GameSetup['controllers'] }), state };
  }

  private closeGame(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.fc.saveLiveGame?.(null);
    this.session = null;
    const s = this.services;
    if (s && s.stack.all.includes(this)) s.stack.popTo(this);
  }

  /** Simulates the user's game with the rest of the week (the SIM choice). */
  sim(): void {
    if (this.busy) return;
    this.completeWeek({}, false);
  }

  /** Runs the week (with the user's result when he played) behind the progress overlay. */
  completeWeek(userResults: Readonly<Record<GameId, UserGameResult>>, played: boolean): void {
    const before = this.fc.league();
    this.busy = true;
    const job = new SimJob(before, { kind: 'week' }, { ...(this.opts.simulator ? { simulator: this.opts.simulator } : {}), userResults });
    this.fc.push(new SimProgressScreen(job, {
      title: played ? 'FINISHING THE WEEK' : 'SIMULATING THE WEEK',
      cancellable: false,
      onDone: (r) => this.applyWeek(before, r, played),
    }));
  }

  private applyWeek(before: League, r: SimJobResult, played: boolean): void {
    this.busy = false;
    if (r.error || r.weeks.length === 0) {
      this.fc.toast(`The week could not be completed: ${r.error ?? 'no games were played'}`);
      return;
    }
    if (played) this.fc.commit(r.league, 'gameEnd');
    this.fc.commit(r.league, 'weekAdvance');
    const s = this.services;
    if (s && s.stack.top === this) this.fc.pop();
    this.fc.push(new WeekRecapScreen(this.fc, buildRecap(before, r, this.fc.userTeamId), () => this.opts.onFinished?.(r)));
  }

  private leave(): void {
    const s = this.services;
    if (s && s.stack.top === this) this.fc.pop();
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    if (this.busy) return;
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') return this.leave();
    const id = 'item' in ev ? ev.item.id : '';
    if (id === 'defense' && (ev.type === 'change' || ev.type === 'activate')) {
      services.settings.defenseMode = cycleOption(DEFENSE_MODES, services.settings.defenseMode, ev.type === 'change' ? ev.delta : 1);
      services.persistSettings?.();
      this.menu.setItems(this.items(services.settings.defenseMode));
      return;
    }
    if (ev.type !== 'activate') return;
    if (id === 'play') this.play('human');
    else if (id === 'watch') this.play('watch');
    else if (id === 'sim') this.sim();
    else if (id === 'back') this.leave();
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    let card: MatchupCard;
    try {
      card = this.card();
    } catch {
      drawText(ctx, 'Game not found', width / 2, height / 2, { color: c.textDim, size, align: 'center' });
      return;
    }
    const title = `GAME DAY - ${card.title}${card.rivalry ? ' - RIVALRY' : ''}`;
    drawText(ctx, fitCell(title, width - theme.pad * 2, size), width / 2, theme.pad, { size, align: 'center', color: card.rivalry ? c.warning : c.accent, shadow: c.shadow });
    // Bottom up: hint bar, then the choices (3 rows in large text, scrolling), then the cards and info lines.
    const hintH = hintBarHeight(theme);
    const rows = Math.min(this.menu.items.length, size > 1 ? 3 : 5);
    const menuH = rows * theme.lineHeight + theme.border * 2 + theme.gap * 2;
    const menuY = height - hintH - theme.pad - theme.gap - menuH;
    this.menu = refitMenu(this.menu, rows);
    const panel = drawPanel(ctx, theme, theme.pad, menuY, width - theme.pad * 2, menuH, { style: 'raised' });
    this.menu.draw(ctx, theme, panel.x, panel.y, panel.w, { time: rc.time });
    const top = theme.pad + theme.lineHeight;
    const colW = Math.round((width - theme.pad * 3) / 2);
    const logo = Math.min(32, theme.lineHeight * 3);
    const details = size > 1 ? 1 : 2;
    const cardH = Math.max(logo, theme.lineHeight * (2 + details)) + theme.lineHeight + theme.gap * 2;
    this.drawSide(rc, card.away, theme.pad, top, colW, cardH, logo, 'AWAY', details);
    this.drawSide(rc, card.home, theme.pad * 2 + colW, top, colW, cardH, logo, 'HOME', details);
    let y = top + cardH + theme.gap;
    const info: { text: string; color: string }[] = [
      { text: card.edge.text, color: toneColor(theme, card.edge.tone) },
      { text: card.indoor ? card.weather : `Forecast: ${card.weather}`, color: c.textDim },
      { text: card.venue, color: c.textDim },
    ];
    for (const line of info) {
      if (y + theme.glyphH > menuY - theme.gap) break;
      drawText(ctx, fitCell(line.text, width - theme.pad * 2, size), theme.pad, y, { color: line.color, size });
      y += theme.lineHeight;
    }
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: glyphOf(input, 'confirm'), label: 'Select' },
      { glyph: glyphOf(input, 'back'), label: 'Back' },
    ], width, height - hintH - theme.pad);
  }

  private drawSide(rc: RenderContext, side: MatchupSide, x: number, y: number, w: number, h: number, logo: number, label: string, details: number): void {
    const theme = this.services?.theme ?? rc.theme;
    const content = drawPanel(rc.ctx, theme, x, y, w, h, { style: 'raised', title: side.user ? `${label} - YOU` : label, border: side.user ? theme.colors.accent : theme.colors.panelBorder });
    const lines = [side.record, `OVR ${side.overall} OFF ${side.offense} DEF ${side.defense}`].slice(0, details);
    drawTeamBadge(rc.ctx, theme, side, content.x, content.y, content.w, logo, lines);
  }
}
