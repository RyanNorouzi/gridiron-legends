import type { PlayResultType } from '../play-types';
import type { Athlete } from '../play-types';
import type { CompletionRecord, TackleRecord } from './env';

/** Facts derived once from the dead PlayState and shared by the outcome, stats and play-by-play builders. */
export interface OutcomeFacts {
  result: PlayResultType;
  yards: number;
  endBallOn: number;
  endBallX: number;
  turnover: boolean;
  turnoverType: 'interception' | 'fumble' | 'onside' | null;
  touchdown: boolean;
  safety: boolean;
  firstDown: boolean;
  incomplete: boolean;
  outOfBounds: boolean;
  kickMade: boolean | null;
  kickDistance: number | null;
  returnYards: number;
  rusher: Athlete | null;
  passer: Athlete | null;
  receiver: Athlete | null;
  completion: CompletionRecord | null;
  tackle: TackleRecord | null;
  scorer: Athlete | null;
  carrier: Athlete | null;
  airYards: number;
  yac: number;
  yardsAfterContact: number;
  explosive: boolean;
  isScrimmage: boolean;
  isPassPlay: boolean;
  success: boolean;
  epa: number;
  timeElapsed: number;
  presnapElapsed: number;
}
