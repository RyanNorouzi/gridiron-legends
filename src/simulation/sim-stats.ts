import type { PlayerId } from '@/core/ids';
import { delta } from '@/statistics/apply';
import type { PlayStatDelta } from '@/statistics/types';
import type { Matchups, RatedPlayer } from './matchups';
import type { FumbleInfo, PassResolution, RunResolution, TackleInfo } from './play-model';

/**
 * Stat deltas for the statistical executor, mirroring what the live engine's outcome builder credits so box
 * scores from simulated and played games are indistinguishable.
 */
export interface PlayBits {
  firstDown: boolean;
  bigPlay: boolean;
  success: boolean;
  epa: number;
}

const id = (p: RatedPlayer): PlayerId => p.player.id;

/** Snap counts and unit snaps (pass rush / coverage / blocking) for everyone on the field. */
export const participationDeltas = (m: Matchups, passPlay: boolean): PlayStatDelta[] => {
  const out: PlayStatDelta[] = [];
  for (const p of m.offense) {
    out.push(delta(id(p), 'snaps'));
    if (m.blockers.includes(p)) out.push(delta(id(p), 'blocking.snaps'));
  }
  for (const d of m.defense) {
    out.push(delta(id(d), 'snaps'));
    if (passPlay && m.rushers.includes(d)) out.push(delta(id(d), 'defense.passRushSnaps'));
    if (passPlay && m.coverageDefenders.includes(d)) out.push(delta(id(d), 'defense.coverageSnaps'));
  }
  return out;
};

/** Tackle credit: solo or with assists; missed tackles for the defenders the runner shook. */
export const tackleDeltas = (t: TackleInfo, yards: number): PlayStatDelta[] => {
  const out: PlayStatDelta[] = [delta(id(t.tackler), 'defense.tackles')];
  if (t.assists.length === 0) out.push(delta(id(t.tackler), 'defense.soloTackles'));
  for (const a of t.assists) { out.push(delta(id(a), 'defense.tackles')); out.push(delta(id(a), 'defense.assists')); }
  if (yards < 0) out.push(delta(id(t.tackler), 'defense.tfl'));
  if (t.kind === 'hitStick') out.push(delta(id(t.tackler), 'defense.hitSticks'));
  for (const m of t.missed) out.push(delta(id(m), 'defense.missedTackles'));
  return out;
};

/** Fumble bookkeeping for the carrier, the forcer and the recoverer. */
export const fumbleDeltas = (fu: FumbleInfo, carrier: RatedPlayer, rushing: boolean): PlayStatDelta[] => {
  const out: PlayStatDelta[] = [delta(id(carrier), 'fumbles')];
  if (rushing) out.push(delta(id(carrier), 'rushing.fumbles'));
  if (fu.lost) out.push(delta(id(carrier), 'fumblesLost'));
  if (fu.forcedBy && fu.lost) out.push(delta(id(fu.forcedBy), 'defense.forcedFumbles'));
  if (fu.lost) {
    out.push(delta(id(fu.recoveredBy), 'defense.fumbleRecoveries'));
    if (fu.touchdown) out.push(delta(id(fu.recoveredBy), 'defense.touchdowns'));
  }
  return out;
};

const involvement = (p: RatedPlayer, bits: PlayBits): PlayStatDelta[] => [
  delta(id(p), 'offensivePlays'),
  delta(id(p), 'epa', bits.epa),
  ...(bits.success ? [delta(id(p), 'successfulPlays')] : []),
];

/** Rushing line for a carry / scramble. */
export const runDeltas = (res: RunResolution, bits: PlayBits): PlayStatDelta[] => {
  const c = res.carrier;
  const out: PlayStatDelta[] = [
    delta(id(c), 'rushing.attempts'), delta(id(c), 'rushing.yards', res.yards), delta(id(c), 'rushing.longest', res.yards),
    delta(id(c), 'rushing.yardsAfterContact', res.yardsAfterContact), ...involvement(c, bits),
  ];
  if (res.brokenTackles > 0) out.push(delta(id(c), 'rushing.brokenTackles', res.brokenTackles));
  if (res.touchdown && !res.fumble?.lost) out.push(delta(id(c), 'rushing.touchdowns'));
  if (bits.firstDown) out.push(delta(id(c), 'rushing.firstDowns'));
  if (bits.bigPlay) out.push(delta(id(c), 'rushing.explosivePlays'));
  if (res.tackle) out.push(...tackleDeltas(res.tackle, res.yards));
  if (res.fumble) out.push(...fumbleDeltas(res.fumble, c, true));
  return out;
};

/** Kneel: a rushing attempt for the QB. */
export const kneelDeltas = (passer: RatedPlayer, yards: number): PlayStatDelta[] => [
  delta(id(passer), 'rushing.attempts'), delta(id(passer), 'rushing.yards', yards), delta(id(passer), 'offensivePlays'),
];

/** Spike: an incompletion on the QB's line. */
export const spikeDeltas = (passer: RatedPlayer): PlayStatDelta[] => [delta(id(passer), 'passing.attempts'), delta(id(passer), 'offensivePlays')];

/** Passing, receiving, coverage and rush credit for a dropback. */
export const passDeltas = (res: PassResolution, bits: PlayBits): PlayStatDelta[] => {
  const q = res.passer;
  const out: PlayStatDelta[] = [...involvement(q, bits)];
  if (res.pressure) {
    out.push(delta(id(q), 'passing.pressures'));
    if (res.pressureBy) out.push(delta(id(res.pressureBy), 'defense.pressures'));
    const blocker = res.sack?.beatenBlocker;
    if (blocker) out.push(delta(id(blocker), 'blocking.pressuresAllowed'));
  }
  if (res.sack) {
    out.push(delta(id(q), 'passing.sacks'), delta(id(q), 'passing.sackYards', res.sack.yardsLost));
    const share = res.sack.assists.length ? 0.5 : 1;
    out.push(delta(id(res.sack.by), 'defense.sacks', share), delta(id(res.sack.by), 'defense.tackles'), delta(id(res.sack.by), 'defense.tfl'));
    if (res.sack.assists.length === 0) out.push(delta(id(res.sack.by), 'defense.soloTackles'));
    for (const a of res.sack.assists) out.push(delta(id(a), 'defense.sacks', 0.5), delta(id(a), 'defense.tackles'), delta(id(a), 'defense.assists'));
    if (res.sack.beatenBlocker) out.push(delta(id(res.sack.beatenBlocker), 'blocking.sacksAllowed'));
    if (res.fumble) out.push(...fumbleDeltas(res.fumble, q, false));
    return out;
  }
  out.push(delta(id(q), 'passing.attempts'));
  if (res.throwAway || !res.target) {
    out.push(delta(id(q), 'passing.throwaways'));
    return out;
  }
  const r = res.target.rated;
  const d = res.defender ?? res.target.defender;
  out.push(delta(id(r), 'receiving.targets'), delta(id(r), 'receiving.separationTotal', res.separation), ...involvement(r, bits));
  if (d) out.push(delta(id(d), 'defense.targetsAllowed'));
  if (res.interception) {
    const i = res.interception;
    out.push(delta(id(q), 'passing.interceptions'), delta(id(i.by), 'defense.interceptions'), delta(id(i.by), 'defense.interceptionYards', i.returnYards));
    if (i.touchdown) out.push(delta(id(i.by), 'defense.touchdowns'));
    if (i.tackledBy) out.push(delta(id(i.tackledBy), 'defense.tackles'), delta(id(i.tackledBy), 'defense.soloTackles'));
    return out;
  }
  if (!res.complete) {
    if (res.incompleteReason === 'drop') out.push(delta(id(r), 'receiving.drops'));
    if ((res.incompleteReason === 'defended' || res.incompleteReason === 'batted') && res.defender) out.push(delta(id(res.defender), 'defense.passBreakups'));
    return out;
  }
  out.push(
    delta(id(q), 'passing.completions'), delta(id(q), 'passing.yards', res.yards), delta(id(q), 'passing.longest', res.yards), delta(id(q), 'passing.airYards', res.airYards),
    delta(id(r), 'receiving.receptions'), delta(id(r), 'receiving.yards', res.yards), delta(id(r), 'receiving.longest', res.yards),
    delta(id(r), 'receiving.yac', res.yac), delta(id(r), 'receiving.airYards', res.airYards),
  );
  if (res.contested) out.push(delta(id(r), 'receiving.contestedCatches'));
  if (res.touchdown && !res.fumble?.lost) out.push(delta(id(q), 'passing.touchdowns'), delta(id(r), 'receiving.touchdowns'));
  if (bits.firstDown) out.push(delta(id(r), 'receiving.firstDowns'));
  if (bits.bigPlay) out.push(delta(id(r), 'receiving.explosivePlays'));
  if (res.brokenTackles > 0) out.push(delta(id(r), 'rushing.brokenTackles', res.brokenTackles));
  if (d) out.push(delta(id(d), 'defense.receptionsAllowed'), delta(id(d), 'defense.yardsAllowed', res.yards));
  if (res.tackle) out.push(...tackleDeltas(res.tackle, res.yards));
  if (res.fumble) out.push(...fumbleDeltas(res.fumble, r, false));
  return out;
};
