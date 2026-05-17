/**
 * MIDI 钢琴计分与判定系统
 * 参考 osu!mania ScoreV2 + Combo 加成 + 长度奖励 + 模组倍率：
 * - PERFECT / GREAT / GOOD / OK / MEH / MISS 六级判定
 * - accuracy: 纯 320-graded 权重 (0~1)，与分数分离
 * - score 运行中 = 连击加成的累加分数，最终结算额外叠加长度奖励和模组倍率
 */
export type Judgement = 'PERFECT' | 'GREAT' | 'GOOD' | 'OK' | 'MEH' | 'MISS';

export const MAX_SCORE = 1_000_000;

export interface ScoreState {
  score: number;
  maxScore: number;
  combo: number;
  maxCombo: number;
  accuracy: number;
  lastJudgement: Judgement | null;
  counts: Record<Judgement, number>;
  totalHits: number;
}

/** 判定对应的准确度权重（满分 320 制，PERFECT 额外加分） */
const ACCU_WEIGHT: Record<Judgement, number> = {
  PERFECT: 320,
  GREAT: 300,
  GOOD: 200,
  OK: 100,
  MEH: 50,
  MISS: 0,
};

export interface TimingWindows {
  perfect: number;
  great: number;
  good: number;
  ok: number;
  meh: number;
}

const DEFAULT_WINDOWS: TimingWindows = {
  perfect: 25,
  great: 60,
  good: 100,
  ok: 140,
  meh: 180,
};

export class ScoringEngine {
  combo = 0;
  maxCombo = 0;
  totalWeight = 0;
  achievedWeight = 0;
  /** 运行时累加分数（已含 combo 加成） */
  runningScore = 0;
  lastJudgement: Judgement | null = null;
  counts: Record<Judgement, number> = { PERFECT: 0, GREAT: 0, GOOD: 0, OK: 0, MEH: 0, MISS: 0 };
  readonly windows: TimingWindows;
  /** 歌曲总音符数（用于长度奖励） */
  totalNotes = 0;
  /** 模组倍率（默认 1.0） */
  modMultiplier = 1;
  onUpdate: ((state: ScoreState) => void) | null = null;

  constructor(windows?: Partial<TimingWindows>) {
    this.windows = { ...DEFAULT_WINDOWS, ...windows };
  }

  /** 运行时修改判定窗口（用于设置难度） */
  setWindows(windows: Partial<TimingWindows>): void {
    Object.assign(this.windows, windows);
  }

  judge(offsetMs: number): Judgement {
    const abs = Math.abs(offsetMs);
    if (abs <= this.windows.perfect) return 'PERFECT';
    if (abs <= this.windows.great) return 'GREAT';
    if (abs <= this.windows.good) return 'GOOD';
    if (abs <= this.windows.ok) return 'OK';
    if (abs <= this.windows.meh) return 'MEH';
    return 'MISS';
  }

  hit(offsetMs: number): Judgement {
    const j = this.judge(offsetMs);
    this.apply(j);
    return j;
  }

  miss(): void {
    this.apply('MISS');
  }

  private apply(j: Judgement): void {
    this.lastJudgement = j;
    this.counts[j]++;

    if (j === 'MISS') {
      this.combo = 0;
    } else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }

    // 准确度（纯权重，不参与分数）
    this.totalWeight += 320;
    this.achievedWeight += ACCU_WEIGHT[j];

    // 运行时分数 = 该 hit 的权重占比 × MAX_SCORE × combo 加成
    // combo 加成：combo / 200，上限 1.0（即 combo ≥ 200 时翻倍）
    const base = (ACCU_WEIGHT[j] / 320) * MAX_SCORE;
    const comboMultiplier = j === 'MISS' ? 0 : 1 + Math.min(this.combo, 200) / 200;
    this.runningScore += Math.round(base * comboMultiplier);

    this.emitUpdate();
  }

  /** 当前准确率 */
  getAccuracy(): number {
    return this.totalWeight > 0 ? this.achievedWeight / this.totalWeight : 0;
  }

  /** 当前运行时分数（含 combo 加成） */
  getScore(): number {
    return this.runningScore;
  }

  /**
   * 最终结算分数 = accuracy × MAX_SCORE × combo奖励 × 长度奖励 × 模组倍率
   * combo奖励  = 1 + 0.5 × (maxCombo / totalNotes)   最大 1.5 倍
   * 长度奖励    = 1 + 0.1 × min(1, totalNotes / 1500)  最大 1.1 倍
   */
  getFinalScore(): number {
    const acc = this.getAccuracy();
    const comboRatio = this.totalNotes > 0 ? this.maxCombo / this.totalNotes : 0;
    const comboBonus = 1 + 0.5 * comboRatio;
    const lengthBonus = 1 + 0.1 * Math.min(1, this.totalNotes / 1500);
    return Math.round(acc * MAX_SCORE * comboBonus * lengthBonus * this.modMultiplier);
  }

  getState(): ScoreState {
    return {
      score: this.getScore(),
      maxScore: MAX_SCORE,
      combo: this.combo,
      maxCombo: this.maxCombo,
      accuracy: this.getAccuracy(),
      lastJudgement: this.lastJudgement,
      counts: { ...this.counts },
      totalHits: this.counts.PERFECT + this.counts.GREAT + this.counts.GOOD + this.counts.OK + this.counts.MEH + this.counts.MISS,
    };
  }

  private emitUpdate(): void {
    this.onUpdate?.(this.getState());
  }

  reset(opts?: { totalNotes?: number; modMultiplier?: number }): void {
    this.combo = 0;
    this.maxCombo = 0;
    this.totalWeight = 0;
    this.achievedWeight = 0;
    this.runningScore = 0;
    this.lastJudgement = null;
    this.counts = { PERFECT: 0, GREAT: 0, GOOD: 0, OK: 0, MEH: 0, MISS: 0 };
    this.totalNotes = opts?.totalNotes ?? 0;
    this.modMultiplier = opts?.modMultiplier ?? 1;
    this.emitUpdate();
  }
}
