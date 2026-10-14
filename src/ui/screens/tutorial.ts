/**
 * Tutorial screen: walks the TutorialMachine. Interactive steps run their drill scenario on the live practice
 * view; a StepTracker condenses each tick and the step finishes when goals.ts says the player did the thing (a
 * wrong action or a dead play restarts the attempt with a hint). Info steps show illustrated pages. Every prompt
 * is formatted with the player's current button glyphs. Progress is reported per step; finishing or skipping the
 * tutorial marks it completed (Settings.tutorialCompleted) and returns to the menu.
 */
import { DEFAULT_DRILL_OPTIONS } from '@/game/practice/drills';
import { DrillRep, type DrillRepDeps } from '@/game/practice/runner';
import { buildDrillScenario } from '@/game/practice/scenarios';
import { repSeed } from '@/game/practice/session';
import { BannerQueue, drawBanner } from '../game/banners';
import { ensureAiRegistered } from '../game/session-defaults';
import { renderThrowAim } from '../game/throw-aim-view';
import type { InputManager, InputState } from '../input/types';
import { drawText, wrapText } from '../render/text';
import { goalStatus, StepTracker, type GoalStatus, type StepObservation } from '../tutorial/goals';
import { drawIllustration } from '../tutorial/illustrations';
import { TutorialMachine, type MachineChange } from '../tutorial/machine';
import { resumeIndex, type TutorialProgressSink } from '../tutorial/progress';
import { formatPrompt } from '../tutorial/prompts';
import { TUTORIAL_STEPS, type InteractiveStep, type TutorialStep } from '../tutorial/steps';
import { drawHintBar, drawPanel, type ButtonHint } from '../widgets/panel';
import { drawBackdrop } from './main-menu';
import { fitHints } from './practice-hud';
import { PracticePlayView } from './practice-view';
import type { RenderContext, Screen, ScreenServices } from './screen';
import { PromptScreen } from './watch';

/** Seconds the success / retry banner holds before the tutorial moves on or restarts the attempt. */
export const FEEDBACK_SECONDS = 1.4;

/** Navigation, progress sink and test seams of the tutorial screen. */
export interface TutorialScreenOptions {
  /** Back to the main menu (after finishing, skipping or quitting). */
  onExit: () => void;
  steps?: readonly TutorialStep[];
  /** Where progress goes (the app's TutorialProgressController); null = not persisted. */
  progress?: TutorialProgressSink | null;
  /** Engine / AI overrides for tests. */
  repDeps?: DrillRepDeps;
  /** Seed of the drill reps (default 1). */
  seed?: number;
}

interface Feedback {
  status: Exclude<GoalStatus, 'pending'>;
  remaining: number;
}

/** Step-driven interactive tutorial (see the file header). */
export class TutorialScreen implements Screen {
  readonly id = 'tutorial';
  readonly machine: TutorialMachine;
  readonly view = new PracticePlayView();
  private readonly banners = new BannerQueue();
  private services: ScreenServices | null = null;
  private tracker: StepTracker | null = null;
  private observation: StepObservation | null = null;
  private feedback: Feedback | null = null;
  private attempt = 0;
  private exited = false;

  constructor(private readonly opts: TutorialScreenOptions) {
    if (!opts.repDeps?.ai) ensureAiRegistered();
    const steps = opts.steps ?? TUTORIAL_STEPS;
    const saved = opts.progress?.progress ?? null;
    this.machine = new TutorialMachine(steps, { startIndex: resumeIndex(steps.map((s) => s.id), saved), completed: saved?.completedSteps ?? [] });
    this.machine.onChange((c) => this.onMachine(c));
  }

  /** The step on screen (null once finished). */
  get step(): TutorialStep | null {
    return this.machine.step;
  }

  /** Latest observation of the running attempt (tests / debug). */
  get lastObservation(): StepObservation | null {
    return this.observation;
  }

  /** True while the success / retry banner holds the step. */
  get holding(): boolean {
    return this.feedback !== null;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.view.attach(services);
    this.startAttempt();
  }

  exit(): void {
    this.services = null;
  }

  private get glyphs(): Pick<InputManager, 'glyph' | 'state'> | null {
    return this.services?.input ?? null;
  }

  /** The current instructions / page lines with the player's glyphs substituted. */
  instructionLines(): string[] {
    const step = this.machine.step;
    const g = this.glyphs;
    if (!step || !g) return [];
    const lines = step.kind === 'interactive' ? step.lines : (step.pages[this.machine.page]?.lines ?? []);
    return lines.map((l) => formatPrompt(l, g));
  }

  /** Starts (or restarts) the current step's attempt; info steps clear the field. */
  private startAttempt(): void {
    this.feedback = null;
    this.observation = null;
    const step = this.machine.step;
    if (!step || step.kind !== 'interactive') {
      this.tracker = null;
      this.view.setRep(null);
      return;
    }
    const scenario = buildDrillScenario(step.drill, { ...DEFAULT_DRILL_OPTIONS, difficulty: step.difficulty }, repSeed(this.opts.seed ?? 1, this.attempt), this.attempt);
    this.attempt += 1;
    const rep = new DrillRep(scenario, this.opts.repDeps ?? {});
    this.view.setRep(rep);
    this.tracker = new StepTracker(scenario.userSide, rep.focusId);
  }

  private onMachine(c: MachineChange): void {
    switch (c.type) {
      case 'stepDone':
        if (!c.skipped) this.opts.progress?.markStep(c.step.id);
        break;
      case 'step':
      case 'retry':
        this.startAttempt();
        break;
      case 'finished':
        this.view.setRep(null);
        this.opts.progress?.complete(c.status === 'skipped');
        this.services?.toast(c.status === 'skipped' ? 'Tutorial skipped - find it again in the main menu' : 'Tutorial complete!');
        this.leave();
        break;
      default:
        break;
    }
  }

  private leave(): void {
    if (this.exited) return;
    this.exited = true;
    this.opts.onExit();
  }

  openPause(services: ScreenServices): void {
    services.stack.push(new PromptScreen({
      title: 'TUTORIAL',
      lines: [`Step ${this.machine.index + 1} of ${this.machine.total}`],
      choices: [
        { id: 'resume', label: 'RESUME' },
        { id: 'skip', label: 'SKIP STEP' },
        { id: 'restart', label: 'RESTART STEP' },
        { id: 'skipAll', label: 'SKIP TUTORIAL', detail: 'Mark it done' },
        { id: 'quit', label: 'QUIT', detail: 'Progress is saved' },
      ],
      backChoice: 'resume',
      onChoose: (id) => {
        if (id === 'skip') this.machine.skipStep();
        else if (id === 'restart') this.machine.restartStep();
        else if (id === 'skipAll') this.machine.skipAll();
        else if (id === 'quit') this.leave();
      },
    }));
  }

  private tickInteractive(step: InteractiveStep, input: InputState, services: ScreenServices): void {
    const rep = this.view.rep;
    const tracker = this.tracker;
    if (!rep || !tracker) return;
    this.view.step(input, services);
    const obs = tracker.observe(rep.state, rep.finished || rep.state.phase === 'dead');
    this.observation = obs;
    const status = goalStatus(step.goal, obs);
    if (status === 'pending') return;
    const g = this.glyphs;
    const text = status === 'done' ? step.success : step.retry;
    this.banners.clear();
    this.banners.push({ text: status === 'done' ? 'NICE!' : 'TRY AGAIN', sub: g ? formatPrompt(text, g) : text, tone: status === 'done' ? 'good' : 'bad' }, FEEDBACK_SECONDS);
    services.audio?.onGameEvent({ type: status === 'done' ? 'menuSelect' : 'menuMove' });
    this.feedback = { status, remaining: FEEDBACK_SECONDS };
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    this.services = services;
    if (input.justPressed.has('pause')) {
      this.openPause(services);
      return;
    }
    this.banners.update(dt);
    const step = this.machine.step;
    if (!step) return;
    if (this.feedback) {
      // The play keeps running under the banner; only the verdict is already in.
      if (step.kind === 'interactive') this.view.step(input, services);
      this.feedback.remaining -= dt;
      if (this.feedback.remaining <= 0) {
        const status = this.feedback.status;
        this.feedback = null;
        this.machine.report(status);
      }
      this.view.updateCamera(dt);
      return;
    }
    if (step.kind === 'info') {
      const p = input.justPressed;
      if (p.has('confirm')) this.machine.nextPage();
      else if (p.has('back') || p.has('menuLeft')) this.machine.prevPage();
      else if (p.has('menuRight')) this.machine.nextPage();
      return;
    }
    this.tickInteractive(step, input, services);
    this.view.updateCamera(dt);
  }

  private renderHeader(rc: RenderContext, step: TutorialStep, lines: string[]): void {
    const { ctx, theme, width, height } = rc;
    const s = theme.textScale;
    const lineH = theme.glyphH + theme.gap;
    const panelW = width - theme.pad * 2;
    // At most half the screen: large text wraps a lot, and the play has to stay visible.
    const maxRows = Math.max(1, Math.floor((height * 0.5 - theme.border * 2 - theme.gap * 2) / lineH) - 1);
    const wrapped = lines.flatMap((l) => wrapText(l, panelW - theme.pad * 2, s)).slice(0, maxRows);
    const h = theme.border * 2 + theme.gap * 2 + lineH * (wrapped.length + 1);
    const content = drawPanel(ctx, theme, theme.pad, theme.pad, panelW, h, { style: 'solid', alpha: 0.88 });
    drawText(ctx, `${this.machine.index + 1}/${this.machine.total}  ${step.title}`, content.x, content.y, { color: theme.colors.accent, size: s, shadow: theme.colors.shadow });
    wrapped.forEach((l, i) => drawText(ctx, l, content.x, content.y + lineH * (i + 1), { color: theme.colors.text, size: s }));
  }

  private renderInfo(rc: RenderContext, step: Extract<TutorialStep, { kind: 'info' }>, lines: string[]): void {
    const { ctx, theme, width, height } = rc;
    const s = theme.textScale;
    const page = step.pages[this.machine.page];
    if (!page) return;
    drawBackdrop(ctx, theme, width, height, rc.time);
    const hintH = theme.glyphH + 4 * s + theme.pad;
    const content = drawPanel(ctx, theme, theme.pad, theme.pad, width - theme.pad * 2, height - hintH - theme.pad * 2, { style: 'raised', title: `${this.machine.index + 1}/${this.machine.total}  ${step.title}` });
    const lineH = theme.glyphH + theme.gap;
    const bottom = content.y + content.h - (step.pages.length > 1 ? lineH : 0);
    drawText(ctx, page.heading, content.x, content.y, { color: theme.colors.accent, size: s, shadow: theme.colors.shadow });
    // Normal text: the illustration sits beside the text. Large text: full-width text, the picture below if it fits.
    const beside = page.art !== undefined && s === 1;
    const textW = beside ? Math.round(content.w * 0.52) : content.w;
    let y = content.y + lineH + theme.gap;
    for (const l of lines.flatMap((x) => wrapText(x, textW, s))) {
      if (y + theme.glyphH > bottom) break;
      drawText(ctx, l, content.x, y, { color: theme.colors.text, size: s });
      y += lineH;
    }
    if (page.art && beside) {
      const ax = content.x + textW + theme.pad;
      const aw = content.x + content.w - ax;
      drawIllustration(ctx, theme, page.art, { x: ax, y: content.y + lineH, w: aw, h: Math.min(bottom - content.y - lineH, Math.round(aw * 0.75)) }, rc.time);
    } else if (page.art && bottom - y - theme.gap >= 40) {
      const ah = bottom - y - theme.gap;
      const aw = Math.min(content.w, Math.round(ah * 1.6));
      drawIllustration(ctx, theme, page.art, { x: content.x + Math.round((content.w - aw) / 2), y: y + theme.gap, w: aw, h: ah }, rc.time);
    }
    if (step.pages.length > 1) drawText(ctx, `PAGE ${this.machine.page + 1}/${step.pages.length}`, content.x + content.w, content.y + content.h - theme.glyphH, { color: theme.colors.textDim, size: s, align: 'right' });
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const step = this.machine.step;
    const input = this.services?.input ?? null;
    if (!step) {
      drawBackdrop(ctx, theme, width, height, rc.time);
      return;
    }
    const lines = this.instructionLines();
    if (step.kind === 'info') this.renderInfo(rc, step, lines);
    else {
      this.view.render(rc, input);
      const rep = this.view.rep;
      renderThrowAim(ctx, rc.camera, theme, rep?.state ?? null, rep?.scenario.userSide ?? null);
      this.renderHeader(rc, step, lines);
    }
    drawBanner(ctx, theme, this.banners.current, width, height);
    if (!input) return;
    const hints: ButtonHint[] = step.kind === 'info'
      ? [{ glyph: input.glyph('confirm'), label: 'NEXT' }, { glyph: input.glyph('back'), label: 'BACK' }, { glyph: input.glyph('pause'), label: 'SKIP / MENU' }]
      : [{ glyph: input.glyph('pause'), label: 'SKIP / MENU' }];
    drawHintBar(ctx, theme, fitHints(theme, hints, width), width, height - theme.pad - theme.glyphH - 4 * theme.textScale, 'right', { backdrop: true });
  }
}
