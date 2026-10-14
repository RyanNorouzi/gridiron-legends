/**
 * Franchise hub. Owns the League of a running franchise (or Season-mode season) and the FranchiseContext every
 * franchise screen receives: commits replace the League and mark the autosaver (save system slot) with their
 * reason; completed weeks, finished games and phase changes are written at once (shell/sim-saves.ts). Layout: header (logo, team, record, date, cash, cap space, fan support, ADVANCE and MENU buttons), the
 * grouped tab bar (home + team + market + league tab lists), the active tab's screen hosted inside the content
 * rect, and a hint bar.
 *
 * Input: U/O (LB/RB) or a tap switch tabs; Start (Enter) or ADVANCE opens the context-aware Advance menu (Play /
 * Sim this week, sim to a later point, next offseason phase, the season summary in Season mode); Back (B/L/Esc)
 * or MENU opens the hub menu (resume, save, settings, save & quit). Everything else goes to the active tab.
 * Before the calendar moves, blocking roster issues (userRosterIssues) offer auto-fix or a jump to the roster.
 */
import { advanceLeaguePhase, autoFixUserRoster } from '@/franchise/season-loop';
import type { GameSimulator } from '@/franchise/sim-seam';
import type { League } from '@/franchise/types';
import { isGamePhase } from '@/franchise/week';
import type { GameState } from '@/game/types';
import type { Autosaver } from '@/save/autosave';
import type { SaveSystem } from '@/save/index';
import type { InputState } from '../input/types';
import type { RenderContext, Screen, ScreenServices } from '../screens/screen';
import { drawHintBar } from '../widgets/panel';
import { createFranchiseContext, HUB_GROUPS, HUB_GROUP_LABELS, type CommitReason, type FranchiseContext, type HubTab } from './context';
import { GameDayScreen, type GameDayOptions } from './game-day';
import { openStreetFreeAgents, streetMarketOpen } from './market/street-fa';
import { createHomeTabs, type HomeActions } from './home-tab';
import { ChoiceDialog, ConfirmDialog } from './kit/dialogs';
import { inRect, pressed, type Rect } from './kit/list';
import { TabBar, drawTabBar, type TabSpec } from './kit/tabbar';
import { drawHubHeader, hubHeaderHeight, layoutHubHeader } from './shell/hub-header';
import { advanceOptions, blockerSummary, hubHeader, rosterBlockers, rosterTabId, type AdvanceAction, type AdvanceOption, type HubMode } from './shell/hub-model';
import { SimProgressScreen } from './shell/progress-screen';
import { LeagueRulesScreen } from './shell/league-rules-screen';
import { flushOnPageHide, resumableGameFor } from './shell/live-game-save';
import { openPracticeDialog, practiceMenuLabel } from './shell/practice-dialog';
import { buildRecap } from './shell/recap-model';
import { WeekRecapScreen } from './shell/recap-screen';
import { SeasonSummaryScreen } from './shell/season-summary';
import { markDuration, perfNow } from '@/tools/frame-stats';
import { SimJob, changedPhase, type SimJobResult, type SimTarget } from './shell/sim-job';
import { LeagueSaveGate } from './shell/sim-saves';
import { dialogRows, glyphOf, hintBarHeight } from './shell/widgets';
import { leagueTabs } from './tabs-league';
import { marketTabs } from './tabs-market';
import { teamTabs } from './tabs-team';

/** Options of the hub. */
export interface FranchiseHubOptions {
  league: League;
  /** Default 'franchise'. */
  mode?: HubMode;
  /** Save slot of this franchise (or Season-mode season); null/absent = not saved. */
  slot?: string | null;
  /** A game in progress loaded from the slot: the hub offers to resume it (or sim the rest) on entry. */
  resumeGame?: GameState | null;
  saveSystem?: SaveSystem | null;
  /** Autosave quiet period (default 1500 ms). */
  autosaveDebounceMs?: number;
  /** League simulator (default: the real whole-game simulator). */
  simulator?: GameSimulator;
  createSession?: GameDayOptions['createSession'];
  onSettings?(): void;
  /** Leaves the hub (the app returns to the main menu). */
  onExit(): void;
  /** Tabs; default home + team + market + league lists. */
  tabs?: readonly HubTab[];
}

/** Every tab list in HUB_GROUPS order (stable within a group); `home` resolves the hub for the Home tab. */
export const defaultHubTabs = (home: () => HomeActions | null = () => null): HubTab[] => {
  const all = [...createHomeTabs(home), ...teamTabs, ...marketTabs, ...leagueTabs];
  return HUB_GROUPS.flatMap((g) => all.filter((t) => t.group === g));
};

interface HostedTab { screen: Screen; seen: League | null; entered: boolean }

/** The franchise hub screen. */
export class FranchiseHubScreen implements Screen {
  readonly id = 'franchise-hub';
  readonly mode: HubMode;
  private current: League;
  private services: ScreenServices | null = null;
  private fcValue: FranchiseContext | null = null;
  private autosaver: Autosaver | null = null;
  private readonly allTabs: readonly HubTab[];
  private readonly bar: TabBar;
  private readonly hosted = new Map<string, HostedTab>();
  private header: { advance: Rect; menu: Rect } | null = null;
  private exited = false;
  /** League the tab specs (availability, badges) were last built from. */
  private specsFor: League | null = null;
  /** State of the user's live game (saved with the League after every play), null between games. */
  private liveGame: GameState | null = null;
  private detachPageHide: (() => void) | null = null;
  private resumeOffered = false;
  private readonly saves = new LeagueSaveGate(() => this.autosaver, { onError: () => this.services?.toast('Autosave failed') });

  constructor(private readonly opts: FranchiseHubOptions) {
    if (!opts.league.userTeamId) throw new Error('FranchiseHubScreen: the league has no user team');
    this.current = opts.league;
    this.mode = opts.mode ?? 'franchise';
    this.allTabs = opts.tabs ?? defaultHubTabs(() => this);
    this.bar = new TabBar(this.tabSpecs(), { groupLabels: HUB_GROUP_LABELS });
  }

  get league(): League { return this.current; }
  get slot(): string | null { return this.opts.slot ?? null; }
  /** The context handed to tabs (created on enter). */
  get fc(): FranchiseContext {
    if (!this.fcValue) throw new Error('FranchiseHubScreen: not entered yet');
    return this.fcValue;
  }
  get tabs(): TabBar { return this.bar; }
  get activeTabId(): string | null { return this.bar.current?.id ?? null; }
  get saver(): Autosaver | null { return this.autosaver; }

  private tabSpecs(): TabSpec[] {
    return this.allTabs.filter((t) => t.available?.(this.current) ?? true).map((t) => ({ id: t.id, label: t.label, group: t.group, badge: t.badge?.(this.current) ?? null }));
  }

  /** Content rect for hosted tabs (below header and tab bar, above the hint bar). */
  contentRect(): Rect {
    const s = this.services;
    const theme = s?.theme;
    if (!s || !theme) return { x: 0, y: 0, w: 480, h: 270 };
    const top = hubHeaderHeight(theme) + TabBar.height(theme) + theme.gap;
    const bottom = s.height - hintBarHeight(theme) - theme.pad - theme.gap;
    return { x: theme.pad, y: top, w: s.width - theme.pad * 2, h: Math.max(theme.lineHeight, bottom - top) };
  }

  private commitLeague(next: League, reason: CommitReason): void {
    this.current = next;
    // 'edit' commits save after the autosaver's quiet period; a finished week / game / phase is written at once.
    this.saves.committed(reason);
  }

  enter(services: ScreenServices): void {
    this.services = services;
    if (!this.fcValue) {
      this.fcValue = createFranchiseContext({
        services, getLeague: () => this.current, setLeague: (l) => { this.current = l; }, onCommit: (l, r) => this.commitLeague(l, r), contentRect: () => this.contentRect(),
        onLiveGame: (state) => {
          this.liveGame = state ? (structuredClone(state) as GameState) : null;
          this.autosaver?.mark('gameProgress');
        },
      });
    }
    const sys = this.opts.saveSystem;
    if (!this.autosaver && sys && this.opts.slot) {
      this.autosaver = sys.createAutosaver({
        enabled: true, debounceMs: this.opts.autosaveDebounceMs ?? 1500, slot: this.opts.slot,
        source: { league: () => this.current, game: () => this.liveGame }, onError: () => services.toast('Autosave failed'),
      });
      const saver = this.autosaver;
      this.detachPageHide = flushOnPageHide(() => { void saver.flush().catch(() => undefined); });
    }
    this.activate();
    this.offerResume();
  }

  /** A game left in progress (page reload) resumes at its score or is simmed from it; it is never replayed. */
  private offerResume(): void {
    if (this.resumeOffered) return;
    this.resumeOffered = true;
    const saved = this.opts.resumeGame ?? null;
    const game = resumableGameFor(this.current, saved, this.fc.userTeamId);
    if (!game || !saved) return;
    this.liveGame = structuredClone(saved) as GameState;
    this.fc.push(new GameDayScreen(this.fc, game.id, {
      ...(this.opts.simulator ? { simulator: this.opts.simulator } : {}), ...(this.opts.createSession ? { createSession: this.opts.createSession } : {}),
      ...(this.opts.onSettings ? { onSettings: this.opts.onSettings } : {}), onFinished: (r) => this.afterAdvance(r), resume: saved,
    }));
  }

  exit(): void {
    for (const h of this.hosted.values()) if (h.entered && this.services) h.screen.exit(this.services);
    this.hosted.clear();
    this.services = null;
  }

  pause(services: ScreenServices): void { this.activeHosted()?.screen.pause?.(services); }

  resume(services: ScreenServices): void {
    this.bar.setTabs(this.tabSpecs());
    const h = this.activeHosted();
    if (h?.entered) {
      h.seen = this.current;
      h.screen.resume?.(services);
    } else this.activate();
  }

  private activeHosted(): HostedTab | null {
    const id = this.activeTabId;
    return id ? this.hosted.get(id) ?? null : null;
  }

  /** Creates / enters the active tab's screen and refreshes it when the League changed while it was hidden. */
  private activate(): void {
    const s = this.services;
    const id = this.activeTabId;
    if (!s || !id) return;
    let h = this.hosted.get(id);
    if (!h) {
      const tab = this.allTabs.find((t) => t.id === id);
      if (!tab) return;
      h = { screen: tab.create(this.fc), seen: this.current, entered: false };
      this.hosted.set(id, h);
    }
    if (!h.entered) {
      h.screen.enter(s);
      h.entered = true;
    } else if (h.seen !== this.current) h.screen.resume?.(s);
    h.seen = this.current;
  }

  /** Rebuilds the active tab after a commit the hub made itself. */
  private refreshActive(): void {
    const h = this.activeHosted();
    if (h?.entered && this.services && h.seen !== this.current) {
      h.seen = this.current;
      h.screen.resume?.(this.services);
    }
  }

  /** Switches to a tab by id (false when unknown / unavailable). */
  selectTab(id: string): boolean {
    if (!this.bar.selectById(id)) return false;
    this.activate();
    return true;
  }

  /* ------------------------------------ advance ------------------------------------ */

  /** Current Advance menu entries. */
  advanceOptions(): AdvanceOption[] {
    return advanceOptions(this.current, this.fc.userTeamId, this.mode);
  }

  openAdvanceMenu(): void {
    const options = this.advanceOptions();
    this.fc.push(new ChoiceDialog('Advance', '', options.map((o) => ({ id: o.id, label: o.label, subLabel: o.detail })), (id) => {
      const opt = options.find((o) => o.id === id);
      if (opt) this.runAdvance(opt.action);
    }, { maxVisible: dialogRows(this.fc.services.theme, true) }));
  }

  /** Runs an Advance action, first offering fixes for blocking roster issues. */
  runAdvance(action: AdvanceAction, opts: { skipRosterCheck?: boolean; autoFix?: boolean } = {}): void {
    if (action.kind === 'summary') return this.openSummary();
    // "Roster moves automated": fix the roster now and let every offseason step fix it again, never stopping to ask.
    if (action.kind === 'sim' && action.autoFix && !opts.autoFix) {
      if (rosterBlockers(this.current, this.fc.userTeamId).length > 0) this.fc.commit(autoFixUserRoster(this.current), 'edit');
      return this.runAdvance(action, { skipRosterCheck: true, autoFix: true });
    }
    const blockers = opts.skipRosterCheck ? [] : rosterBlockers(this.current, this.fc.userTeamId);
    if (blockers.length > 0) return this.offerRosterFix(blockerSummary(blockers), action);
    if (action.kind === 'play') {
      this.fc.push(new GameDayScreen(this.fc, action.gameId, {
        ...(this.opts.simulator ? { simulator: this.opts.simulator } : {}), ...(this.opts.createSession ? { createSession: this.opts.createSession } : {}),
        ...(this.opts.onSettings ? { onSettings: this.opts.onSettings } : {}), onFinished: (r) => this.afterAdvance(r),
      }));
      return;
    }
    this.startSim(action.target, opts.autoFix ?? false);
  }

  private offerRosterFix(summary: string, action: AdvanceAction): void {
    const gamePhase = isGamePhase(this.current.season.phase);
    this.fc.push(new ChoiceDialog('Roster issues', summary, [
      { id: 'fix', label: 'Auto-fix roster' },
      ...this.signChoice(),
      { id: 'roster', label: 'Go to roster' },
      ...(gamePhase ? [{ id: 'continue', label: 'Continue anyway' }] : []),
      { id: 'cancel', label: 'Cancel' },
    ], (id) => {
      if (id === 'fix') {
        const fixed = autoFixUserRoster(this.current);
        this.fc.commit(fixed, 'edit');
        this.refreshActive();
        const left = rosterBlockers(fixed, this.fc.userTeamId);
        if (left.length > 0 && !gamePhase) this.fc.toast(`Still blocked: ${blockerSummary(left, 1)}`);
        else this.runAdvance(action, { skipRosterCheck: true, autoFix: true });
      } else if (id === 'roster') this.goToRoster();
      else if (id === 'sign') openStreetFreeAgents(this.fc);
      else if (id === 'continue') this.runAdvance(action, { skipRosterCheck: true });
    }));
  }

  /** "Sign free agents" for a roster-issues prompt, when the user can sign unsigned players right now. */
  private signChoice(): { id: string; label: string }[] {
    return streetMarketOpen(this.current) ? [{ id: 'sign', label: 'Sign free agents' }] : [];
  }

  /** Switches to the roster tab available right now (toast when there is none). */
  private goToRoster(): void {
    const tab = rosterTabId(this.allTabs.filter((t) => t.available?.(this.current) ?? true));
    if (!tab || !this.selectTab(tab)) this.fc.toast('No roster screen is available');
  }

  /** Simulates to `target` behind the progress overlay. */
  startSim(target: SimTarget, autoFix = false): SimJob {
    const before = this.current;
    const started = perfNow();
    let weekStart = started;
    const job = new SimJob(before, target, {
      ...(this.opts.simulator ? { simulator: this.opts.simulator } : {}), autoFix,
      onStep: (league, kind) => {
        markDuration(`sim ${kind}`, weekStart);
        weekStart = perfNow();
        this.checkpoint(league, kind);
      },
    });
    this.fc.push(new SimProgressScreen(job, {
      onDone: (r) => {
        markDuration(`sim to ${target.kind === 'phase' ? target.phase : target.kind} (${r.weeks.length} weeks, ${r.phases.length} phases)`, started);
        this.applySim(before, target, r);
      },
    }));
    return job;
  }

  /**
   * Mid-sim checkpoint: commits the League after each finished week / phase step. The slot is written every few
   * weeks and on phase steps (not after every week: that re-serialized the whole League while the workers waited);
   * a closed tab still flushes the held weeks, and the end of the sim is saved at once.
   */
  private checkpoint(league: League, kind: 'week' | 'phase'): void {
    this.saves.checkpoint(kind, () => this.fc.commit(league, kind === 'week' ? 'weekAdvance' : 'phaseChange'));
    // The tab under the progress overlay shows the finished weeks too.
    this.refreshActive();
  }

  private applySim(before: League, target: SimTarget, r: SimJobResult): void {
    const progressed = r.weeks.length + r.phases.length > 0 && r.league !== before;
    if (progressed) {
      if (r.weeks.length > 0) this.fc.commit(r.league, 'weekAdvance');
      if (changedPhase(before, r) || r.weeks.length === 0) this.fc.commit(r.league, 'phaseChange');
    }
    if (r.blockedBy.length > 0) {
      this.fc.push(new ChoiceDialog('Roster issues', blockerSummary(r.blockedBy), [
        { id: 'fix', label: 'Auto-fix and continue' }, ...this.signChoice(), { id: 'roster', label: 'Go to roster' }, { id: 'cancel', label: 'Cancel' },
      ], (id) => {
        if (id === 'fix') this.startSim(target, true);
        else if (id === 'sign') openStreetFreeAgents(this.fc);
        else if (id === 'roster') this.goToRoster();
      }));
      return;
    }
    if (r.error) this.fc.toast(`Simulation stopped: ${r.error}`);
    if (progressed) this.fc.push(new WeekRecapScreen(this.fc, buildRecap(before, r, this.fc.userTeamId), () => this.afterAdvance(r)));
  }

  /** After a week / stretch: a newly crowned champion shows the season summary (which ends Season mode). */
  private afterAdvance(r: SimJobResult): void {
    const crowned = r.weeks.some((w) => w.events.some((e) => e.type === 'champion'));
    if (this.mode === 'season' ? !isGamePhase(this.current.season.phase) : crowned) this.openSummary();
  }

  /** Season summary. Season mode hands out the awards first (when still due) and leaves the hub on close. */
  openSummary(): void {
    const done = this.mode === 'season';
    if (done && this.current.season.phase === 'awards' && this.current.season.awards.length === 0) {
      try {
        const r = advanceLeaguePhase(this.current);
        this.fc.commit(r.league, 'phaseChange');
      } catch {
        // Awards are optional for the summary; the champion is already known.
      }
    }
    this.fc.push(new SeasonSummaryScreen(this.fc, () => {
      if (done) this.quit();
      else this.fc.pop();
    }, { continueLabel: done ? 'MAIN MENU' : 'CONTINUE' }));
  }

  /* ------------------------------------- menu -------------------------------------- */

  /** Writes the League to the slot now (resolves false without a slot or on failure, with a toast). */
  async saveNow(): Promise<boolean> {
    const sys = this.opts.saveSystem;
    const slot = this.opts.slot;
    if (!sys || !slot) return false;
    try {
      await sys.slots.save(slot, this.current);
      this.services?.toast('Franchise saved');
      return true;
    } catch (err) {
      this.services?.toast(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Leaves the hub (autosaver disposed). */
  quit(): void {
    if (this.exited) return;
    this.exited = true;
    this.detachPageHide?.();
    this.autosaver?.dispose();
    this.opts.onExit();
  }

  /** After a failed save on "Save & quit": leaving must stay possible (e.g. storage full), so ask to quit anyway. */
  private confirmQuitUnsaved(): void {
    if (this.exited || !this.services) return;
    this.fc.push(new ConfirmDialog('Save failed', 'Quit without saving? Progress since the last save will be lost.', {
      defaultNo: true, yesLabel: 'Quit anyway', noLabel: 'Stay', onResult: (yes) => { if (yes) this.quit(); },
    }));
  }

  openMenu(): void {
    const saving = !!(this.opts.saveSystem && this.opts.slot);
    this.fc.push(new ChoiceDialog('Franchise', '', [
      { id: 'resume', label: 'Resume' },
      ...(saving ? [{ id: 'save', label: 'Save now' }] : []),
      ...(isGamePhase(this.current.season.phase) ? [{ id: 'practice', label: practiceMenuLabel(this.fc) }] : []),
      { id: 'rules', label: 'League rules' },
      ...(this.opts.onSettings ? [{ id: 'settings', label: 'Settings' }] : []),
      { id: 'quit', label: saving ? 'Save & quit to menu' : 'Quit to menu' },
    ], (id) => {
      if (id === 'save') void this.saveNow();
      else if (id === 'rules') this.fc.push(new LeagueRulesScreen(this.fc));
      else if (id === 'practice') openPracticeDialog(this.fc);
      else if (id === 'settings') this.opts.onSettings?.();
      else if (id === 'quit') {
        if (saving) void this.saveNow().then((ok) => (ok ? this.quit() : this.confirmQuitUnsaved()));
        else this.fc.push(new ConfirmDialog('Quit?', this.mode === 'season' ? 'This season is not saved and will be lost.' : 'Unsaved progress will be lost.', { defaultNo: true, yesLabel: 'Quit', noLabel: 'Stay', onResult: (yes) => { if (yes) this.quit(); } }));
      }
    }));
  }

  /* ------------------------------------- loop -------------------------------------- */

  update(dt: number, input: InputState, services: ScreenServices): void {
    if (this.specsFor !== this.current) {
      this.specsFor = this.current;
      const before = this.activeTabId;
      this.bar.setTabs(this.tabSpecs());
      if (this.activeTabId !== before) this.activate();
    }
    const p = input.pointer;
    if (p?.justDown && this.header) {
      if (inRect(this.header.advance, p.x, p.y)) return this.openAdvanceMenu();
      if (inRect(this.header.menu, p.x, p.y)) return this.openMenu();
    }
    if (this.bar.update(dt, input)) return this.activate();
    if (pressed(input, ['pause'])) return this.openAdvanceMenu();
    if (pressed(input, ['back'])) return this.openMenu();
    this.activeHosted()?.screen.update(dt, input, services);
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    ctx.fillStyle = theme.colors.bg;
    ctx.fillRect(0, 0, width, height);
    const content = this.contentRect();
    const hosted = this.activeHosted();
    if (hosted) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(content.x - theme.pad, content.y - theme.gap, content.w + theme.pad * 2, content.h + theme.gap * 2);
      ctx.clip();
      hosted.screen.render(rc);
      ctx.restore();
    }
    const view = hubHeader(this.current, this.fc.userTeamId);
    const layout = drawHubHeader(ctx, theme, view, width);
    this.header = { advance: layout.advance, menu: layout.menu };
    drawTabBar(ctx, theme, this.bar, { x: 0, y: layout.rect.h, w: width, h: TabBar.height(theme) });
    const hintH = hintBarHeight(theme);
    ctx.fillStyle = theme.colors.bg;
    ctx.fillRect(0, height - hintH - theme.pad - 1, width, hintH + theme.pad + 1);
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: `${glyphOf(input, 'menuTabLeft')} ${glyphOf(input, 'menuTabRight')}`, label: 'Tabs' },
      { glyph: glyphOf(input, 'pause'), label: 'Advance' },
      { glyph: glyphOf(input, 'back'), label: 'Menu' },
    ], width, height - hintH - theme.pad);
  }
}

/** Header layout for tests / pointer scripts. */
export { layoutHubHeader };
