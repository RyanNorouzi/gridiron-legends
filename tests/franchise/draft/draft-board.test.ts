import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId, TeamId } from '@/core/ids';
import type { DraftState } from '@/franchise/types';
import { ageValueBonus } from '@/franchise/prospects';
import { reportValue } from '@/franchise/scouting';
import {
  bestAvailable, consensusBoard, gradeFor, gradeRank, insertOnBoard, moveOnBoard, rankAvailable, removeFromBoard,
  setUserBoard, userBoardAvailable,
} from '@/franchise/draft-board';
import { startDraft } from '@/franchise/draft';
import { makeLeague, teamIds } from './helpers';

const league = startDraft(makeLeague(31), createRng(8));
const draft = league.draft as DraftState;
const [A, B] = teamIds(league) as [TeamId, TeamId];
const ids = draft.prospects.map((p) => p.player.id);

describe('consensus board', () => {
  it('orders the pool by public consensus rank', () => {
    const board = consensusBoard(draft.prospects);
    expect(board).toHaveLength(draft.prospects.length);
    const rankOf = new Map(draft.prospects.map((p) => [p.player.id, p.consensusRank ?? 0]));
    for (let i = 1; i < board.length; i++) expect(rankOf.get(board[i]!)!).toBeGreaterThan(rankOf.get(board[i - 1]!)!);
    expect(consensusBoard([...draft.prospects].reverse())).toEqual(board);
  });

  it('falls back to projected round when ranks are absent', () => {
    const unranked = draft.prospects.slice(0, 40).map((p) => ({ ...p, consensusRank: undefined }));
    const board = consensusBoard(unranked);
    const rounds = board.map((id) => unranked.find((p) => p.player.id === id)!.projectedRound);
    for (let i = 1; i < rounds.length; i++) expect(rounds[i]!).toBeGreaterThanOrEqual(rounds[i - 1]!);
  });
});

describe('user board', () => {
  it('sets, inserts, moves and removes prospects', () => {
    let d = setUserBoard(draft, [ids[0]!, ids[1]!, ids[0]!, ids[2]!]);
    expect(d.userBoard).toEqual([ids[0], ids[1], ids[2]]);
    d = insertOnBoard(d, ids[3]!);
    expect(d.userBoard).toEqual([ids[0], ids[1], ids[2], ids[3]]);
    d = insertOnBoard(d, ids[4]!, 1);
    expect(d.userBoard).toEqual([ids[0], ids[4], ids[1], ids[2], ids[3]]);
    d = moveOnBoard(d, ids[3]!, 0);
    expect(d.userBoard).toEqual([ids[3], ids[0], ids[4], ids[1], ids[2]]);
    d = moveOnBoard(d, ids[3]!, 99);
    expect(d.userBoard.at(-1)).toBe(ids[3]);
    d = removeFromBoard(d, ids[4]!);
    expect(d.userBoard).not.toContain(ids[4]);
    expect(removeFromBoard(d, ids[4]!)).toBe(d);
    expect(draft.userBoard).toEqual([]);
  });

  it('rejects unknown prospects and moves of prospects not on the board', () => {
    expect(() => setUserBoard(draft, ['p_nope' as PlayerId])).toThrow(/not in the draft pool/);
    expect(() => insertOnBoard(draft, 'p_nope' as PlayerId)).toThrow(/not in the draft pool/);
    expect(() => moveOnBoard(draft, ids[0]!, 0)).toThrow(/not on the user board/);
  });

  it('lists only prospects still available', () => {
    const d = setUserBoard(draft, [ids[0]!, ids[1]!, ids[2]!]);
    const picked: DraftState = { ...d, prospects: d.prospects.filter((p) => p.player.id !== ids[1]) };
    expect(userBoardAvailable(picked)).toEqual([ids[0], ids[2]]);
  });
});

describe('team rankings', () => {
  it('ranks the pool by the team\'s own scouted value (report + public age term)', () => {
    const rows = rankAvailable(draft, A);
    expect(rows).toHaveLength(draft.prospects.length);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.value).toBeLessThanOrEqual(rows[i - 1]!.value);
    const first = rows[0]!;
    const age = draft.prospects.find((p) => p.player.id === first.prospectId)!.player.age;
    expect(first.value).toBeCloseTo(reportValue(first.report!) + ageValueBonus(age));
    expect(bestAvailable(draft, A)).toEqual(first);
    expect(rankAvailable(draft, B).map((r) => r.prospectId)).not.toEqual(rows.map((r) => r.prospectId));
  });

  it('never reads the ground truth', () => {
    const lied: DraftState = {
      ...draft,
      prospects: draft.prospects.map((p) => ({ ...p, player: { ...p.player, overall: 99 - p.player.overall, potential: 99 } })),
    };
    expect(rankAvailable(lied, A).map((r) => r.prospectId)).toEqual(rankAvailable(draft, A).map((r) => r.prospectId));
  });

  it('applies position, age, grade, board and limit filters', () => {
    const qbs = rankAvailable(draft, A, { positions: ['QB'] });
    expect(qbs.length).toBeGreaterThan(3);
    for (const r of qbs) expect(r.position).toBe('QB');
    for (const r of rankAvailable(draft, A, { maxAge: 21 })) expect(draft.prospects.find((p) => p.player.id === r.prospectId)!.player.age).toBeLessThanOrEqual(21);
    const good = rankAvailable(draft, A, { minGrade: 'B' });
    expect(good.length).toBeGreaterThan(0);
    for (const r of good) expect(gradeRank(r.grade)).toBeLessThanOrEqual(gradeRank('B'));
    const d = setUserBoard(draft, [ids[10]!, ids[20]!]);
    expect(rankAvailable(d, A, { onlyUserBoard: true }).map((r) => r.prospectId).sort()).toEqual([ids[10], ids[20]].sort());
    expect(rankAvailable(draft, A, { limit: 5 })).toHaveLength(5);
    expect(bestAvailable(draft, A, { positions: ['QB'], minGrade: 'A+', maxAge: 20 })).toBeNull();
  });

  it('falls back to the public projection for teams without reports', () => {
    const rows = rankAvailable(draft, 't_unknown' as TeamId, { limit: 10 });
    for (const r of rows) expect(r.report).toBeNull();
    const rounds = rows.map((r) => draft.prospects.find((p) => p.player.id === r.prospectId)!.projectedRound);
    expect(Math.max(...rounds)).toBeLessThanOrEqual(2);
  });

  it('gradeFor agrees with the grade stored on every report', () => {
    for (const r of Object.values(draft.reports[A]!)) expect(gradeFor(r)).toBe(r.grade);
    expect(gradeRank('A+')).toBe(0);
    expect(gradeRank('Z')).toBeGreaterThan(gradeRank('F'));
  });
});
