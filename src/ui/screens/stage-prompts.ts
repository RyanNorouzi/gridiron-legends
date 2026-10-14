/**
 * Modal prompts the Game screen raises for session decisions: coin toss, penalty accept / decline, the free kick
 * after a safety and watch mode's "JUMP IN?". Pure mapping from a stage to PromptScreen options.
 */
import type { GameSession, SessionStage } from '../game/session-types';
import { attendanceText } from '../render/stadium';
import type { PromptOptions } from './watch';

/** Prompt for a decision stage (null for stages that are not modal decisions). */
export const promptForStage = (stage: SessionStage, session: GameSession, watchPromptSeconds: number): PromptOptions | null => {
  const abbr = (side: 'home' | 'away'): string => session.setup[side].team.abbr;
  switch (stage.kind) {
    case 'coinToss': {
      // Overtime has no second half to defer to, and the stadium intro belongs to the pregame toss.
      const overtime = session.state.overtime !== null || session.state.clock.quarter > 4;
      if (overtime) {
        return {
          title: 'OVERTIME TOSS', lines: [`Tied ${session.state.score.home}-${session.state.score.away} after regulation`, `${abbr(stage.side)} won the overtime toss`],
          choices: [{ id: 'receive', label: 'RECEIVE' }, { id: 'kick', label: 'KICK' }],
          onChoose: (id) => session.answerCoinToss(id as 'kick' | 'receive'),
        };
      }
      return {
        title: 'COIN TOSS', lines: [`${session.setup.stadium.name} · attendance ${attendanceText(session.setup)}`, `${abbr(stage.side)} won the toss`],
        choices: [{ id: 'receive', label: 'RECEIVE' }, { id: 'kick', label: 'KICK' }, { id: 'defer', label: 'DEFER', detail: 'Receive to open the second half' }],
        onChoose: (id) => session.answerCoinToss(id as 'kick' | 'receive' | 'defer'),
      };
    }
    case 'penalty':
      return {
        title: stage.prompt.title, tone: 'warning', lines: [stage.prompt.acceptText, stage.prompt.declineText],
        choices: [{ id: 'accept', label: 'ACCEPT' }, { id: 'decline', label: 'DECLINE' }],
        onChoose: (id) => session.answerPenalty(id === 'accept'),
      };
    case 'freeKick':
      return {
        title: 'FREE KICK', lines: ['After the safety: kick off or punt?'],
        choices: [{ id: 'kick', label: 'KICK OFF' }, { id: 'punt', label: 'PUNT' }],
        onChoose: (id) => session.answerFreeKick(id as 'kick' | 'punt'),
      };
    case 'watchPrompt':
      return {
        title: stage.prompt.title, lines: [stage.prompt.text],
        choices: [{ id: 'yes', label: 'YES', detail: 'Take control' }, { id: 'simulate', label: 'SIMULATE' }],
        backChoice: 'simulate',
        // Unattended watch mode keeps playing: no answer within the countdown means "simulate".
        timeoutChoice: 'simulate',
        timeoutSeconds: watchPromptSeconds,
        onChoose: (id) => session.answerWatchPrompt(id === 'yes'),
      };
    default:
      return null;
  }
};
