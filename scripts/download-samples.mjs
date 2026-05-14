import { writeFileSync, mkdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'audio');
mkdirSync(outDir, { recursive: true });

// 改用 OGG 版本（浏览器解码更可靠）
const MIRRORS = [
  'https://gcore.jsdelivr.net/npm/@audio-samples/piano-velocity11@1.0.5/audio/',
  'https://fastly.jsdelivr.net/npm/@audio-samples/piano-velocity11@1.0.5/audio/',
  'https://cdn.jsdelivr.net/npm/@audio-samples/piano-velocity11@1.0.5/audio/',
];

const files = [
  'A0v11.ogg', 'C1v11.ogg', 'D#1v11.ogg', 'F#1v11.ogg', 'A1v11.ogg',
  'C2v11.ogg', 'D#2v11.ogg', 'F#2v11.ogg', 'A2v11.ogg',
  'C3v11.ogg', 'D#3v11.ogg', 'F#3v11.ogg', 'A3v11.ogg',
  'C4v11.ogg', 'D#4v11.ogg', 'F#4v11.ogg', 'A4v11.ogg',
  'C5v11.ogg', 'D#5v11.ogg', 'F#5v11.ogg', 'A5v11.ogg',
  'C6v11.ogg', 'D#6v11.ogg', 'F#6v11.ogg', 'A6v11.ogg',
  'C7v11.ogg', 'D#7v11.ogg', 'F#7v11.ogg', 'A7v11.ogg',
  'C8v11.ogg',
];

async function tryDownload(url, dest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return false;
    writeFileSync(dest, buf);
    return true;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

let ok = 0, fail = 0, skip = 0;

for (const f of files) {
  const dest = join(outDir, f);

  if (existsSync(dest)) {
    const size = statSync(dest).size;
    if (size > 1000) {
      skip++;
      console.log(`[${skip}] ${f} 已存在 (${(size / 1024).toFixed(0)}KB)，跳过`);
      continue;
    }
  }

  // # 号在 URL 中需编码为 %23
  const encodedName = f.replace(/#/g, '%23');
  let success = false;
  for (const mirror of MIRRORS) {
    const url = mirror + encodedName;
    const host = new URL(mirror).hostname;
    process.stdout.write(`[${ok + fail + skip + 1}/${files.length}] ${host}... `);
    if (await tryDownload(url, dest)) {
      const size = statSync(dest).size;
      console.log(`OK (${(size / 1024).toFixed(0)}KB)`);
      success = true;
      break;
    }
    console.log('失败');
  }

  if (success) ok++;
  else {
    fail++;
    console.error(`  ✗ ${f} - 所有镜像都失败`);
  }
}

console.log(`\n完成！${ok} 新下载, ${skip} 已存在跳过, ${fail} 失败`);
if (fail > 0) process.exit(1);
