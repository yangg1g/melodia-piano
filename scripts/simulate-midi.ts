/**
 * MIDI 匹配模拟器 — 读取 MIDI 文件并模拟键盘输入，
 * 直接调用 src/midiMatchEngine.ts 的匹配引擎，生成与浏览器完全一致的诊断日志。
 *
 * 用法:
 *   npx tsx scripts/simulate-midi.ts --midi <path> [options]
 *
 * 选项:
 *   --midi <path>     MIDI 文件路径 (必需)
 *   --mode <mode>     模拟模式: free(普通) | follow(跟弹) (默认: follow)
 *   --offset <ms>     按键偏移毫秒数 (默认: 0, 正=延迟, 负=提前)
 *   --window <ms>     判定窗口毫秒 (默认: 180)
 *   --perfect <ms>    PERFECT 窗口毫秒 (默认: 25)
 *   --speed <n>       速度倍率 (默认: 1)
 *   --output <path>   输出日志文件路径 (不指定则输出到控制台)
 *   --verbose, -v     详细输出
 *   --help, -h        显示帮助
 */

import toneMidi from '@tonejs/midi';
const { Midi } = toneMidi as unknown as { Midi: typeof import('@tonejs/midi').Midi };
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { MidiMatchEngine, type MidiMatchCallbacks } from '../src/midiMatchEngine.ts';
import { ScoringEngine } from '../src/scoring.ts';
import { flattenNotes, assignHandForNote } from '../src/midiScore.ts';

// ─── 命令行参数 ──────────────────────────────────────────────

interface Config {
  midiPath: string;
  mode: string;
  offsetMs: number;
  windowMs: number;
  perfectMs: number;
  speedMultiplier: number;
  verbose: boolean;
  outputPath: string | null;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    midiPath: '',
    mode: 'follow',
    offsetMs: 0,
    windowMs: 180,
    perfectMs: 25,
    speedMultiplier: 1,
    verbose: false,
    outputPath: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--midi':     config.midiPath = args[++i]; break;
      case '--mode':     config.mode = args[++i]; break;
      case '--offset':   config.offsetMs = parseFloat(args[++i]); break;
      case '--window':   config.windowMs = parseFloat(args[++i]); break;
      case '--perfect':  config.perfectMs = parseFloat(args[++i]); break;
      case '--speed':    config.speedMultiplier = parseFloat(args[++i]); break;
      case '--output':   config.outputPath = args[++i]; break;
      case '--verbose':
      case '-v':         config.verbose = true; break;
      case '--help':
      case '-h':
        console.log(`
MIDI 匹配模拟器 — 读取 MIDI 文件并模拟键盘输入，生成诊断日志。

用法: npx tsx scripts/simulate-midi.ts --midi <path> [options]

选项:
  --midi <path>     MIDI 文件路径 (必需)
  --mode <mode>     模拟模式: free(普通) | follow(跟弹) (默认: follow)
  --offset <ms>     按键偏移毫秒数 (默认: 0, 正=延迟, 负=提前)
  --window <ms>     判定窗口毫秒 (默认: 180)
  --perfect <ms>    PERFECT 窗口毫秒 (默认: 25)
  --speed <n>       速度倍率 (默认: 1)
  --output <path>   输出日志文件路径 (不指定则输出到控制台)
  --verbose, -v     详细输出
  --help, -h        显示帮助

示例:
  # 跟弹模式, 完美时间
  npx tsx scripts/simulate-midi.ts --midi public/songs/test.mid

  # 普通模式, 延迟 50ms
  npx tsx scripts/simulate-midi.ts --midi public/songs/test.mid --mode free --offset 50

  # 输出到文件
  npx tsx scripts/simulate-midi.ts --midi public/songs/test.mid --output logs/sim.txt
`);
        process.exit(0);
    }
  }

  if (!config.midiPath) {
    console.error('错误: 需要 --midi <路径> 参数, 使用 --help 查看帮助');
    process.exit(1);
  }

  return config;
}

// ─── 日志输出 ────────────────────────────────────────────────

const logLines: string[] = [];

function midiLog(msg: string): void {
  logLines.push(msg);
  console.log(msg);
}

function flushLogs(outputPath: string | null): void {
  if (outputPath) {
    const abs = resolve(outputPath);
    writeFileSync(abs, logLines.join('\n') + '\n', 'utf-8');
    console.log(`\n日志已写入: ${abs}`);
  }
}

// ─── 主模拟逻辑 ──────────────────────────────────────────────

function simulate(config: Config): void {
  const { midiPath, mode, offsetMs, windowMs, perfectMs, speedMultiplier } = config;
  const freePlay = mode === 'free';

  // 1. 加载 MIDI 文件
  const buf = readFileSync(midiPath);
  const midi = new Midi(buf);
  const fileName = midiPath.replace(/^.*[\\/]/, '');
  const flatNotes = flattenNotes(midi);

  if (flatNotes.length === 0) {
    midiLog('[MIDI] 错误: MIDI 文件中没有音符');
    flushLogs(config.outputPath);
    return;
  }

  // 2. 头部日志
  midiLog('[MIDI] ========================================');
  midiLog(`[MIDI] 开始弹奏: ${fileName}`);
  midiLog('[MIDI] ========================================');

  // 3. 创建计分引擎
  const scoring = new ScoringEngine({
    perfect: perfectMs,
    ok: windowMs,
  });

  // 初始游戏时间（模拟中与墙钟对齐，避免预滚动导致时间不同步）
  const firstNoteTime = flatNotes.length > 0
    ? Math.min(...flatNotes.map(n => n.time))
    : 0;
  const startGameSec = Math.max(0, firstNoteTime - 1.5);

  // 4. 构建引擎回调（Node 环境：只记日志，无音效/画面）
  const callbacks: MidiMatchCallbacks = {
    log: midiLog,
    onVisualUpdate() { /* no-op */ },
  };

  // 5. 创建匹配引擎
  const engine = new MidiMatchEngine(flatNotes, callbacks, {
    freePlay,
    speedMultiplier,
    hitWindowMs: windowMs,
    perfectMs,
    scoring,
    getHandForNote: (note) => assignHandForNote(note, midi),
    initialGameTimeSec: startGameSec,
  });

  // ── 构建事件时间线 ──
  // 每个音符有: press 事件 (note.time) 和 release 事件 (note.time + duration)
  // 跟弹模式: release 必须在同音下一个 press 前发生

  interface TimelineEvent {
    wallSec: number;
    type: 'release' | 'press';
    noteIdx: number;
  }

  const timeline: TimelineEvent[] = [];
  for (let i = 0; i < flatNotes.length; i++) {
    const n = flatNotes[i];
    timeline.push({ wallSec: n.time + offsetMs / 1000, type: 'press', noteIdx: i });
    timeline.push({ wallSec: n.time + Math.max(0, n.duration) + offsetMs / 1000, type: 'release', noteIdx: i });
  }

  // 按墙上时间排序，同时 release 先于 press
  timeline.sort((a, b) => {
    if (Math.abs(a.wallSec - b.wallSec) < 0.001) {
      if (a.type === 'release' && b.type === 'press') return -1;
      if (a.type === 'press' && b.type === 'release') return 1;
    }
    return a.wallSec - b.wallSec;
  });

  // ── 参数 ──
  const FRAME_SEC = 1 / 60;
  let simWallSec = startGameSec;  // 墙钟与游戏时间对齐

  // 初始化
  engine.processFrame(FRAME_SEC, simWallSec);

  // ── 主循环 ──
  let eventIdx = 0;
  while (eventIdx < timeline.length) {
    const ev = timeline[eventIdx];

    // 推进到事件时间
    while (simWallSec + FRAME_SEC < ev.wallSec) {
      simWallSec += FRAME_SEC;
      engine.processFrame(FRAME_SEC, simWallSec);
    }
    if (simWallSec < ev.wallSec) {
      const delta = ev.wallSec - simWallSec;
      simWallSec = ev.wallSec;
      engine.processFrame(delta, simWallSec);
    }

    // 处理该时间点的所有事件（按原始 .mjs 逻辑：release 只在已命中时才发送）
    const batchSec = ev.wallSec;
    while (eventIdx < timeline.length && Math.abs(timeline[eventIdx].wallSec - batchSec) < 0.001) {
      const e = timeline[eventIdx];
      const ns = flatNotes[e.noteIdx];

      if (e.type === 'release') {
        // 原始逻辑：仅已命中的音符才发送 release（未命中的 skip，由 miss 逻辑处理）
        const noteState = engine.noteStates[e.noteIdx];
        const nsi = e.noteIdx;
        if (noteState.isHit && !engine.missedNotes.has(nsi)) {
          const data = new Uint8Array([0x80, ns.midi, 0]);
          engine.processMidiEvent(data, simWallSec);
        }
      } else {
        // 发送 MIDI Note On
        const vel = Math.round(ns.velocity * 127);
        const data = new Uint8Array([0x90, ns.midi, vel]);
        engine.processMidiEvent(data, simWallSec);
      }

      eventIdx++;
    }

    // 事件后推进一帧
    simWallSec += FRAME_SEC;
    engine.processFrame(FRAME_SEC, simWallSec);
  }

  // 推进到结束
  simWallSec += 0.5;
  engine.processFrame(0.5, simWallSec);

  // ── 最终统计 ──
  const totalHit = engine.noteStates.filter(ns => ns.isHit && !engine.missedNotes.has(engine.noteStates.indexOf(ns))).length;
  const state = scoring.getState();

  midiLog('');
  midiLog('[MIDI] ========================================');
  midiLog(`[MIDI] 模拟结束: ${fileName}`);
  midiLog(`[MIDI] 命中: ${totalHit}/${flatNotes.length}`);
  midiLog(`[MIDI] PERFECT: ${state.counts.PERFECT}  OK: ${state.counts.OK}  BAD: ${state.counts.BAD}  MISS: ${state.counts.MISS}  错音: ${state.wrongKeys}`);

  const unhit = engine.noteStates
    .map((ns, i) => ({ ns, i }))
    .filter(({ ns, i }) => !ns.isHit && !engine.missedNotes.has(i));
  if (unhit.length > 0) {
    midiLog(`[MIDI] 未命中音符: ${unhit.length}`);
    for (const { ns, i } of unhit) {
      midiLog(`[MIDI]   idx=${i}  midi=${ns.note.midi}  time=${ns.note.time.toFixed(3)}s  dur=${ns.note.duration.toFixed(3)}s`);
    }
  }
  midiLog('[MIDI] ========================================');

  flushLogs(config.outputPath);
}

// ─── 入口 ────────────────────────────────────────────────────

const config = parseArgs();
simulate(config);
