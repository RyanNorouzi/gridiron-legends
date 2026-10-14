import { describe, expect, it } from 'vitest';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { createHeadlessServices } from '@/ui/franchise/context';
import { FranchiseHubScreen } from '@/ui/franchise/hub';
import { ChoiceDialog } from '@/ui/franchise/kit/dialogs';
import { SimProgressScreen } from '@/ui/franchise/shell/progress-screen';
import { leagueAt, tickUntil } from './helpers';

describe('Sim through offseason (roster moves automated)', () => {
  it('runs every offseason phase into the next preseason without stopping on roster issues', () => {
    const services = createHeadlessServices();
    const hub = new FranchiseHubScreen({ league: leagueAt(11, 'awards', 'SEA'), onExit: () => undefined, simulator: fallbackSimulator });
    services.stack.push(hub);
    const option = hub.advanceOptions().find((o) => o.id === 'simTo:preseason');
    expect(option?.action).toMatchObject({ kind: 'sim', autoFix: true });
    hub.runAdvance(option!.action);
    tickUntil(services.stack, () => !services.stack.all.some((s) => s instanceof SimProgressScreen), 40000);
    expect(services.stack.all.some((s) => s instanceof ChoiceDialog && s.title === 'Roster issues')).toBe(false);
    expect(hub.league.season.phase).toBe('preseason');
    const team = hub.league.teams[hub.league.userTeamId!]!;
    expect(team.rosterIds.length).toBeGreaterThanOrEqual(hub.league.settings.rosterSize);
  }, 120000);
});
