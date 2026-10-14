/**
 * Install hub of the world-layer art (art bible §16.9). Each art chain adds ONE import line here for its installer
 * module (a module that registers painters, look overrides, world passes or sorted objects when it loads); the scene
 * compositor imports this file once, so everything is registered before the first world frame. Append-only; the
 * integration owner reconciles concurrent additions.
 */
import './world/install';
import './figures/contact-install';
import './figures/install';
export {};
