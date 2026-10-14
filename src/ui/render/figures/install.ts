/**
 * Chain A installer (art bible §16.9): registers the figure poses (core, QB, catch / kick, celebrations, and the
 * contact defaults chain B's poses replace) and the figure painter as the FALLBACK painter (every clip; the legacy
 * placeholder then never installs), so chain B's line / tackle clips are painted by the same rig with their
 * registered poses (a chain registering a specific painter for some clips still wins for those); and the core look cues
 * (look-core.ts). Idempotent; imported once from world-layer-install.ts.
 */
import { registerPainter } from '../anim';
import { installCorePoses } from './anims-core';
import { installQbPoses } from './anims-qb';
import { installCatchKickPoses } from './anims-catch-kick';
import { installCelebratePoses } from './anims-celebrate';
import { installContactDefaults } from './anims-contact-defaults';
import { installCoreCues } from './look-core';
import { createFigurePainter } from './painter';

let posesDone = false;
let painterDone = false;

/** Registers every chain A pose (idempotent). */
export const installFigurePoses = (): void => {
  if (posesDone) return;
  posesDone = true;
  installCorePoses();
  installQbPoses();
  installCatchKickPoses();
  installCelebratePoses();
  installContactDefaults();
};

/** The shared figure painter. */
export const FIGURE_PAINTER = createFigurePainter();

/** Registers the poses and the figure painter (idempotent). */
export const installFigures = (): void => {
  installFigurePoses();
  installCoreCues();
  if (painterDone) return;
  painterDone = true;
  registerPainter(FIGURE_PAINTER);
};

installFigures();
