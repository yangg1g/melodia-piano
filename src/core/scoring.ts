/**
 * MIDI 钢琴计分与判定系统
 * - PERFECT / OK / BAD / MISS 四级判定
 * - accuracy: 纯 320-graded 权重 (0~1)，与分数分离
 * - score 运行中 = 连击加成的累加分数，最终结算额外叠加长度奖励和模组倍率
 */
export type Judgement = 'PERFECT' | 'OK' | 'BAD' | 'MISS';

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
  /** 按错键次数（弹了不在判定窗口内的音） */
  wrongKeys: number;
}

/** 单个音符的判定结果（用于回放可视化） */
export interface NoteResult {
  midi: number;
  time: number;
  offsetMs: number;
  judgement: Judgement;
}

/** 按错键记录 */
export interface WrongKeyRecord {
  midi: number;
  timeSec: number;
}

/** 判定对应的准确度权重（满分 320 制，PERFECT 额外加分） */
const ACCU_WEIGHT: Record<Judgement, number> = {
  PERFECT: 320,
  OK: 150,
  BAD: 50,
  MISS: 0,
};

/** PERFECT 权重常量，供外部 hold 计分等使用 */
export const ACCU_WEIGHT_PERFECT = 320;

export interface TimingWindows {
  perfect: number;
  ok: number;
  bad: number;
}

const DEFAULT_WINDOWS: TimingWindows = {
  perfect: 80,
  ok: 140,
  bad: 200,
};

export class ScoringEngine {
  combo = 0;
  maxCombo = 0;
  totalWeight = 0;
  achievedWeight = 0;
  /** 运行时累加分数（已含 combo 加成） */
  runningScore = 0;
  /** hold 累计加分（runningScore 的子集，已含逐帧累分） */
  holdScoreAccumulated = 0;
  /** hold 浮点累加器，避免逐帧 Math.round 误差累积 */
  private holdScoreFloat = 0;
  /** 含 hold 的音符数（duration > 0），用于计算理论最高分 */
  holdNoteCount = 0;
  lastJudgement: Judgement | null = null;
  counts: Record<Judgement, number> = { PERFECT: 0, OK: 0, BAD: 0, MISS: 0 };
  /** 按错键次数（不计入命中/准确度） */
  wrongKeys = 0;
  /** 逐音符判定结果（用于回放可视化） */
  noteResults: NoteResult[] = [];
  /** 按错键记录 */
  wrongKeyRecords: WrongKeyRecord[] = [];
  readonly windows: TimingWindows;
  /** 歌曲总音符数（用于长度奖励） */
  totalNotes = 0;
  /** 模组倍率（默认 1.0） */
  modMultiplier = 1;
  /** 全局判定偏移（ms），正=按下偏晚时仍能判准 */
  offsetAdjustMs = 0;
  onUpdate: ((state: ScoreState) => void) | null = null;

  constructor(windows?: Partial<TimingWindows>) {
    this.windows = { ...DEFAULT_WINDOWS, ...windows };
  }

  /** 运行时修改判定窗口（用于设置难度） */
  setWindows(windows: Partial<TimingWindows>): void {
    Object.assign(this.windows, windows);
  }

  judge(offsetMs: number): Judgement {
    const abs = Math.abs(offsetMs - this.offsetAdjustMs);
    if (abs <= this.windows.perfect) return 'PERFECT';
    if (abs <= this.windows.ok) return 'OK';
    if (abs <= this.windows.bad) return 'BAD';
    return 'MISS';
  }

  hit(offsetMs: number, noteMidi?: number, expectedTime?: number): Judgement {
    const j = this.judge(offsetMs);
    this.apply(j);
    if (noteMidi !== undefined && expectedTime !== undefined) {
      this.noteResults.push({ midi: noteMidi, time: expectedTime, offsetMs, judgement: j });
    }
    return j;
  }

  miss(noteMidi?: number, expectedTime?: number): void {
    this.apply('MISS');
    if (noteMidi !== undefined && expectedTime !== undefined) {
      this.noteResults.push({ midi: noteMidi, time: expectedTime, offsetMs: 0, judgement: 'MISS' });
    }
  }

  /** Hold 实时计分：每帧按进度比例累加 hold 奖励（不影响 accuracy / combo）
   *  hold 满分按单音符占比计算，总 hold 奖励上限 = MAX_SCORE × 0.3
   */
  holdTick(holdRatio: number, tapWeight: number): void {
    if (holdRatio <= 0 || this.totalNotes <= 0) return;
    const maxHoldScore = (tapWeight / 320) * (MAX_SCORE / this.totalNotes) * 0.3;
    this.holdScoreFloat += Math.min(holdRatio, 1.0) * maxHoldScore;
    this.emitUpdate();
  }

  /** 按错键：准确度计 MISS 权重，中断 combo */
  wrongKey(noteMidi?: number, timeSec?: number): void {
    this.wrongKeys++;
    this.combo = 0;
    this.lastJudgement = null;
    this.totalWeight += 320;
    this.achievedWeight += ACCU_WEIGHT['MISS'];
    if (noteMidi !== undefined && timeSec !== undefined) {
      this.wrongKeyRecords.push({ midi: noteMidi, timeSec });
    }
    this.emitUpdate();
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

    // 运行时分数 = 该 hit 的权重占比 × (MAX_SCORE / totalNotes) × combo 加成
    // combo 加成：combo / 200，上限 1.0（即 combo ≥ 200 时翻倍）
    const perNoteScore = this.totalNotes > 0 ? MAX_SCORE / this.totalNotes : 0;
    const base = (ACCU_WEIGHT[j] / 320) * perNoteScore;
    const comboMultiplier = j === 'MISS' ? 0 : 1 + Math.min(this.combo, 200) / 200;
    this.runningScore += Math.round(base * comboMultiplier);

    this.emitUpdate();
  }

  /** 当前准确率 */
  getAccuracy(): number {
    return this.totalWeight > 0 ? this.achievedWeight / this.totalWeight : 0;
  }

  /** 当前运行时分数（含 combo 加成 + hold 实时累分） */
  getScore(): number {
    return this.runningScore + Math.round(this.holdScoreFloat);
  }

  /**
   * 结算总分数 = 运行时累加分（已含 tap + combo + hold，同一尺度）
   */
  getTotalScore(): number {
    return this.getScore();
  }

  /**
   * 理论最高分 = 全部 PERFECT + 最大实时 combo + 所有 hold 满分
   * 与 runningScore 同尺度：每音符 MAX_SCORE/totalNotes × combo加成 × hold奖励
   */
  getMaxTheoreticalScore(): number {
    if (this.totalNotes <= 0) return MAX_SCORE;
    const N = this.totalNotes;
    // combo 累加器：PERFECT 命中时 combo 从 1 递增到 N
    // i=1..200: multiplier = 1 + i/200, i=201..N: multiplier = 2.0
    const comboSums: number = N <= 200
      ? N + N * (N + 1) / 400
      : 2 * N - 99.5;
    const maxTapScore = Math.round((MAX_SCORE / N) * comboSums);
    const maxHoldScore = Math.round(this.holdNoteCount * (MAX_SCORE / N) * 0.3);
    return maxTapScore + maxHoldScore;
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
      totalHits: this.counts.PERFECT + this.counts.OK + this.counts.BAD + this.counts.MISS,
      wrongKeys: this.wrongKeys,
    };
  }

  private emitUpdate(): void {
    this.onUpdate?.(this.getState());
  }

  /** 生成当前计分快照（练习模式每轮记录用） */
  snapshot(): {
    score: number;
    maxScore: number;
    combo: number;
    maxCombo: number;
    accuracy: number;
    counts: Record<Judgement, number>;
    wrongKeys: number;
    noteResults: NoteResult[];
    wrongKeyRecords: WrongKeyRecord[];
  } {
    return {
      score: this.getScore(),
      maxScore: this.getMaxTheoreticalScore(),
      combo: this.combo,
      maxCombo: this.maxCombo,
      accuracy: this.getAccuracy(),
      counts: { ...this.counts },
      wrongKeys: this.wrongKeys,
      noteResults: [...this.noteResults],
      wrongKeyRecords: [...this.wrongKeyRecords],
    };
  }

  reset(opts?: { totalNotes?: number; modMultiplier?: number; holdNoteCount?: number }): void {
    this.combo = 0;
    this.maxCombo = 0;
    this.totalWeight = 0;
    this.achievedWeight = 0;
    this.runningScore = 0;
    this.holdScoreAccumulated = 0;
    this.holdScoreFloat = 0;
    this.lastJudgement = null;
    this.counts = { PERFECT: 0, OK: 0, BAD: 0, MISS: 0 };
    this.wrongKeys = 0;
    this.noteResults = [];
    this.wrongKeyRecords = [];
    this.totalNotes = opts?.totalNotes ?? 0;
    this.modMultiplier = opts?.modMultiplier ?? 1;
    this.holdNoteCount = opts?.holdNoteCount ?? 0;
    this.emitUpdate();
  }
}
