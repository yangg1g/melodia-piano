/**
 * MIDI → JSON 转换脚本
 * 用法：node scripts/midi-to-json.mjs [input.mid] [output.json]
 *      或批量转换：node scripts/midi-to-json.mjs --dir songs/
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, extname, basename } from 'path';
import midiPkg from '@tonejs/midi';
const { Midi } = midiPkg;

// 音名转 VexFlow key（与 pitchUtil.ts 中 noteToVexKey 一致）
function noteToVexKey(note) {
  const names = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const oct = Math.floor(note.midi / 12) - 1;
  let name = names[note.midi % 12];
  if (!name) name = 'c';
  return `${name}/${oct}`;
}

function convertMidiToJson(midiPath, outputPath) {
  const buf = readFileSync(midiPath);
  const midi = new Midi(buf);

  const notes = [];
  midi.tracks.forEach((track, trackIndex) => {
    track.notes.forEach((n) => {
      notes.push({
        midi: n.midi,
        time: n.time,
        duration: n.duration,
        ticks: n.ticks,
        durationTicks: n.durationTicks,
        trackIndex,
        vexKey: noteToVexKey(n),
        velocity: n.velocity ?? 0.78,
      });
    });
  });

  // 按时间排序
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);

  const json = {
    version: 1,
    name: midi.name || basename(midiPath, extname(midiPath)),
    duration: midi.duration,
    durationTicks: midi.durationTicks,
    header: {
      tempos: midi.header.tempos.map(t => ({ bpm: t.bpm, ticks: t.ticks })),
      timeSignatures: midi.header.timeSignatures.map(ts => ({
        ticks: ts.ticks,
        timeSignature: ts.timeSignature,
        measures: ts.measures,
      })),
      ppq: midi.header.ppq,
    },
    trackCount: midi.tracks.length,
    tracksWithNotes: midi.tracks
      .map((t, i) => (t.notes.length > 0 ? i : -1))
      .filter(i => i >= 0),
    notes,
    noteCount: notes.length,
    // 预计算的音节信息
    minMidi: notes.length > 0 ? Math.min(...notes.map(n => n.midi)) : 60,
    maxMidi: notes.length > 0 ? Math.max(...notes.map(n => n.midi)) : 84,
  };

  writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf8');
  console.log(`✅ ${basename(midiPath)} → ${basename(outputPath)} (${notes.length} notes)`);
  return json;
}

function batchConvert(dir) {
  const files = readdirSync(dir).filter(f => /\.(mid|midi)$/i.test(f));
  const outDir = join(dir, 'json');
  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const input = join(dir, f);
    const output = join(outDir, basename(f, extname(f)) + '.json');
    convertMidiToJson(input, output);
  }
  console.log(`\n✅ 转换完成：${files.length} 个文件 → ${outDir}`);
}

// 命令行入口
const args = process.argv.slice(2);
if (args.includes('--dir')) {
  const dirIdx = args.indexOf('--dir');
  batchConvert(args[dirIdx + 1] || 'public/songs');
} else if (args.length >= 2) {
  convertMidiToJson(args[0], args[1]);
} else {
  console.log('用法:');
  console.log('  单文件: node scripts/midi-to-json.mjs input.mid output.json');
  console.log('  批量:   node scripts/midi-to-json.mjs --dir public/songs');
}
