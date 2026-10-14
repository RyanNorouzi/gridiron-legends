/**
 * A timeout called from the play-call screen is confirmed ON TOP of it: the TIMEOUT banner is drawn under the panel,
 * so the play call shows "TIMEOUT · ATL · 2 LEFT" as a toast instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { timeoutNotice } from '@/ui/game/banners';
import { PlayCallScreen } from '@/ui/screens/playcall';
import { makeInput } from '../render/fake-ctx';
import { autoplay, makeSession, makeUi } from './fixtures';

describe('timeout confirmation on the play call', () => {
  it('toasts the timeout (team and timeouts left) when one is called, and says so when none is available', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense' && s.stage.request.situation.kind === 'scrimmage', coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    const ui = makeUi();
    const toast = vi.fn();
    const services = { ...ui.services, toast };
    const side = stage.request.side;
    const before = f.session.state.timeouts[side];
    const screen = new PlayCallScreen(stage.request, f.session.registry, {
      onCall: () => undefined,
      onTimeout: () => f.session.callTimeout() && timeoutNotice(f.session.setup, side, f.session.state.timeouts[side]),
    });
    ui.stack.push(screen);
    screen.update(1 / 60, makeInput({ pressed: ['callTimeout'] }), services);
    expect(f.session.state.timeouts[side]).toBe(before - 1);
    expect(toast).toHaveBeenCalledWith(`TIMEOUT · ${f.session.setup[side].team.abbr} · ${before - 1} LEFT`, expect.any(Number));
    const none = new PlayCallScreen(stage.request, f.session.registry, { onCall: () => undefined, onTimeout: () => false });
    none.update(1 / 60, makeInput({ pressed: ['callTimeout'] }), services);
    expect(toast).toHaveBeenLastCalledWith('No timeout available');
  });
});
