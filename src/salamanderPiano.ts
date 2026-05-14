import { Sampler, start, now, ToneAudioBuffer } from 'tone';

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

function midiToNote(midi: number): string {
  return NOTES[midi % 12] + (Math.floor(midi / 12) - 1);
}

/**
 * 构建采样 URL 映射：样本文件名 → 音名
 * 每个八度提供了 C、D#、F#、A 四个键的采样（0 八度仅有 A0，8 八度仅有 C8）。
 * 未采样的音会自动由相邻样本变速拉伸得到。
 */
function buildSampleMap(): Record<string, string> {
  const map: Record<string, string> = {};
  map['A0'] = '/audio/A0v11.mp3';
  const sampleNotes = ['C', 'D#', 'F#', 'A'];
  for (let octave = 1; octave <= 7; octave++) {
    for (const name of sampleNotes) {
      map[`${name}${octave}`] = `/audio/${name}${octave}v11.mp3`;
    }
  }
  map['C8'] = '/audio/C8v11.mp3';
  return map;
}

let sampler: Sampler | null = null;
let initPromise: Promise<void> | null = null;

function formatFailed(
  results: PromiseSettledResult<{ note: string; buffer: ToneAudioBuffer }>[],
  entries: [string, string][],
): string {
  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      const [note, url] = entries[i];
      const msg = (results[i].reason as Error)?.message ?? String(results[i].reason);
      lines.push(`  ${note} (${url}): ${msg}`);
    }
  }
  return lines.join('\n');
}

/**
 * 用 ToneAudioBuffer 手动预加载所有样本，Promise 精确控制完成时机。
 * 15 秒超时兜底并允许重试，防止 onload 永不触发导致死锁。
 */
export function preloadPiano(): Promise<void> {
  if (initPromise) return initPromise;

  const urlMap = buildSampleMap();
  const entries = Object.entries(urlMap);

  const loadPromise = start().then(async () => {
    // 每个样本独立加载，用 allSettled 收集所有结果
    const results = await Promise.allSettled(
      entries.map(async ([note, url]) => {
        const buf = new ToneAudioBuffer();
        await buf.load(url);
        return { note, buffer: buf };
      }),
    );

    // 区分成功与失败
    const loaded: Record<string, ToneAudioBuffer> = {};
    for (const r of results) {
      if (r.status === 'fulfilled') {
        loaded[r.value.note] = r.value.buffer;
      }
    }

    const nLoaded = Object.keys(loaded).length;
    const nFailed = entries.length - nLoaded;

    if (nLoaded === 0) {
      throw new Error(`所有 ${entries.length} 个采样加载失败：\n${formatFailed(results, entries)}`);
    }

    sampler = new Sampler(loaded).toDestination();
    sampler.volume.value = -4;

    if (nFailed > 0) {
      const detail = formatFailed(results, entries);
      console.warn(`[salamanderPiano] ${nFailed}/${entries.length} 个采样失败：\n${detail}`);
    } else {
      console.log(`[salamanderPiano] ${entries.length} 个采样加载完成`);
    }
  });

  // 超时兜底
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      const detail = entries.map(([note, url]) => `  ${note} -> ${url}`).join('\n');
      reject(new Error(`采样加载超时(15s)\n等待中的文件：\n${detail}`));
    }, 15000);
  });

  initPromise = Promise.race([loadPromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId!);
  }).catch((err: unknown) => {
    console.error('[salamanderPiano] 加载失败:', err);
    initPromise = null; // 允许重试
    throw err;
  });

  return initPromise;
}

export async function ensureSalamanderPiano(): Promise<void> {
  await preloadPiano();
}

/** 记录当前正在发声的音名，供 releaseAll 使用 */
const activeNotes = new Set<string>();

export function playPianoMidi(midi: number, durationSec: number, velocity: number): void {
  if (!sampler) return;
  const dur = Math.max(1e-4, durationSec);
  const noteName = midiToNote(midi);
  activeNotes.add(noteName);
  sampler.triggerAttackRelease(noteName, dur, now(), velocity);
  setTimeout(() => activeNotes.delete(noteName), (dur + 0.05) * 1000);
}

export function releaseAllPiano(): void {
  if (!sampler) return;
  for (const note of activeNotes) {
    sampler.triggerRelease(note, now());
  }
  activeNotes.clear();
}
