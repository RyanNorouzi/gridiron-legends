/**
 * Practice game screen: runs a DrillSession rep after rep on the live-play view. Each tick feeds the user's input
 * to the headless DrillRep; when a rep finishes its verdict is recorded (streak, points), shown as a banner and
 * the next rep (same situation, fresh seed) starts after a short beat or at once on confirm. The pause menu
 * resets the rep instantly, changes the drill, or ends the drill with its summary.
 */
import type { DrillRepDeps } from '@/game/practice/runner';
import { DrillSession, type RepRecord } from '@/game/practice/session';
import type { DrillDefinition, DrillOptions } from '@/game/practice/types';
import { BannerQueue, drawBanner } from '../game/banners';
import { renderThrowAim } from '../game/throw-aim-view';
import { ensureAiRegistered } from '../game/session-defaults';
import type { InputState } from '../input/types';
import { drawHintBar } from '../widgets/panel';
import { buildDrillHud, drawDrillHud, drillHints, fitHints, multiplierText } from './practice-hud';
import { PracticeSummaryScreen } from './practice-summary';
import { PracticePlayView } from './practice-view';
import type { RenderContext, Screen, ScreenServices } from './screen';
import { PromptScreen } from './watch';

/** Seconds the result of a rep stays up before the next rep starts on its own. */
export const RESULT_SECONDS = 1.6;

/** Navigation callbacks and test seams of the practice game screen. */
export interface PracticeGameOptions {
  /** Back to the drill picker. */
  onChangeDrill: () => void;
  /** Back to the main menu. */
  onQuit: () => void;
  /** Session seed (default: from the wall clock, so every session differs). */
  seed?: number;
  /** Engine / AI overrides for tests. */
  repDeps?: DrillRepDeps;
}

let seedCounter = 0;
const freshSeed = (): number => ((Date.now() & 0x7fffffff) ^ Math.imul(++seedCounter, 0x9e3779b1)) >>> 0;

/** Runs a drill session rep after rep on the live field (see the file header). */
export class PracticeGameScreen implements Screen {
  readonly id = 'practiceGame';
  readonly session: DrillSession;
  readonly view = new PracticePlayView();
  private readonly banners = new BannerQueue();
  private services: ScreenServices | null = null;
  private resultTimer = 0;
  private lastRecord: RepRecord | null = null;

  constructor(readonly def: DrillDefinition, readonly options: DrillOptions, private readonly opts: PracticeGameOptions) {
    if (!opts.repDeps?.ai) ensureAiRegistered();
    this.session = new DrillSession(def, options, opts.seed ?? freshSeed());
  }

  /** Banner queue (tests). */
  get bannerQueue(): BannerQueue {
    return this.banners;
  }

  /** True while the last rep's result is showing (between reps). */
  get showingResult(): boolean {
    return this.resultTimer > 0;
  }

  get lastResult(): RepRecord | null {
    return this.lastRecord;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.view.attach(services);
    if (!this.view.rep) this.nextRep();
  }

  exit(): void {
    this.services = null;
  }

  /** Starts the next attempt (same situation, new seed). Abandons a rep in progress without recording it. */
  nextRep(): void {
    this.resultTimer = 0;
    this.view.setRep(this.session.startRep(this.opts.repDeps));
  }

  /** Records a finished rep and shows its banner. */
  private finishRep(): void {
    const rep = this.view.rep;
    if (!rep?.verdict) return;
    const rec = this.session.record(rep.verdict, rep.scenario);
    this.lastRecord = rec;
    const v = rec.verdict;
    const sub = v.success ? `${v.detail}  +${rec.points}${rec.multiplier > 1 ? ` (${multiplierText(rec.multiplier)})` : ''}` : v.detail;
    this.banners.clear();
    this.banners.push({ text: v.headline, sub, tone: v.success ? 'good' : 'bad' }, RESULT_SECONDS);
    this.services?.audio?.onGameEvent({ type: v.success ? 'menuSelect' : 'menuMove' });
    this.resultTimer = RESULT_SECONDS;
  }

  /** Ends the drill: replaces this screen with the summary. */
  endDrill(): void {
    const services = this.services;
    if (!services) return;
    services.stack.replace(new PracticeSummaryScreen(this.session.summary(), {
      onAgain: () => services.stack.replace(new PracticeGameScreen(this.def, this.options, { ...this.opts, seed: undefined })),
      onChangeDrill: this.opts.onChangeDrill,
      onQuit: this.opts.onQuit,
    }));
  }

  openPause(services: ScreenServices): void {
    services.stack.push(new PromptScreen({
      title: 'PRACTICE',
      lines: [`${this.def.name}: ${this.session.reps} ${this.session.reps === 1 ? 'rep' : 'reps'}, ${this.session.totalPoints} ${this.session.totalPoints === 1 ? 'pt' : 'pts'}`],
      choices: [
        { id: 'resume', label: 'RESUME' },
        { id: 'reset', label: 'RESET REP', detail: 'Same look, new rep' },
        { id: 'end', label: 'END DRILL', detail: 'See your summary' },
        { id: 'change', label: 'CHANGE DRILL' },
        { id: 'quit', label: 'MAIN MENU' },
      ],
      backChoice: 'resume',
      onChoose: (id) => {
        if (id === 'reset') this.nextRep();
        else if (id === 'end') this.endDrill();
        else if (id === 'change') this.opts.onChangeDrill();
        else if (id === 'quit') this.opts.onQuit();
      },
    }));
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    this.services = services;
    if (input.justPressed.has('pause')) {
      this.openPause(services);
      return;
    }
    this.banners.update(dt);
    if (input.justPressed.has('cameraCycle')) this.view.cycleCamera();
    if (this.resultTimer > 0) {
      this.resultTimer -= dt;
      if (this.resultTimer <= 0 || input.justPressed.has('confirm')) this.nextRep();
    } else {
      this.view.step(input, services);
      if (this.view.rep?.finished) this.finishRep();
    }
    this.view.updateCamera(dt);
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const input = this.services?.input ?? null;
    this.view.render(rc, input);
    // The pull-back throw aim, as in a game and the tutorial (drawn here, not in the shared view, so the tutorial's own
    // call does not draw it twice).
    const rep = this.view.rep;
    renderThrowAim(ctx, rc.camera, theme, rep?.state ?? null, rep?.scenario.userSide ?? null);
    drawDrillHud(ctx, theme, buildDrillHud(this.session, this.lastRecord), width);
    drawBanner(ctx, theme, this.banners.current, width, height);
    if (input) {
      const hints = this.resultTimer > 0
        ? [{ glyph: input.glyph('confirm'), label: 'NEXT REP' }, { glyph: input.glyph('pause'), label: 'MENU' }]
        : drillHints(this.def, this.view.context(), (a) => input.glyph(a));
      drawHintBar(ctx, theme, fitHints(theme, hints, width), width, height - theme.pad - theme.glyphH - 4 * theme.textScale, 'right', { backdrop: true });
    }
  }
}
