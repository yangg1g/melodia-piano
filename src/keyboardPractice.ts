import type { Midi } from '@tonejs/midi';
import type { KeyboardFallingState } from './fallingNotes';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { applyKeyVisuals } from './pianoKeyboard';
import type { PlaybackController } from './playback';
import { playPianoMidi, releaseAllPiano } from './salamanderPiano';

function groupByStartTick(notes: FlatNote[]): FlatNote[][] {
  const sorted = [...notes].sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
  const groups: FlatNote[][] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (!g || g[0].ticks !== n.ticks) groups.push([n]);
    else g.push(n);
  }
  return groups;
}

function requiredHitCounts(group: FlatNote[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const n of group) {
    m.set(n.midi, (m.get(n.midi) ?? 0) + 1);
  }
  return m;
}

function countsSatisfied(required: Map<number, number>, hit: Map<number, number>): boolean {
  for (const [midi, need] of required) {
    if ((hit.get(midi) ?? 0) < need) return false;
  }
  return true;
}

function parseMidiKey(data: Uint8Array): { note: number; down: boolean } | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    return { note: data[1], down: vel > 0 };
  }
  if (st >= 0x80 && st < 0x90) {
    return { note: data[1], down: false };
  }
  return null;
}

function parseNoteOn(data: Uint8Array): number | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    if (vel > 0) return data[1];
  }
  return null;
}

function handsMapForGroup(group: FlatNote[], midiFile: Midi): Map<number, Hand> {
  const m = new Map<number, Hand>();
  for (const n of group) {
    m.set(n.midi, assignHandForNote(n, midiFile));
  }
  return m;
}

/**
 * 同一 tick 为一组；弹对、弹错均发声（Salamander 采样钢琴），仅整组弹对后闪动并前进。
 */
export function startKeyboardPractice(
  flatNotes: FlatNote[],
  midiFile: Midi,
  keyEls: Map<number, HTMLElement>,
  midiInput: MIDIInput,
  onEnded?: () => void,
  onTimeSec?: (sec: number) => void,
  onPracticePaint?: (state: KeyboardFallingState) => void,
): PlaybackController {
  const groups = groupByStartTick(flatNotes);
  let stopped = false;
  let step = 0;
  const hit = new Map<number, number>();
  const pressedMidis = new Set<number>();
  let flashActive: Map<number, Hand> | null = null;
  let pendingUi: ReturnType<typeof setTimeout> | null = null;

  const clearPendingUi = () => {
    if (pendingUi !== null) {
      clearTimeout(pendingUi);
      pendingUi = null;
    }
  };

  const paint = () => {
    const expected = new Map<number, Hand>();
    if (step < groups.length) {
      for (const n of groups[step]) {
        expected.set(n.midi, assignHandForNote(n, midiFile));
      }
    }
    applyKeyVisuals(keyEls, {
      expected,
      active: flashActive ?? undefined,
      pressed: pressedMidis,
    });
    onPracticePaint?.({
      step,
      group: step < groups.length ? groups[step] : [],
      hit: new Map(hit),
      groupCompleteFlash: flashActive !== null,
    });
  };

  const applyUiForStep = () => {
    if (stopped) return;
    if (step >= groups.length) {
      pressedMidis.clear();
      flashActive = null;
      applyKeyVisuals(keyEls, {});
      onPracticePaint?.({
        step,
        group: [],
        hit: new Map(),
        groupCompleteFlash: false,
      });
      onTimeSec?.(flatNotes.length ? Math.max(...flatNotes.map((n) => n.time + n.duration)) : 0);
      finish();
      return;
    }
    hit.clear();
    flashActive = null;
    onTimeSec?.(groups[step][0].time);
    paint();
  };

  const finish = () => {
    if (stopped) return;
    clearPendingUi();
    stopped = true;
    midiInput.onmidimessage = null;
    pressedMidis.clear();
    flashActive = null;
    applyKeyVisuals(keyEls, {});
    onPracticePaint?.({
      step: groups.length,
      group: [],
      hit: new Map(),
      groupCompleteFlash: false,
    });
    releaseAllPiano();
    onEnded?.();
  };

  const onMidi = (ev: MIDIMessageEvent) => {
    if (stopped) return;
    const data = ev.data;
    if (!data || data.length < 3) return;

    const keyEv = parseMidiKey(data);
    if (keyEv && keyEls.has(keyEv.note)) {
      if (keyEv.down) pressedMidis.add(keyEv.note);
      else pressedMidis.delete(keyEv.note);
      paint();
    }

    if (flashActive !== null) return;

    const note = parseNoteOn(data);
    if (note === null) return;
    if (step >= groups.length) return;

    const g = groups[step];
    const req = requiredHitCounts(g);
    const need = req.get(note);
    if (need === undefined) {
      playPianoMidi(note, 0.12, 0.42);
      return;
    }

    const cur = hit.get(note) ?? 0;
    if (cur >= need) {
      playPianoMidi(note, 0.12, 0.42);
      return;
    }
    const sameMidi = g.filter((n) => n.midi === note);
    const flatForHit = sameMidi[cur];
    if (flatForHit) playPianoMidi(flatForHit.midi, Math.max(0, flatForHit.duration), 0.82);
    hit.set(note, cur + 1);

    if (countsSatisfied(req, hit)) {
      flashActive = handsMapForGroup(g, midiFile);
      hit.clear();
      paint();
      clearPendingUi();
      pendingUi = window.setTimeout(() => {
        pendingUi = null;
        if (stopped) return;
        flashActive = null;
        step += 1;
        applyUiForStep();
      }, 120);
    }
  };

  midiInput.onmidimessage = onMidi;
  applyUiForStep();

  return {
    stop: () => {
      if (stopped) return;
      clearPendingUi();
      stopped = true;
      midiInput.onmidimessage = null;
      pressedMidis.clear();
      flashActive = null;
      applyKeyVisuals(keyEls, {});
      onPracticePaint?.({
        step: groups.length,
        group: [],
        hit: new Map(),
        groupCompleteFlash: false,
      });
      releaseAllPiano();
    },
    isPlaying: () => !stopped,
  };
}
