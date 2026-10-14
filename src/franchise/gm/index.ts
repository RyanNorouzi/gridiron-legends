/**
 * GM AI public surface: valuation (trade points for players and picks), team needs and direction, and the roster
 * AI (re-signing, cuts, cap compliance, depth charts, trade proposals). `aiEvaluateTrade` is trades.ts
 * evaluateTrade (the AI verdict from the receiving team's side); `aiProposeTrade` wires the proposals to it.
 */
export * from '@/franchise/gm/valuation';
export * from '@/franchise/gm/needs';
export * from '@/franchise/gm/roster-ai';
export { evaluateTrade as aiEvaluateTrade, proposeAiTrade as aiProposeTrade } from '@/franchise/trades';
