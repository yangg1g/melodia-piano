import { Midi } from '@tonejs/midi';

/** 内置示例：欢乐颂主题片段（C 大调） */
export function createDemoMidi(): Midi {
  const midi = new Midi();
  midi.header.setTempo(100);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });
  midi.header.update();

  const track = midi.addTrack();
  /** 100 BPM：四分音符 0.6s，八分 0.3s，十六分 0.15s；与拍对齐避免 clip 后出现非 16 分网格的时值 */
  const Q = 60 / 100;
  const E8 = Q / 2;
  const S16 = Q / 4;
  const DQ = Q * 1.5;
  const H = Q * 2;
  const phrase: { midi: number; duration: number }[] = [
    { midi: 48, duration: E8 },
    { midi: 64, duration: E8 },
    { midi: 64, duration: E8 },
    { midi: 65, duration: E8 },
    { midi: 67, duration: E8 },
    { midi: 67, duration: E8 },
    { midi: 65, duration: E8 },
    { midi: 64, duration: E8 },
    { midi: 62, duration: E8 },
    { midi: 60, duration: E8 },
    { midi: 60, duration: E8 },
    { midi: 62, duration: E8 },
    { midi: 64, duration: E8 },
    { midi: 64, duration: DQ },
    { midi: 62, duration: S16 },
    { midi: 62, duration: H },
    { midi: 64, duration: E8 },
    { midi: 64, duration: E8 },
    { midi: 65, duration: E8 },
    { midi: 67, duration: E8 },
    { midi: 67, duration: E8 },
    { midi: 65, duration: E8 },
    { midi: 64, duration: E8 },
    { midi: 62, duration: E8 },
    { midi: 60, duration: E8 },
    { midi: 60, duration: E8 },
    { midi: 62, duration: E8 },
    { midi: 64, duration: E8 },
    { midi: 62, duration: DQ },
    { midi: 60, duration: S16 },
    { midi: 60, duration: H },
  ];

  let time = 0;
  for (const n of phrase) {
    track.addNote({ midi: n.midi, time, duration: n.duration });
    time += n.duration;
  }
  return midi;
}
