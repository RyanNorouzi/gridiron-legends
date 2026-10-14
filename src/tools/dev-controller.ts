/**
 * Headless developer-mode controller used by the Game screen and the dev console. It owns the DevState, the one
 * DevHooks object every live engine of the session shares (flags are synced into it, commands are queued into its
 * inbox and applied by the engine at the start of its next tick) and the fast-sim-the-drive driver, which works only
 * through the public GameSession API. Construct it only when isDevModeEnabled() says so; a disabled controller
 * ignores every request.
 */
import type { Vec2 } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { DevCommand, DevHooks } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import type { GameState, TeamSide } from '@/game/types';
import type { GameSession, PlayCall, PlaycallRequest } from '@/ui/game/session-types';
import {
  createDevState, cycleOverlays, setCheat, setDevEnabled, syncHooks, toggleCheat, toggleOverlay, type CheatKey, type DevState, type OverlayKind,
} from './dev-state';

/** The part of a GameSession the fast-sim driver needs. */
export type FastSimSession = Pick<GameSession, 'stage' | 'state' | 'skipPlay' | 'callPlay' | 'continue'>;

/** Result of one fast-sim step: cheat off, acted on the session, waiting for the user, or drive over. */
export type FastSimStep = 'off' | 'acted' | 'waiting' | 'done';

/** Identity of the drive in progress (a new drive gets a new key). */
export const driveKey = (s: Readonly<GameState>): string =>
  `${s.drive.possession}:${s.drive.startQuarter}:${s.drive.startClock}:${s.drive.startBallOn}`;

/** A play call that keeps the game moving: kicks when kicking, a punt / field goal on 4th down, else the suggestion. */
export const autoCall = (req: PlaycallRequest): PlayCall | null => {
  if (req.unit === 'defense') {
    const id = req.suggestion && req.defensePlays.some((p) => p.id === req.suggestion) ? req.suggestion : req.defensePlays[0]?.id;
    return id ? { defensivePlayId: id } : null;
  }
  const special = (id: string): string | null => req.special.find((o) => o.id === id)?.playId ?? null;
  const kind = req.situation.kind;
  const kick = kind === 'kickoff' ? special('kickoff') : kind === 'pat' ? special('extraPoint')
    : req.situation.down === 4 ? (req.situation.ballOn >= 65 ? special('fieldGoal') : null) ?? special('punt') : null;
  const id = kick ?? (req.suggestion && req.offensePlays.some((p) => p.id === req.suggestion) ? req.suggestion : req.offensePlays[0]?.id);
  return id ? { offensivePlayId: id } : null;
};

/** Developer-mode state, shared engine hooks, command queue and fast-sim driver for one game screen. */
export class DevController {
  private value: DevState;
  /** Shared with every engine the session creates (LivePlayOptions.dev). */
  readonly hooks: DevHooks = { commands: [] };
  private side: TeamSide | null = null;
  private drive: string | null = null;
  /** Recent actions, newest last (console status line). */
  readonly log: string[] = [];

  constructor(enabled = true) {
    this.value = createDevState(enabled);
    syncHooks(this.hooks, this.value, this.side);
  }

  /** Current overlays and cheats. */
  get state(): DevState {
    return this.value;
  }

  /** False once developer mode was switched off. */
  get enabled(): boolean {
    return this.value.enabled;
  }

  /** Commands queued for the engine and not yet picked up by a tick. */
  get pendingCommands(): readonly DevCommand[] {
    return this.hooks.commands ?? [];
  }

  private set(next: DevState): void {
    this.value = next;
    syncHooks(this.hooks, next, this.side);
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 8) this.log.shift();
  }

  /** The team the cheats favour (the user's side); null lets the engine fall back to the human side. */
  setFavouredSide(side: TeamSide | null): void {
    if (side === this.side) return;
    this.side = side;
    syncHooks(this.hooks, this.value, side);
  }

  /** Flips one overlay. */
  toggleOverlay(kind: OverlayKind): void {
    this.set(toggleOverlay(this.value, kind));
  }

  /** Next overlay preset (devOverlayCycle). */
  cycleOverlays(): void {
    this.set(cycleOverlays(this.value));
  }

  /** Toggles a cheat; fast sim needs the session to know which drive to finish. */
  toggleCheat(key: CheatKey, session?: FastSimSession): void {
    if (key === 'fastSim' && !this.value.cheats.fastSim) {
      if (!session) return;
      this.drive = driveKey(session.state);
    }
    this.set(toggleCheat(this.value, key));
    if (key === 'fastSim' && !this.value.cheats.fastSim) this.drive = null;
  }

  /** Developer mode switched off: every flag, overlay and queued command is dropped. */
  disable(): void {
    this.drive = null;
    this.set(setDevEnabled(this.value, false));
  }

  /**
   * Queues an engine command (applied at the start of the next engine tick). With `play`, the command is bound to
   * that play: an engine running a later play discards it. False when dev mode is off.
   */
  queue(cmd: DevCommand, play?: PlayState): boolean {
    if (!this.enabled) return false;
    const inbox = (this.hooks.commands ??= []);
    const playIndex = play ? play.ctx.playIndex : null;
    // Commands still waiting from another play are stale: the inbox only ever holds one play's commands.
    if (inbox.length > 0 && this.hooks.commandPlayIndex !== playIndex) inbox.length = 0;
    this.hooks.commandPlayIndex = playIndex;
    inbox.push(cmd);
    this.note(cmd.type);
    return true;
  }

  /* --------------------------------- command helpers --------------------------------- */

  /** Athlete the local user controls (the favoured side's first, else the viewer's). */
  controlledOf(play: PlayState): Athlete | null {
    const id = (this.side ? play.controlledIds[this.side] : undefined) ?? play.controlledId;
    return findAthlete(play, id ?? null);
  }

  private commandable(play: PlayState | null): play is PlayState {
    return this.enabled && play !== null && play.phase !== 'dead';
  }

  /** Teleports the controlled athlete to a world point. */
  teleportControlled(play: PlayState | null, pos: Vec2 | null): boolean {
    if (!this.commandable(play) || !pos) return false;
    const a = this.controlledOf(play);
    return a ? this.queue({ type: 'teleport', athleteId: a.id, pos: { x: pos.x, y: pos.y } }, play) : false;
  }

  /** A yard behind the line on his own side of the ball (the offense's backfield or the defense's front). */
  teleportControlledToLos(play: PlayState | null): boolean {
    if (!this.commandable(play)) return false;
    const a = this.controlledOf(play);
    if (!a) return false;
    const back = a.side === 'offense' ? -play.ctx.direction : play.ctx.direction;
    return this.queue({ type: 'teleport', athleteId: a.id, pos: { x: play.snapX, y: play.losY + back } }, play);
  }

  /** Puts the ball in the controlled athlete's hands. */
  spawnBallAtControlled(play: PlayState | null): boolean {
    if (!this.commandable(play)) return false;
    const a = this.controlledOf(play);
    return a ? this.queue({ type: 'spawnBall', mode: 'toAthlete', athleteId: a.id }, play) : false;
  }

  /** Forces a touchdown for the favoured side (the offense when nobody is favoured). */
  forceTouchdown(play: PlayState | null): boolean {
    if (!this.commandable(play)) return false;
    return this.queue({ type: 'forceTouchdown', side: this.side ?? play.ctx.offense }, play);
  }

  /** The carrier fumbles to the nearest opponent (a pass in the air is intercepted). */
  forceTurnover(play: PlayState | null): boolean {
    return this.commandable(play) ? this.queue({ type: 'forceTurnover' }, play) : false;
  }

  /* ------------------------------------ fast sim ------------------------------------ */

  /**
   * One frame of fast sim: steps until one play has been simulated (its post-play card is up), the session needs the
   * user (a prompt, an intermission) or the drive is over, so a play-call stage never reaches the screen while the
   * cheat is on and the score visibly ticks over play by play. Returns the last step.
   */
  runFastSim(session: FastSimSession, maxSteps = 8): FastSimStep {
    let step: FastSimStep = 'off';
    for (let i = 0; i < maxSteps; i++) {
      step = this.stepFastSim(session);
      if (step !== 'acted' || session.stage.kind === 'postPlay') break;
    }
    return step;
  }

  /**
   * One frame of the fast-sim cheat: while the drive it was switched on in lasts, live plays are fast-simmed, play
   * calls are answered automatically (and simulated) and post-play cards are skipped. Prompts that need a real
   * decision (coin toss, penalties, free kicks) and intermissions are left to the user. The cheat switches itself
   * off when the drive ends.
   */
  stepFastSim(session: FastSimSession): FastSimStep {
    if (!this.enabled || !this.value.cheats.fastSim) return 'off';
    const s = session.state;
    if (s.phase === 'final' || s.drive.result !== null || driveKey(s) !== this.drive) {
      this.set(setCheat(this.value, 'fastSim', false));
      this.drive = null;
      this.note('fast sim: drive over');
      return 'done';
    }
    const stage = session.stage;
    switch (stage.kind) {
      case 'live':
      case 'watchPrompt':
        session.skipPlay();
        return 'acted';
      case 'playcall': {
        const call = autoCall(stage.request);
        if (!call) return 'waiting';
        session.skipPlay();
        session.callPlay(call);
        return 'acted';
      }
      case 'postPlay':
        session.continue();
        return 'acted';
      default:
        return 'waiting';
    }
  }
}
