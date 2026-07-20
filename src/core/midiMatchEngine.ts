/**
 * MIDI 匹配引擎 — 纯逻辑模块，不依赖浏览器 DOM / MIDI API / 音效。
 * 同时被 keyboardPractice.ts (浏览器) 和 simulate-midi.ts (Node) 复用。
 */
import { ScoringEngine, ACCU_WEIGHT_PERFECT, type ScoreState } from './scoring';
import type { FlatNote } from './midiScore';

// ─── 类型定义 ──────────────────────────────────────────────

export type Hand = 'treble' | 'bass';

export interface NoteState {
  note: FlatNote;
  isHit: boolean;
  hitTimeSec: number | null;
  hitOffsetMs: number;
  /** hold 实时计分：已完成累分的秒数 */
  holdProgressSec: number;
  /** tap 击打时的权重，用于计算 hold 奖励基数 */
  tapWeight: number;
}

export interface MidiMatchCallbacks {
  log: (msg: string) => void;
  onNoteStart?: (midi: number, velocity: number) => void;
  onNoteRelease?: (midi: number) => void;
  onWrongKey?: (midi: number, velocity: number) => void;
  onVisualUpdate?: (expected: Map<number, Hand>, pressed: Set<number>) => void;
  onPaintState?: (notes: NoteState[], currentTimeSec: number) => void;
  onScoreUpdate?: () => void;
  onTimeSec?: (sec: number) => void;
  onWallTimeSec?: (wallSec: number) => void;
  onEnded?: () => void;
}

export interface EngineOptions {
  freePlay: boolean;
  speedMultiplier: number;
  hitWindowMs: number;
  perfectMs: number;
  scoring?: ScoringEngine;
  getHandForNote: (note: FlatNote) => Hand;
  startWallTimeMs?: number;
  /** 初始游戏时间（秒），默认 firstNoteTime - 1.5。Node 模拟建议传 Math.max(0, firstNoteTime - 1.5) */
  initialGameTimeSec?: number;
}

// ─── 公共工具函数 ──────────────────────────────────────────

export function parseMidiKey(data: Uint8Array): { note: number; down: boolean } | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    return { note: data[1], down: vel > 0 };
  }
  if (st >= 0x80 && st < 0x90) {
    return { note: data[1], down: false };
  }
  return null;
}

export function parseNoteOn(data: Uint8Array): { note: number; velocity: number } | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    if (vel > 0) return { note: data[1], velocity: vel / 127 };
  }
  return null;
}

// ─── 匹配引擎 ──────────────────────────────────────────────

const RELEASE_GRACE_SEC = 0.1;

export class MidiMatchEngine {
  readonly flatNotes: FlatNote[];
  readonly freePlay: boolean;
  readonly speedMultiplier: number;
  readonly hitWindowMs: number;
  readonly hitWindowSec: number;
  readonly scoring?: ScoringEngine;
  readonly getHandForNote: (note: FlatNote) => Hand;
  readonly callbacks: MidiMatchCallbacks;

  pressedMidis = new Set<number>();
  pressedVelocities = new Map<number, number>();
  keyPressTimes = new Map<number, number>();
  sustainedNotes = new Set<number>();
  soundedNotes = new Set<number>();
  consumedPresses = new Set<number>();
  noteStates: NoteState[] = [];
  noteTimeGroups = new Map<number, number[]>();
  missedNotes = new Set<number>();
  accumulatedTimeSec = 0;

  private announcedExpected = new Set<number>();
  private announcedMatched = new Set<number>();
  private finishScheduled = false;
  private _stopped = false;
  private hasFirstPress = false;
  /** 跟弹模式：所有音符已命中，进入收尾阶段，时间可以自由推进 */
  private allNotesHit = false;
  private firstPressWallSec = 0;

  constructor(flatNotes: FlatNote[], callbacks: MidiMatchCallbacks, options: EngineOptions) {
    this.flatNotes = flatNotes;
    this.freePlay = options.freePlay;
    this.speedMultiplier = options.speedMultiplier;
    this.hitWindowMs = options.hitWindowMs;
    this.hitWindowSec = options.hitWindowMs / 1000;
    this.scoring = options.scoring;
    this.getHandForNote = options.getHandForNote;
    this.callbacks = callbacks;

    this.accumulatedTimeSec = options.initialGameTimeSec !== undefined
      ? options.initialGameTimeSec
      : (() => {
          const firstNoteTime = flatNotes.length > 0
            ? Math.min(...flatNotes.map(n => n.time))
            : 0;
          // 跟弹模式：时间从第一个音符开始，让音符立即可见（hasFirstPress 会冻结时间直到首次按键）
          if (!options.freePlay) return Math.max(0, firstNoteTime - 0.3);
          return firstNoteTime - 1.5;
        })();

    this.noteStates = flatNotes.map(note => ({
      note,
      isHit: false,
      hitTimeSec: null,
      hitOffsetMs: 0,
      holdProgressSec: 0,
      tapWeight: ACCU_WEIGHT_PERFECT,
    }));

    // 按时间分组（0.001s 容差）
    const timeBucket = new Map<number, number[]>();
    for (let i = 0; i < this.noteStates.length; i++) {
      const t = this.noteStates[i].note.time;
      let foundBucket: number | undefined;
      for (const [bt] of timeBucket) {
        if (Math.abs(bt - t) < 0.001) { foundBucket = bt; break; }
      }
      const key = foundBucket ?? t;
      if (!timeBucket.has(key)) timeBucket.set(key, []);
      timeBucket.get(key)!.push(i);
    }
    for (const [, indices] of timeBucket) {
      for (const idx of indices) {
        this.noteTimeGroups.set(idx, indices);
      }
    }

    if (options.scoring) {
      options.scoring.reset({ totalNotes: flatNotes.length });
      this.callbacks.onScoreUpdate?.();
    }
  }

  get stopped() { return this._stopped; }
  getEffectiveTimeSec() { return this.accumulatedTimeSec; }

  // ─── 主帧处理 (对应原 paint()) ──────────────────────────

  processFrame(deltaSec: number, wallTimeSec: number): void {
    if (this._stopped) return;

    // 1. 更新时间（跟弹模式可能暂停）
    this._updateAccumulatedTime(deltaSec);
    const effectiveTimeSec = this.getEffectiveTimeSec();
    const modeLabel = this.freePlay ? '普通' : '跟弹';

    // 2. 按键即发声（不等和弦齐）
    for (let idx = 0; idx < this.noteStates.length; idx++) {
      const ns = this.noteStates[idx];
      if (ns.isHit || this.missedNotes.has(idx)) continue;
      const noteEnd = ns.note.time + Math.max(0, ns.note.duration);
      if (effectiveTimeSec < ns.note.time - this.hitWindowSec) continue;
      if (effectiveTimeSec > noteEnd) continue;
      if (!this.pressedMidis.has(ns.note.midi)) continue;
      if (this.soundedNotes.has(ns.note.midi)) continue;

      const vel = this.pressedVelocities.get(ns.note.midi) ?? 1.0;
      this.callbacks.onNoteStart?.(ns.note.midi, vel);
      this.sustainedNotes.add(ns.note.midi);
      this.soundedNotes.add(ns.note.midi);
    }

    // 3. 帧匹配：按时间组整体匹配，和弦必须全部按住才一起得分
    const processedGroups = new Set<number>();
    const nowSec = this.freePlay ? effectiveTimeSec : wallTimeSec;
    for (let idx = 0; idx < this.noteStates.length; idx++) {
      const group = this.noteTimeGroups.get(idx);
      const groupKey = group ? group[0] : idx;
      if (processedGroups.has(groupKey)) continue;

      const members = group ?? [idx];

      // 收集该组内待匹配的音符
      const pending: number[] = [];
      for (const i of members) {
        const ns = this.noteStates[i];
        if (ns.isHit || this.missedNotes.has(i)) continue;
        const noteEnd = ns.note.time + Math.max(0, ns.note.duration);
        if (effectiveTimeSec < ns.note.time - this.hitWindowSec) continue;
        if (effectiveTimeSec > noteEnd) continue;
        pending.push(i);
      }
      if (pending.length === 0) continue;

      // 确保没有跳过更早的待匹配音符（防止先匹配后面的音）
      const firstIdx = members[0];
      let hasEarlierPending = false;
      for (let j = 0; j < firstIdx; j++) {
        const earlier = this.noteStates[j];
        if (earlier.isHit || this.missedNotes.has(j)) continue;
        const earlierEnd = earlier.note.time + Math.max(0, earlier.note.duration);
        if (effectiveTimeSec >= earlier.note.time - this.hitWindowSec &&
            effectiveTimeSec <= earlierEnd) {
          hasEarlierPending = true;
          break;
        }
      }
      if (hasEarlierPending) continue;

      // 全部按住且未消费
      const allPressed = pending.every(i => {
        const midi = this.noteStates[i].note.midi;
        return this.pressedMidis.has(midi) && !this.consumedPresses.has(midi);
      });
      if (!allPressed) continue;

      // 全部在 0.1s 内按下
      const allRecent = pending.every(i => {
        const p = this.keyPressTimes.get(this.noteStates[i].note.midi);
        return p !== undefined && wallTimeSec - p <= 0.1;
      });
      if (!allRecent) continue;

      // 全部命中 → 立即计 tap 分
      processedGroups.add(groupKey);
      this.announcedMatched.add(groupKey);

      const hitOffsets: Array<{ idx: number; midi: number; offsetMs: number }> = [];
      for (const i of pending) {
        const ns = this.noteStates[i];
        const offsetMs = this.freePlay
          ? (effectiveTimeSec - ns.note.time) * 1000
          : 0;
        ns.isHit = true;
        ns.hitTimeSec = nowSec;
        ns.hitOffsetMs = offsetMs;
        this.consumedPresses.add(ns.note.midi);

        if (this.scoring) {
          const j = this.scoring.hit(offsetMs, ns.note.midi, ns.note.time);
          ns.tapWeight = j === 'PERFECT' ? 320 : j === 'OK' ? 150 : 0;
          this.callbacks.onScoreUpdate?.();
        }

        hitOffsets.push({ idx: i, midi: ns.note.midi, offsetMs });
      }

      const ids = hitOffsets.map(h => h.idx).join(',');
      const notes = hitOffsets.map(h => `midi=${h.midi}`).join(' ');
      this.callbacks.log(
        `[NOTE] 匹配成功  id=${ids}  ${notes}  期望=${this.noteStates[groupKey].note.time.toFixed(3)}s  偏差=${hitOffsets.map(h => h.offsetMs.toFixed(1)).join(',')}ms  游戏时间=${effectiveTimeSec.toFixed(3)}s  墙上时间=${wallTimeSec.toFixed(3)}s  模式=${modeLabel}`
      );
    }

    // 4. Hold 实时计分：每帧按进度追加 hold 奖励
    for (let idx = 0; idx < this.noteStates.length; idx++) {
      const ns = this.noteStates[idx];
      if (!ns.isHit || this.missedNotes.has(idx)) continue;
      if (ns.tapWeight === 0) continue;
      const dur = Math.max(0, ns.note.duration);
      if (dur < 0.05) continue;
      if (!this.pressedMidis.has(ns.note.midi)) continue;

      const noteEnd = ns.note.time + dur;
      const holdSoFar = Math.max(0, Math.min(effectiveTimeSec, noteEnd) - ns.note.time);
      const newProgress = holdSoFar - ns.holdProgressSec;
      if (newProgress > 0) {
        const holdRatio = newProgress / dur;
        this.scoring?.holdTick(holdRatio, ns.tapWeight);
        ns.holdProgressSec = holdSoFar;
        this.callbacks.onScoreUpdate?.();
      }
    }

    // 5. MISS 检测（自由模式）
    if (this.freePlay && this.scoring) {
      for (let idx = 0; idx < this.noteStates.length; idx++) {
        const ns = this.noteStates[idx];
        if (ns.isHit || this.missedNotes.has(idx)) continue;
        const offsetMs = (effectiveTimeSec - ns.note.time) * 1000;
        if (offsetMs > this.hitWindowMs) {
          this.callbacks.log(
            `[MIDI] MISS  note=${ns.note.midi}  期望=${ns.note.time.toFixed(3)}s  偏移=${offsetMs.toFixed(0)}ms  游戏时间=${effectiveTimeSec.toFixed(3)}s`
          );
          this.missedNotes.add(idx);
          ns.isHit = true;
          this.scoring.miss(ns.note.midi, ns.note.time);
          this.callbacks.onScoreUpdate?.();
        }
      }
    }

    // 5. 期望音符 + 新增日志
    const expected = new Map<number, Hand>();
    const newlyExpected: Array<{ idx: number; midi: number; time: number; dur: number; hand: Hand }> = [];
    for (let idx = 0; idx < this.noteStates.length; idx++) {
      const ns = this.noteStates[idx];
      const isExpected =
        effectiveTimeSec >= ns.note.time &&
        effectiveTimeSec < ns.note.time + Math.max(0, ns.note.duration) - RELEASE_GRACE_SEC;
      if (isExpected) {
        expected.set(ns.note.midi, this.getHandForNote(ns.note));
        if (!ns.isHit && !this.missedNotes.has(idx) && !this.announcedExpected.has(idx)) {
          this.announcedExpected.add(idx);
          newlyExpected.push({
            idx,
            midi: ns.note.midi,
            time: ns.note.time,
            dur: Math.max(0, ns.note.duration),
            hand: this.getHandForNote(ns.note),
          });
        }
      }
    }

    if (newlyExpected.length > 0) {
      const groups: Array<typeof newlyExpected> = [];
      for (const n of newlyExpected) {
        const group = groups.find(g => Math.abs(g[0].time - n.time) < 0.001);
        if (group) { group.push(n); } else { groups.push([n]); }
      }
      for (const g of groups) {
        const ids = g.map(n => n.idx).join(',');
        const notes = g.map(n => `midi=${n.midi}`).join(' ');
        this.callbacks.log(
          `[NOTE] 期望按键  id=${ids}  ${notes}  开始=${g[0].time.toFixed(3)}s  持续=${g.map(n => n.dur.toFixed(3)).join(',')}s  手=${g.map(n => n.hand).join(',')}  游戏时间=${effectiveTimeSec.toFixed(3)}s  模式=${modeLabel}`
        );
      }
    }


    // 6. 视觉更新
    this.callbacks.onVisualUpdate?.(expected, this.pressedMidis);
    this.callbacks.onPaintState?.(this.noteStates, effectiveTimeSec);

    // 7. 结束检测
    if (!this.finishScheduled && this.flatNotes.length > 0) {
      const allDone = this.noteStates.every(ns =>
        ns.note.time + Math.max(0, ns.note.duration) < effectiveTimeSec
      );
      // 跟弹模式：所有音符已命中后，进入收尾阶段让音符自然播完
      if (!this.freePlay && !this.allNotesHit && this.noteStates.every(ns => ns.isHit)) {
        this.allNotesHit = true;
        this.callbacks.log(`[MIDI] 所有音符已命中，等待收尾。游戏时间=${effectiveTimeSec.toFixed(3)}s`);
      }
      if (allDone) {
        this.finishScheduled = true;
        const reason = !this.freePlay && this.allNotesHit ? '所有音符播放完毕' : '所有音符时间已过';
        this.callbacks.log(`[MIDI] ${reason}，自动结束。游戏时间=${effectiveTimeSec.toFixed(3)}s`);
        setTimeout(() => this.stop(), 500);
        return;
      }
    }

    this.callbacks.onTimeSec?.(effectiveTimeSec);
    // 跟弹模式：扣除首次按键前的等待时间，UI 计时从首次按键开始
    const adjustedWallSec = this.freePlay
      ? wallTimeSec
      : (this.hasFirstPress ? Math.max(0, wallTimeSec - this.firstPressWallSec) : 0);
    this.callbacks.onWallTimeSec?.(adjustedWallSec);
  }

  // ─── MIDI 事件处理 (对应原 onMidi()) ─────────────────────

  processMidiEvent(data: Uint8Array, wallTimeSec: number): void {
    if (this._stopped || !data || data.length < 3) return;

    const gameSec = this.getEffectiveTimeSec();
    const modeLabel = this.freePlay ? '普通' : '跟弹';

    // DEBUG
    const hexBytes = [...data].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const keyEv = parseMidiKey(data);
    this.callbacks.log(
      `[DEBUG] RAW  ${hexBytes}  |  keyEv=${keyEv ? `note=${keyEv.note} down=${keyEv.down}` : 'null'}  |  gameSec=${gameSec.toFixed(3)}  wall=${wallTimeSec.toFixed(3)}`
    );

    if (!keyEv) return;

    if (keyEv.down) {
      // 跟弹模式：首次按键启动计时
      if (!this.freePlay && !this.hasFirstPress) {
        this.hasFirstPress = true;
        this.firstPressWallSec = wallTimeSec;
        this.callbacks.log(`[MIDI] 首次按键，开始计时  游戏时间=${gameSec.toFixed(3)}s  墙上时间=${wallTimeSec.toFixed(3)}s`);
      }

      // 记录按键状态
      this.pressedMidis.add(keyEv.note);
      // 不在此处清除 consumedPresses：
      // 只有松手(key-up)才表示"消费周期结束"，否则按住一个键会连续匹配多个同名音符
      this.keyPressTimes.set(keyEv.note, wallTimeSec);

      const noteEv = parseNoteOn(data);
      if (noteEv) this.pressedVelocities.set(keyEv.note, noteEv.velocity);

      // 错键检测：当前没有等待按键的对应 note
      const isExpected = this.noteStates.some((ns, idx) => {
        if (ns.note.midi !== keyEv.note) return false;
        if (ns.isHit || this.missedNotes.has(idx)) return false;
        return gameSec >= ns.note.time - this.hitWindowSec &&
               gameSec <= ns.note.time + Math.max(0, ns.note.duration);
      });

      if (!isExpected) {
        this.callbacks.log(
          `[NOTE] 错键  note=${keyEv.note}  游戏时间=${gameSec.toFixed(3)}s  墙上时间=${wallTimeSec.toFixed(3)}s  模式=${modeLabel}`
        );
        const vel = this.pressedVelocities.get(keyEv.note) ?? 1.0;
        this.callbacks.onWrongKey?.(keyEv.note, vel);
        if (this.scoring) {
          this.scoring.wrongKey(keyEv.note, gameSec);
          this.callbacks.onScoreUpdate?.();
        }
      }
    } else {
      // 松开
      this.pressedMidis.delete(keyEv.note);
      this.consumedPresses.delete(keyEv.note);
      this.pressedVelocities.delete(keyEv.note);
      this.keyPressTimes.delete(keyEv.note);
      this.soundedNotes.delete(keyEv.note);

      if (this.sustainedNotes.has(keyEv.note)) {
        this.sustainedNotes.delete(keyEv.note);
        this.callbacks.onNoteRelease?.(keyEv.note);
      }
    }
  }

  // ─── 停止 ────────────────────────────────────────────────

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    this.hasFirstPress = false;
    this.firstPressWallSec = 0;
    this.allNotesHit = false;
    this.pressedMidis.clear();
    this.sustainedNotes.clear();
    this.soundedNotes.clear();
    this.keyPressTimes.clear();
    this.callbacks.onVisualUpdate?.(new Map(), new Set());
    this.callbacks.onPaintState?.(this.noteStates, this.getEffectiveTimeSec());
    this.callbacks.onEnded?.();
  }

  isAllDone(): boolean {
    return this.noteStates.every(ns =>
      ns.note.time + Math.max(0, ns.note.duration) < this.getEffectiveTimeSec()
    );
  }

  getScoreState(): ScoreState | null {
    return this.scoring?.getState() ?? null;
  }

  // ─── 内部方法 ─────────────────────────────────────────────

  private _updateAccumulatedTime(deltaSec: number): boolean {
    if (this.freePlay || this.flatNotes.length === 0) {
      this.accumulatedTimeSec += deltaSec * this.speedMultiplier;
      return false;
    }

    // 跟弹模式：所有音符已命中 → 时间自由推进，让音符自然播完
    if (this.allNotesHit) {
      this.accumulatedTimeSec += deltaSec * this.speedMultiplier;
      return false;
    }

    // 跟弹模式：按下第一个音之前，时间暂停
    if (!this.hasFirstPress) return true;

    // 找到第一个未命中的音符，游戏时间锁定在它身上，不许跳过
    for (let idx = 0; idx < this.noteStates.length; idx++) {
      const ns = this.noteStates[idx];
      if (ns.isHit || this.missedNotes.has(idx)) continue;

      if (this.accumulatedTimeSec >= ns.note.time) {
        // 时间已到达该音符 → 锁住，等待匹配
        this.accumulatedTimeSec = ns.note.time;

        // 仍在判定窗口内时，检查按键是否就绪
        const noteEnd = ns.note.time + Math.max(0, ns.note.duration);
        if (this.accumulatedTimeSec < noteEnd - RELEASE_GRACE_SEC) {
          if (!this.pressedMidis.has(ns.note.midi)) return true;
          if (this.consumedPresses.has(ns.note.midi)) {
            this.callbacks.log(
              `[MIDI] 跟弹暂停  note=${ns.note.midi} (已消费，等松开再按)  期望=${ns.note.time.toFixed(3)}s  游戏时间=${this.accumulatedTimeSec.toFixed(3)}s`
            );
            return true;
          }
        }
        // 按键已就绪（或窗口已过），仍暂停等待 processFrame 匹配
        return true;
      }

      // 时间还未到该音符 → 正常前进
      break;
    }

    this.accumulatedTimeSec += deltaSec * this.speedMultiplier;
    return false;
  }
}
