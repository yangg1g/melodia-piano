/**
 * 和弦检测工具
 *
 * 根据一组 MIDI 音符号码识别和弦类型和根音。
 */

// 音符名（12 音阶）
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 和弦类型 → 中文名 */
const CHORD_NAMES_CN: Record<string, string> = {
  '':       '',
  'maj':    '大三',
  'm':      '小三',
  'dim':    '减三',
  'aug':    '增三',
  'sus4':   '挂四',
  'sus2':   '挂二',
  '5':      '强五',
  '7':      '属七',
  'm7':     '小七',
  'maj7':   '大七',
  'm7b5':   '半减七',
  'dim7':   '减七',
  'aug7':   '增七',
  '7sus4':  '属七挂四',
  '7sus2':  '属七挂二',
  'mMaj7':  '小大七',
  '6':      '大六',
  'm6':     '小六',
  '9':      '属九',
  'm9':     '小九',
  'maj9':   '大九',
  'add9':   '加九',
  'madd9':  '小加九',
};

/** 获取和弦类型的中文名 */
export function chordTypeToChinese(type: string): string {
  return CHORD_NAMES_CN[type] ?? type;
}

export interface ChordInfo {
  /** 根音 MIDI 音符号码 */
  rootMidi: number;
  /** 根音名（如 "C4", "F#3"） */
  rootName: string;
  /** 和弦类型（如 "maj", "m", "7", "m7", "dim", "aug", "sus4" 等） */
  type: string;
  /** 完整和弦名（如 "C4maj", "F#3m", "G47"） */
  fullName: string;
  /** 和弦类型中文名（如 "大三", "小三", "属七"） */
  cnName: string;
  /** 和弦中所有音的音名列表（含八度号） */
  noteNames: string[];
}

/**
 * 获取 MIDI 音高的音名（优先用升号表示）
 */
export function midiToNoteName(midi: number): string {
  const pc = midi % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pc]}${oct}`;
}

/**
 * 从当前按下的 MIDI 音符集合中检测和弦
 *
 * 支持的和弦类型（按优先级排列）：
 *   maj, m, dim, aug, sus4, sus2,
 *   7, m7, maj7, m7b5, dim7, aug7, 7sus4, 7sus2,
 *   6, m6, 9, m9, maj9,
 *   add9, madd9
 */
export function detectChord(midiNotes: Set<number>): ChordInfo | null {
  if (midiNotes.size === 0) return null;

  const sorted = [...midiNotes].sort((a, b) => a - b);
  const pitchClasses = new Set(sorted.map(n => n % 12));

  // 少于 2 个音时返回单个音的信息
  if (sorted.length < 2) {
    const midi = sorted[0];
    const name = midiToNoteName(midi);
    return {
      rootMidi: midi,
      rootName: name,
      type: '',
      fullName: name,
      cnName: '',
      noteNames: [name],
    };
  }

  // 尝试每个可能的根音
  let best: ChordInfo | null = null;
  let bestScore = 0;

  for (const root of pitchClasses) {
    // 将音符相对于根音标准化为 0-11 的半音间隔
    const intervals = new Set<number>();
    for (const pc of pitchClasses) {
      intervals.add((pc - root + 12) % 12);
    }

    // 按精度排序的和弦模板：越长的和弦模板优先级越高
    const chords = matchChordTemplates(intervals);
    for (const chord of chords) {
      const score = chord.matchCount * 100 + (chord.allMatched ? 50 : 0);
      if (score > bestScore) {
        const rootMidi = [...sorted].filter(n => n % 12 === root)[0] ?? sorted[0];
        const rootName = midiToNoteName(rootMidi);
        best = {
          rootMidi,
          rootName,
          type: chord.type,
          fullName: `${rootName}${chord.type}`,
          cnName: chordTypeToChinese(chord.type),
          noteNames: sorted.map(n => midiToNoteName(n)),
        };
        bestScore = score;
      }
    }
  }

  // 如果检测不到已知和弦，返回音名列表
  if (!best) {
    const names = sorted.map(n => midiToNoteName(n));
    return {
      rootMidi: sorted[0],
      rootName: names[0],
      type: '',
      fullName: names.join(' '),
      cnName: '',
      noteNames: names,
    };
  }

  return best;
}

interface ChordTemplate {
  type: string;
  intervals: number[];  // 必须包含的间隔
  optional?: number[];  // 可选间隔（如 add9 中的 9 音）
  bonus?: number[];     // 加分间隔（如 7 和弦中同时有 3 音和 5 音）
}

interface ChordMatch {
  type: string;
  matchCount: number;
  allMatched: boolean;
}

const CHORD_TEMPLATES: ChordTemplate[] = [
  // 三和弦
  { type: 'maj',    intervals: [0, 4, 7] },
  { type: 'm',      intervals: [0, 3, 7] },
  { type: 'dim',    intervals: [0, 3, 6] },
  { type: 'aug',    intervals: [0, 4, 8] },
  { type: 'sus4',   intervals: [0, 5, 7] },
  { type: 'sus2',   intervals: [0, 2, 7] },

  // 七和弦
  { type: '7',      intervals: [0, 4, 7, 10] },
  { type: 'm7',     intervals: [0, 3, 7, 10] },
  { type: 'maj7',   intervals: [0, 4, 7, 11] },
  { type: 'm7b5',   intervals: [0, 3, 6, 10] },
  { type: 'dim7',   intervals: [0, 3, 6, 9] },
  { type: 'aug7',   intervals: [0, 4, 8, 10] },
  { type: '7sus4',  intervals: [0, 5, 7, 10] },
  { type: '7sus2',  intervals: [0, 2, 7, 10] },
  { type: 'mMaj7',  intervals: [0, 3, 7, 11] },

  // 六和弦
  { type: '6',      intervals: [0, 4, 7, 9] },
  { type: 'm6',     intervals: [0, 3, 7, 9] },

  // 九和弦（可能包含省略音）
  { type: '9',      intervals: [0, 4, 7, 10], optional: [2] },
  { type: 'm9',     intervals: [0, 3, 7, 10], optional: [2] },
  { type: 'maj9',   intervals: [0, 4, 7, 11], optional: [2] },

  // Add 和弦
  { type: 'add9',   intervals: [0, 4, 7, 2] },
  { type: 'madd9',  intervals: [0, 3, 7, 2] },

  // 五度（仅根音和五度）
  { type: '5',      intervals: [0, 7] },
];

function matchChordTemplates(presentIntervals: Set<number>): ChordMatch[] {
  const results: ChordMatch[] = [];

  for (const template of CHORD_TEMPLATES) {
    const required = template.intervals;
    const optional = template.optional ?? [];

    let matchCount = 0;
    for (const iv of required) {
      if (presentIntervals.has(iv)) matchCount++;
    }

    // 必须匹配至少所有必需间隔
    const allRequired = matchCount === required.length;

    let optCount = 0;
    for (const iv of optional) {
      if (presentIntervals.has(iv)) optCount++;
    }

    if (allRequired) {
      results.push({
        type: template.type,
        matchCount: matchCount + optCount,
        allMatched: presentIntervals.size === required.length + optCount,
      });
    }
  }

  return results;
}
