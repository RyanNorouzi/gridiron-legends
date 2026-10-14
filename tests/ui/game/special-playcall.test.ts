import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { OffensivePlay } from '@/playbook/types';
import { createDefaultPlaycaller } from '@/ui/game/playcaller';
import { buildPlaycallRequest, playFitsSituation } from '@/ui/game/session-flow';
import { OFFENSE_PLAYS, situation } from '../../game/fixtures';
import { autoplay, makeSession } from './fixtures';

const base = OFFENSE_PLAYS.find((p) => p.id === 'pass-curl') as OffensivePlay;
const twoPt: OffensivePlay = { ...base, id: 'two-pt-fade', tags: ['twoPoint'] };

describe('special-teams play calls', () => {
  it('GO FOR TWO lists the two-point plays during a PAT (H2-02)', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 } });
    const setup = { ...f.setup, home: { ...f.setup.home, offensePlays: [...OFFENSE_PLAYS, twoPt] } };
    const st = situation(setup, { possession: 'home', patPending: 'home', ballOn: 98 });
    const req = buildPlaycallRequest(st, setup, 'home', createDefaultPlaycaller(), f.session.registry, createRng(1));
    expect(req.special.map((o) => o.id)).toContain('twoPoint');
    expect(req.offensePlays.map((p) => p.id)).toEqual(['two-pt-fade']);
    const scrimmage = buildPlaycallRequest({ ...st, patPending: null, ballOn: 40 }, setup, 'home', createDefaultPlaycaller(), f.session.registry, createRng(1));
    expect(scrimmage.offensePlays.map((p) => p.id)).not.toContain('two-pt-fade');
  });

  it('the kickoff play call offers only the kick units, never scrimmage plays (H2-03)', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 } });
    const st = situation(f.setup, { possession: 'home', kickoffPending: 'home', ballOn: 35 });
    const req = buildPlaycallRequest(st, f.setup, 'home', createDefaultPlaycaller(), f.session.registry, createRng(1));
    expect(req.offensePlays).toEqual([]);
    expect(req.special.map((o) => o.id)).toContain('kickoff');
    expect(playFitsSituation(st, base)).toBe(false);
    expect(playFitsSituation(st, OFFENSE_PLAYS.find((p) => p.id === 'kickoff') as OffensivePlay)).toBe(true);
    expect(playFitsSituation({ ...st, kickoffPending: null }, base)).toBe(true);
    expect(playFitsSituation({ ...st, kickoffPending: null }, OFFENSE_PLAYS.find((p) => p.id === 'xp') as OffensivePlay)).toBe(false);
  });

  it('a scrimmage play called on a kickoff still kicks off (the session falls back to the kick unit)', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 } });
    autoplay(f.session, { until: (x) => x.stage.kind === 'playcall' && x.stage.request.unit === 'offense' && x.stage.request.situation.kind === 'kickoff', coinToss: 'kick' });
    f.session.callPlay({ offensivePlayId: 'pass-curl' });
    const last = f.session.state.playLog.at(-1);
    const live = f.session.stage;
    const special = live.kind === 'live' ? live.meta.ctx.special : last?.outcome.result;
    expect(['kickoff', 'onside']).toContain(special);
  });
});
