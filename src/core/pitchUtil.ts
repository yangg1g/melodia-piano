const NAME_RE = /^([A-Ga-g])([#b]{0,2})(-?\d+)$/;

/** 音名 → 颜色映射（忽略升降号，只按基本音名着色） */
export const NOTE_COLORS: Record<string, string> = {
  c: '#e53935', // Red
  d: '#fb8c00', // Orange
  e: '#43a047', // Green
  f: '#1e88e5', // Blue
  g: '#8e24aa', // Purple
  a: '#fdd835', // Yellow
  b: '#00acc1', // Cyan
};

/** 从 VexKey（如 "eb/4"）中提取基本音名并返回对应颜色 */
export function colorForVexKey(vexKey: string): string {
  const letter = vexKey.charAt(0).toLowerCase();
  return NOTE_COLORS[letter] ?? '#000000';
}

/** Tone.js 科学音高（如 Eb4）→ VexFlow 键位（如 eb/4） */
export function toneNameToVexKey(scientific: string): string {
  const m = scientific.trim().match(NAME_RE);
  if (!m) return 'c/4';
  const letter = m[1].toLowerCase();
  const acc = m[2].toLowerCase().replaceAll('#', '#').replaceAll('b', 'b');
  const oct = m[3];
  return `${letter}${acc}/${oct}`;
}

export function noteToVexKey(note: { name: string }): string {
  return toneNameToVexKey(note.name);
}
