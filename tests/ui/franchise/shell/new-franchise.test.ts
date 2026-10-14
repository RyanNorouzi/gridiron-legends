import { describe, expect, it } from 'vitest';
import { validateLeague } from '@/franchise/league';
import type { League } from '@/franchise/types';
import { createHeadlessServices } from '@/ui/franchise/context';
import { ChoiceDialog, TextEntryDialog } from '@/ui/franchise/kit/dialogs';
import { NewFranchiseScreen } from '@/ui/franchise/new-franchise';
import { colorChecks, cycleLogoSeed, cyclePalette, defaultDraft, draftErrors, draftToSpec, TEAM_PALETTE } from '@/ui/franchise/shell/custom-team';
import { CustomTeamScreen } from '@/ui/franchise/shell/custom-team-screen';
import {
  buildNewLeague, capForPreset, changeSetting, defaultNewLeagueChoice, settingsItems, settingsOverrides,
} from '@/ui/franchise/shell/league-setup-model';
import { TeamPickScreen } from '@/ui/franchise/shell/team-picker';
import { makeInput } from '../../render/fake-ctx';
import { rcFor } from './helpers';

describe('league setup model', () => {
  it('maps every wizard setting onto the created league', () => {
    let c = defaultNewLeagueChoice();
    c = changeSetting(c, 'difficulty', 1);
    c = changeSetting(c, 'ruleset', 1);
    c = changeSetting(c, 'quarter', 1);
    c = changeSetting(c, 'injuries', 1);
    c = changeSetting(c, 'weather', 1);
    c = changeSetting(c, 'cap', -1);
    expect(settingsItems(c).map((i) => i.id)).toEqual(['difficulty', 'ruleset', 'quarter', 'penalties', 'challenges', 'injuries', 'fatigue', 'weather', 'playoffs', 'cap']);
    const league = buildNewLeague({ seed: 5, choice: c, teamAbbr: 'NYC' });
    expect(validateLeague(league)).toEqual([]);
    expect(league.teams[league.userTeamId as never]?.abbr).toBe('NYC');
    const s = league.settings;
    expect(s.difficulty.id).toBe(c.difficulty);
    expect(s.ruleset.mode).toBe(c.ruleset);
    expect(s.ruleset.quarterLengthSec).toBe(c.quarterMinutes * 60);
    expect(s.injuriesEnabled).toBe(c.injuries);
    expect(s.ruleset.injuries).toBe(c.injuries);
    expect(s.weatherEnabled).toBe(c.weather);
    expect(s.salaryCap).toBe(capForPreset(c.cap));
    expect(settingsOverrides(c).salaryCap).toBeLessThan(capForPreset('standard'));
    expect(() => buildNewLeague({ seed: 5, choice: c })).toThrow(/choose a team/);
  });

  it('maps penalties, challenges and the playoff format onto the league', () => {
    let c = changeSetting(defaultNewLeagueChoice(), 'penalties', 1);
    c = changeSetting(c, 'challenges', 1);
    c = changeSetting(c, 'playoffs', 1);
    expect(c.playoffTeams).toBe(8);
    const league = buildNewLeague({ seed: 5, choice: c, teamAbbr: 'NYC' });
    expect(validateLeague(league)).toEqual([]);
    const s = league.settings;
    expect(s.ruleset.penalties).toBe(false);
    expect(s.ruleset.challenges).toBe(false);
    expect(s.playoff).toEqual({ teamsPerConference: 8, byesPerConference: 0, roundNames: ['Wild Card', 'Divisional', 'Conference Championship', 'Championship'] });
    const four = buildNewLeague({ seed: 5, choice: changeSetting(changeSetting(defaultNewLeagueChoice(), 'playoffs', -1), 'playoffs', -1), teamAbbr: 'NYC' });
    expect(four.settings.playoff.teamsPerConference).toBe(4);
    expect(four.settings.playoff.roundNames).toEqual(['Divisional', 'Conference Championship', 'Championship']);
    expect(validateLeague(four)).toEqual([]);
    // Switching the play style resets the switches to the new preset's defaults.
    const arcade = changeSetting(defaultNewLeagueChoice(), 'ruleset', 1);
    expect(arcade.ruleset).toBe('arcade');
    expect(settingsItems(arcade).find((i) => i.id === 'penalties')?.value).toBe(arcade.penalties ? 'On' : 'Off');
  });

  it('builds a valid league around a custom team with its colours and logo seed', () => {
    const base = buildNewLeague({ seed: 9, choice: defaultNewLeagueChoice(), teamAbbr: 'BOS' });
    const teams = Object.values(base.teams);
    const draft = { ...defaultDraft(teams), city: 'Harbor City', name: 'Gulls', abbr: 'HBG', logoSeed: 777, replaces: 'DEN' };
    expect(draftErrors(draft, teams)).toEqual([]);
    const league = buildNewLeague({ seed: 9, choice: defaultNewLeagueChoice(), custom: draft });
    expect(validateLeague(league)).toEqual([]);
    const mine = league.teams[league.userTeamId as never];
    expect(mine).toMatchObject({ city: 'Harbor City', name: 'Gulls', abbr: 'HBG', logoSeed: 777, isUserControlled: true });
    expect(mine?.colors.primary).toBe(draftToSpec(draft).colors?.primary);
    expect(Object.values(league.teams).some((t) => t.abbr === 'DEN')).toBe(false);
  });

  it('validates custom drafts and checks colours for every vision mode', () => {
    const teams = Object.values(buildNewLeague({ seed: 9, choice: defaultNewLeagueChoice(), teamAbbr: 'BOS' }).teams);
    const d = defaultDraft(teams);
    expect(draftErrors({ ...d, city: ' ' }, teams)).toContain('Enter a city');
    expect(draftErrors({ ...d, abbr: 'AB' }, teams)).toContain('The abbreviation needs 3 letters');
    expect(draftErrors({ ...d, abbr: 'NYC', replaces: 'BOS' }, teams).some((e) => e.includes('already used'))).toBe(true);
    expect(draftErrors({ ...d, abbr: 'BOS', replaces: 'BOS' }, teams)).toEqual([]);
    expect(draftErrors({ ...d, secondary: d.primary }, teams)).toContain('Pick two different colours');
    const similar = draftErrors({ ...d, primary: 'red', secondary: 'maroon' }, teams).concat(draftErrors({ ...d, primary: 'kelly', secondary: 'red' }, teams));
    expect(similar).toContain('Colours are hard to tell apart');
    expect(colorChecks(d).map((c) => c.mode)).toEqual(['none', 'protanopia', 'deuteranopia', 'tritanopia']);
    expect(colorChecks(d).every((c) => c.ok)).toBe(true);
    expect(cyclePalette(TEAM_PALETTE[TEAM_PALETTE.length - 1]?.id ?? '', 1)).toBe(TEAM_PALETTE[0]?.id);
    expect(cycleLogoSeed(9999, 1)).toBe(1);
    expect(cycleLogoSeed(1, -1)).toBe(9999);
  });
});

describe('NewFranchiseScreen', () => {
  const start = (mode: 'franchise' | 'season' = 'franchise'): { screen: NewFranchiseScreen; services: ReturnType<typeof createHeadlessServices>; created: { league: League; name: string | null }[] } => {
    const services = createHeadlessServices();
    const created: { league: League; name: string | null }[] = [];
    const screen = new NewFranchiseScreen({ mode, seed: () => 44, onCreate: (league, name) => created.push({ league, name }) });
    services.stack.push(screen);
    return { screen, services, created };
  };

  it('walks settings -> pick a team -> save name -> onCreate', () => {
    const { screen, services, created } = start();
    screen.list.select(screen.list.items.findIndex((i) => i.id === 'difficulty'));
    services.stack.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
    expect(screen.choice.difficulty).not.toBe(defaultNewLeagueChoice().difficulty);
    screen.list.select(screen.list.items.findIndex((i) => i.id === 'next'));
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    const dialog = services.stack.top as ChoiceDialog;
    expect(dialog).toBeInstanceOf(ChoiceDialog);
    dialog.choose('pick');
    const picker = services.stack.top as TeamPickScreen;
    expect(picker).toBeInstanceOf(TeamPickScreen);
    expect(picker.table.rows).toHaveLength(32);
    picker.render(rcFor(services));
    const team = picker.table.selected?.team;
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    const naming = services.stack.top as TextEntryDialog;
    expect(naming).toBeInstanceOf(TextEntryDialog);
    expect(naming.model.text).toBe(`${team?.city} ${team?.name}`.slice(0, 24));
    naming.submit();
    expect(created).toHaveLength(1);
    const { league, name } = created[0] as { league: League; name: string | null };
    expect(name).toBe(naming.model.result());
    expect(league.teams[league.userTeamId as never]?.abbr).toBe(team?.abbr);
    expect(league.settings.difficulty.id).toBe(screen.choice.difficulty);
    expect(Object.values(league.teams).find((t) => t.abbr === team?.abbr)?.overall).toBe(team?.overall);
  });

  it('creates a custom team in season mode without a save name', () => {
    const { screen, services, created } = start('season');
    const editor = screen.openCustom();
    expect(services.stack.top).toBe(editor);
    editor.setText('city', 'Lakeside');
    editor.setText('name', 'Herons');
    editor.setText('abbr', 'lkh');
    editor.change('primary', 1);
    editor.change('logo', 3);
    editor.render(rcFor(services));
    expect(editor.errors).toEqual([]);
    expect(editor.create()).toBe(true);
    expect(created).toHaveLength(1);
    const { league, name } = created[0] as { league: League; name: string | null };
    expect(name).toBeNull();
    expect(league.teams[league.userTeamId as never]).toMatchObject({ city: 'Lakeside', name: 'Herons', abbr: 'LKH', logoSeed: editor.draft.logoSeed });
    expect(services.stack.top).toBe(screen);
  });

  it('refuses an invalid custom team and renders in large text', () => {
    const services = createHeadlessServices({ textSize: 'large' });
    const editor = new CustomTeamScreen({ teams: new NewFranchiseScreen({ onCreate: () => undefined, seed: () => 3 }).previewTeams(), onCreate: () => { throw new Error('should not create'); } });
    services.stack.push(editor);
    editor.setText('abbr', 'X');
    expect(editor.create()).toBe(false);
    expect(editor.list.items.find((i) => i.id === 'create')?.disabled).toBe(true);
    const rc = rcFor(services);
    editor.render(rc);
    expect(rc.ctx.fills.length).toBeGreaterThan(50);
  });
});
