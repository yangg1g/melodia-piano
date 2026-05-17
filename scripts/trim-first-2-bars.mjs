/**
 * 截取 MIDI 文件前两小节，保存为新文件
 * 用法：node scripts/trim-first-2-bars.mjs "public/songs/致爱丽丝 - 贝多芬.mid"
 */
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcArg = process.argv[2];
if (!srcArg) {
  console.error('用法: node scripts/trim-first-2-bars.mjs <midi文件路径>');
  process.exit(1);
}

const srcPath = join(__dirname, '..', srcArg);
if (!existsSync(srcPath)) {
  console.error('文件不存在:', srcPath);
  process.exit(1);
}

const src = readFileSync(srcPath);
const midi = new Midi(new Uint8Array(src).buffer);

const ppq = midi.header.ppq || 480;
const ts = midi.header.timeSignatures[0] || { timeSignature: [4, 4] };
const [num, denom] = ts.timeSignature;

// 前两小节的 tick
const ticksPerMeasure = ppq * num * (4 / denom);
const cutoff = ticksPerMeasure * 2;

// 直接在原 MIDI 上修改（保留原始 PPQ、tempo 等信息）
midi.tracks.forEach((track) => {
  track.notes = track.notes.filter((n) => n.ticks < cutoff);
});

const base = srcArg.replace(/\.(mid|midi)$/i, '');
const dst = join(__dirname, '..', `${base} - 前两小节.mid`);
writeFileSync(dst, Buffer.from(midi.toArray()));
console.log('已生成:', dst);
