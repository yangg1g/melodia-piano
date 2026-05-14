/**
 * MIDI 钢琴难度计算器
 * 参考 osu!mania DifficultyCalculator / Strain / StrainDecaySkill 算法，
 * 将 88 键钢琴按八度分为 8 个"轨道列"，计算单列与全局 strain，最终得出 StarRating。
 *
 * 用法：node scripts/calculate-difficulty.mjs
 * 输出：public/songs/*.mid.json  (每个 MIDI 文件对应的难度元数据)
 */
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SONGS_DIR = join(__dirname, '..', 'public', 'songs');

/* ── 参数（来自 osu!mania） ── */
const DIFFICULTY_MULTIPLIER = 0.001;
const INDIVIDUAL_DECAY_BASE = 0.125;
const OVERALL_DECAY_BASE = 0.30;
const SECTION_LENGTH = 400; // ms
const DECAY_WEIGHT = 0.9;
const COLUMNS = 8; // 每八度一列

/** 将 MIDI 音高映射到列索引 (0 ~ COLUMNS-1) */
function midiToColumn(midi) {
  return Math.min(COLUMNS - 1, Math.max(0, Math.floor(midi / 12)));
}

/** 指数衰减：value * base^(deltaMs / 1000) */
function applyDecay(value, deltaMs, base) {
  return value * Math.pow(base, deltaMs / 1000);
}

/** Logistic 函数（来自 osu!mania Strain.cs） */
function logistic(x, multiplier, midpointOffset) {
  if (x === 0) return 0;
  return 2 / (1 + Math.exp(-multiplier * Math.abs(x - midpointOffset))) - 1;
}

/**
 * 计算单个 MIDI 文件的难度
 */
function calculateDifficulty(midiBytes) {
  const midi = new Midi(midiBytes);

  // 收集所有音符并排序
  const notes = [];
  let totalNoteCount = 0;

  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        midi: n.midi,
        time: n.time,
        duration: n.duration,
        velocity: n.velocity ?? 0.78,
      });
      totalNoteCount++;
    }
  }
  notes.sort((a, b) => a.time - b.time);

  if (notes.length === 0) {
    return { starRating: 0, noteCount: 0, bpm: 120, durationSec: 0 };
  }

  // 每列的状态（时间 + 累积 strain）
  const startTimes = new Array(COLUMNS).fill(0);
  const endTimes = new Array(COLUMNS).fill(0);
  const individualStrains = new Array(COLUMNS).fill(0);

  let overallStrain = 1;
  let currentSectionPeak = 0;
  let currentSectionEnd = SECTION_LENGTH;
  const strainPeaks = [];

  function timeToMs(t) { return t * 1000; }

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const col = midiToColumn(n.midi);
    const startMs = timeToMs(n.time);
    const endMs = timeToMs(n.time + n.duration);

    const prev = i > 0 ? notes[i - 1] : null;
    const deltaMs = prev ? startMs - timeToMs(prev.time) : 1000;

    // 应用衰减
    individualStrains[col] = applyDecay(individualStrains[col], deltaMs, INDIVIDUAL_DECAY_BASE);
    overallStrain = applyDecay(overallStrain, deltaMs, OVERALL_DECAY_BASE);

    // holdFactor 和 holdAddition
    let holdFactor = 1;
    let holdAddition = 0;

    if (prev && startTimes[col] > 0) {
      const prevStart = startTimes[col];
      const prevEnd = endTimes[col];

      const isOverlapping = prevEnd > startMs && endMs > prevEnd && startMs > prevStart;
      const isHoldNested = prevEnd > endMs && startMs > prevStart;

      if (isOverlapping) {
        let closestEndDiff = Infinity;
        for (let c = 0; c < COLUMNS; c++) {
          if (c === col || endTimes[c] === 0) continue;
          const diff = Math.abs(endMs - endTimes[c]);
          if (diff < closestEndDiff) closestEndDiff = diff;
        }
        if (closestEndDiff < Infinity) {
          holdAddition = logistic(closestEndDiff, 0.27, 30);
        }
      }

      if (isHoldNested) {
        holdFactor = 1.25;
      }
    }

    startTimes[col] = startMs;
    if (n.duration > 0) endTimes[col] = endMs;

    // 个体 strain
    individualStrains[col] += 2.0 * holdFactor;

    // 和弦处理：同时按下的音符取最大值
    if (deltaMs <= 1) {
      let maxIndividual = 0;
      for (let c = 0; c < COLUMNS; c++) {
        if (individualStrains[c] > maxIndividual) maxIndividual = individualStrains[c];
      }
      for (let c = 0; c < COLUMNS; c++) {
        individualStrains[c] = maxIndividual;
      }
    }

    // 全局 strain
    overallStrain += (1 + holdAddition) * holdFactor;

    // Strain 贡献值
    const currentIndividual = Math.max(...individualStrains);
    const strainValue = currentIndividual + overallStrain;

    // 分节记录峰值
    if (startMs >= currentSectionEnd) {
      strainPeaks.push(currentSectionPeak);
      currentSectionEnd += SECTION_LENGTH;
      currentSectionPeak = 0;
    }
    if (strainValue > currentSectionPeak) {
      currentSectionPeak = strainValue;
    }
  }

  if (currentSectionPeak > 0) {
    strainPeaks.push(currentSectionPeak);
  }

  // 加权求和得 StarRating
  const sorted = [...strainPeaks].sort((a, b) => b - a);
  let weighted = 0;
  let weight = 1;
  for (const peak of sorted) {
    if (peak <= 0) break;
    weighted += peak * weight;
    weight *= DECAY_WEIGHT;
  }

  const starRating = Math.round(weighted * DIFFICULTY_MULTIPLIER * 100) / 100;

  // 获取 BPM
  let bpm = 120;
  try {
    if (midi.header.tempos.length > 0) {
      bpm = Math.round(midi.header.tempos[0].bpm);
    }
  } catch { /* ignore */ }

  const durationSec = Math.round(midi.duration * 10) / 10;

  return { starRating, noteCount: totalNoteCount, bpm, durationSec };
}

/* ── 批量处理 ── */

function main() {
  if (!existsSync(SONGS_DIR)) {
    console.error('未找到 songs 目录:', SONGS_DIR);
    process.exit(1);
  }

  const files = readdirSync(SONGS_DIR).filter(
    (f) => f.toLowerCase().endsWith('.mid') || f.toLowerCase().endsWith('.midi'),
  );

  if (files.length === 0) {
    console.log('没有 .mid 文件需要处理');
    process.exit(0);
  }

  let ok = 0, fail = 0;

  for (const f of files) {
    const midiPath = join(SONGS_DIR, f);
    const jsonPath = join(SONGS_DIR, f + '.json');
    try {
      const buf = new Uint8Array(readFileSync(midiPath)).buffer;
      const diff = calculateDifficulty(buf);
      writeFileSync(jsonPath, JSON.stringify(diff, null, 2));
      console.log(`  ${f}: ★${diff.starRating.toFixed(2)}  (${diff.noteCount} 音符, ${diff.bpm}BPM)`);
      ok++;
    } catch (err) {
      console.error(`  ${f}: 计算失败 -`, err);
      fail++;
    }
  }

  console.log(`\n完成：${ok} 成功, ${fail} 失败`);
}

main();
