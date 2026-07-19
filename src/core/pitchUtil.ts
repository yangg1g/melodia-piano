const NAME_RE = /^([A-Ga-g])([#b]{0,2})(-?\d+)$/;

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
