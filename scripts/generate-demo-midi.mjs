/**
 * 生成一个示例 MIDI 文件（欢乐颂片段）到 public/songs/
 * 运行：node scripts/generate-demo-midi.mjs
 */
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const midi = new Midi();
midi.header.setTempo(100);
midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });

const track = midi.addTrack();
track.name = 'Piano';

// 欢乐颂旋律（C 大调）
const notes = [
  { midi: 64, time: 0, dur: 0.4 },
  { midi: 64, time: 0.5, dur: 0.4 },
  { midi: 65, time: 1.0, dur: 0.4 },
  { midi: 67, time: 1.5, dur: 0.4 },
  { midi: 67, time: 2.0, dur: 0.4 },
  { midi: 65, time: 2.5, dur: 0.4 },
  { midi: 64, time: 3.0, dur: 0.4 },
  { midi: 62, time: 3.5, dur: 0.4 },
  { midi: 60, time: 4.0, dur: 0.4 },
  { midi: 62, time: 4.5, dur: 0.4 },
  { midi: 64, time: 5.0, dur: 0.6 },
  { midi: 64, time: 5.75, dur: 0.6 },
  { midi: 62, time: 6.5, dur: 0.4 },
  { midi: 62, time: 7.0, dur: 0.4 },
  { midi: 64, time: 7.5, dur: 0.4 },
  { midi: 62, time: 8.0, dur: 0.4 },
  { midi: 60, time: 8.5, dur: 0.8 },
];

for (const n of notes) {
  track.addNote({
    midi: n.midi,
    time: n.time,
    duration: n.dur,
    velocity: 0.8,
  });
}

const outPath = join(__dirname, '..', 'public', 'songs', '欢乐颂-demo.mid');
writeFileSync(outPath, Buffer.from(midi.toArray()));
console.log(`已生成: ${outPath}`);
