// Regression suite for js/core.js, mirroring CoreTests.cs and PetBridgeTests.cs.
// Run with: node js/test-core.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PlaybackSelector, ShuffleBag, ReplyPicker, CancellationLog,
  shouldReply, startedEvent, stoppedEvent, replyAt, replyDelaySeconds,
  clampSize, SHORT_REPLY_IDS, MAX_HOP,
} from "./core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(here, "..", "assets", "pets.json"), "utf8"));
const byId = Object.fromEntries(catalog.pets.map((pet) => [pet.id, pet]));
const shaolan = byId.shaolan;
const sunpet = byId.sunpet;
const fengge = byId.fengge;

let failures = 0;
let checks = 0;

function check(valid, name) {
  checks++;
  if (!valid) {
    failures++;
    console.error("FAIL " + name);
  }
}

// Deterministic RNG so a failure is reproducible.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- catalog sanity
check(shaolan.clipCount === 37, "shaolan ships all 37 clips");
check(sunpet.clipCount === 28, "sunpet ships all 28 clips");
check(fengge.clipCount === 11, "fengge ships all 11 clips");
check(shaolan.defaultOnCount === 8, "shaolan enables exactly 8 clips by default");
check(sunpet.defaultOnCount === 28 && fengge.defaultOnCount === 11, "sunpet and fengge enable every clip");

for (const pet of catalog.pets) {
  for (const clip of pet.clips) {
    check(
      clip.duration > 0.25 &&
      clip.speechStart >= 0 &&
      clip.speechEnd > clip.speechStart &&
      clip.speechEnd <= clip.duration + 0.001,
      pet.id + " clip " + clip.id + " has a sane duration and speech window"
    );
  }
  const files = new Set(pet.clips.map((clip) => clip.file));
  check(files.size === pet.clips.length, pet.id + " clip filenames are unique");
}

// ---------------------------------------------------------------- ShuffleBag
{
  const bag = new ShuffleBag(rng(20261024));
  let last = -1;
  let valid = true;
  for (let cycle = 0; cycle < 1000; cycle++) {
    const used = new Set();
    for (let i = 0; i < 37; i++) {
      const value = bag.next(37);
      valid = valid && value >= 0 && value < 37 && value !== last && !used.has(value);
      used.add(value);
      last = value;
    }
  }
  check(valid, "1000 shuffle rounds: unique per round and no boundary repetition");
  check(bag.next(0) === -1 && bag.next(-1) === -1, "empty shuffle is safe");
  check(bag.next(1) === 0 && bag.next(1) === 0, "single-item shuffle is safe");
  const resized = new Set([bag.next(3), bag.next(3), bag.next(3)]);
  check(resized.size === 3, "changing the item count rebuilds the queue");
}

// ---------------------------------------------------------------- default pool
{
  const settings = { excludedIds: null, pinnedId: 0, randomMode: true, volume: 0.65 };
  const selector = new PlaybackSelector(shaolan.clips, settings, rng(87));
  check(selector.allowedCount === 8, "first launch applies exactly the 8 catalog defaults");
  check(settings.excludedIds.length === 29, "first launch persists 29 exclusions");
  const defaultIds = shaolan.clips.filter((clip) => !clip.defaultOff).map((clip) => clip.id);
  const pool = new Set();
  for (let i = 0; i < 8; i++) pool.add(selector.randomOnce().id);
  check(pool.size === 8 && [...pool].every((id) => defaultIds.includes(id)), "default rounds draw exactly the 8 enabled clips");
}

// Re-run the strict version without per-sample assertions.
{
  const settings = { excludedIds: null, pinnedId: 0, randomMode: true, volume: 0.65 };
  const selector = new PlaybackSelector(shaolan.clips, settings, rng(91));
  const defaults = shaolan.clips.filter((clip) => !clip.defaultOff).map((clip) => clip.id);
  let valid = true;
  let previous = -1;
  for (let round = 0; round < 1000; round++) {
    const used = new Set();
    for (let i = 0; i < defaults.length; i++) {
      const clip = selector.randomOnce();
      valid = valid && clip.id !== previous && used.add(clip.id);
      previous = clip.id;
    }
    valid = valid && used.size === defaults.length && [...used].every((id) => defaults.includes(id));
  }
  check(valid, "1000 default rounds: exact 8 clips and no boundary repetition");

  selector.enableAll();
  check(selector.allowedCount === 37 && settings.excludedIds.length === 0, "enable all restores 37 clips");

  selector.setRandomMode(false);
  check(selector.pinnedClip !== null && selector.pinnedClip.id === previous, "fixed mode pins the last played clip");
  let fixedValid = true;
  for (let i = 0; i < 30; i++) fixedValid = fixedValid && selector.next().id === previous;
  check(fixedValid, "fixed mode repeats the pinned clip");

  const chosen = selector.choose(shaolan.clips[2].id);
  check(chosen.id === shaolan.clips[2].id && selector.pinnedClip.id === chosen.id, "manual choice updates the fixed pin");

  const pinned = chosen.id;
  selector.setRandomMode(true);
  selector.choose(shaolan.clips[4].id);
  check(selector.pinnedClip.id === pinned && settings.randomMode, "manual choice in random mode preserves the saved pin");

  selector.toggleExcluded(shaolan.clips[0].id);
  selector.toggleExcluded(shaolan.clips[1].id);
  let filterValid = selector.allowedCount === 35;
  for (let i = 0; i < 300; i++) {
    const id = selector.randomOnce().id;
    filterValid = filterValid && id !== shaolan.clips[0].id && id !== shaolan.clips[1].id;
  }
  check(filterValid, "excluded clips leave random playback immediately");

  selector.setRandomMode(false);
  selector.choose(shaolan.clips[0].id);
  check(selector.next().id === shaolan.clips[0].id && selector.isExcluded(shaolan.clips[0].id),
    "fixed and manual playback can intentionally play an excluded random clip");

  selector.enableAll();
  for (let i = 0; i < 36; i++) selector.toggleExcluded(shaolan.clips[i].id);
  check(selector.allowedCount === 1 && !selector.toggleExcluded(shaolan.clips[36].id),
    "the last available random clip cannot be excluded");
  let singleValid = true;
  for (let i = 0; i < 10; i++) singleValid = singleValid && selector.randomOnce().id === shaolan.clips[36].id;
  check(singleValid, "a single remaining random clip always plays");

  check(!selector.toggleExcluded(-123) && selector.choose(-123) === null, "invalid clip ids are rejected");

  settings.excludedIds = shaolan.clips.map((clip) => clip.id);
  settings.pinnedId = 99999;
  settings.randomMode = false;
  selector.validate();
  check(selector.allowedCount === 8 && settings.randomMode && selector.pinnedClip === null,
    "a fully excluded catalog with an invalid pin recovers to the default 8");

  settings.excludedIds = [shaolan.clips[0].id, shaolan.clips[0].id, -55, 99999];
  selector.validate();
  check(selector.allowedCount === 36 && settings.excludedIds.length === 1, "duplicate and unknown exclusions are cleaned");

  settings.excludedIds = null;
  selector.validate();
  check(selector.allowedCount === 8, "null exclusions reapply the catalog defaults");

  let rejectedEmpty = false;
  try { new PlaybackSelector([], { excludedIds: null, pinnedId: 0, randomMode: true }); } catch { rejectedEmpty = true; }
  check(rejectedEmpty, "an empty catalog is rejected");

  const single = new PlaybackSelector(
    [{ id: 101, label: "one", defaultOff: true, duration: 1, speechStart: 0, speechEnd: 1 }],
    { excludedIds: null, pinnedId: 0, randomMode: true }
  );
  check(single.allowedCount === 1 && single.next().id === 101 && !single.toggleExcluded(101),
    "a one-clip all-default-off catalog stays playable and cannot be fully excluded");

  const allOn = new PlaybackSelector(sunpet.clips, { excludedIds: null, pinnedId: 0, randomMode: true });
  check(allOn.allowedCount === 28, "sunpet defaults to every clip");
  const allExcluded = new PlaybackSelector(sunpet.clips, { excludedIds: sunpet.clips.map((c) => c.id), pinnedId: 0, randomMode: true });
  check(allExcluded.allowedCount === 28, "sunpet never ends up with zero playable clips");
}

// ---------------------------------------------------------------- chain rules
{
  const root = startedEvent("shaolan", shaolan.clips[0]);
  check(root.hop === 0 && root.rootRole === "shaolan" && root.chainId === root.eventId, "a new chain starts at hop 0");
  check(shouldReply("sunpet", root), "shaolan is answered by sunpet");
  check(!shouldReply("fengge", root), "fengge never answers shaolan directly");
  check(!shouldReply("shaolan", root), "shaolan only starts chains, it never answers");

  const second = startedEvent("sunpet", sunpet.clips[0], root);
  check(second.hop === 1 && second.chainId === root.chainId && second.rootRole === "shaolan", "hop 1 keeps the chain identity");
  check(shouldReply("fengge", second), "sunpet is answered by fengge");
  check(!shouldReply("sunpet", second), "sunpet does not answer itself");

  const third = startedEvent("fengge", fengge.clips[0], second);
  check(third.hop === 2, "hop 2 reaches fengge");
  check(shouldReply("sunpet", third), "fengge is answered by sunpet at the end of a shaolan chain");
  check(!shouldReply("fengge", third), "fengge does not answer itself");

  const fourth = startedEvent("sunpet", sunpet.clips[0], third);
  check(fourth.hop === 3 && fourth.hop === MAX_HOP, "hop 3 is the last link");
  check(!shouldReply("shaolan", fourth) && !shouldReply("sunpet", fourth) && !shouldReply("fengge", fourth),
    "the fourth sentence ends the conversation");

  let exceeded = false;
  try { startedEvent("sunpet", sunpet.clips[0], fourth); } catch { exceeded = true; }
  check(exceeded, "a fifth sentence is refused");

  const fenggeRoot = startedEvent("fengge", fengge.clips[0]);
  check(shouldReply("sunpet", fenggeRoot), "a fengge chain is answered by sunpet");
  check(!shouldReply("fengge", fenggeRoot), "fengge is not answered by itself");
  const fenggeAnswer = startedEvent("sunpet", sunpet.clips[0], fenggeRoot);
  check(fenggeAnswer.hop === 1 && !shouldReply("fengge", fenggeAnswer), "a fengge chain stops after one answer");

  const sunpetRoot = startedEvent("sunpet", sunpet.clips[0]);
  check(!shouldReply("fengge", sunpetRoot) && !shouldReply("sunpet", sunpetRoot) && !shouldReply("shaolan", sunpetRoot),
    "a sunpet chain plays alone");
}

// ---------------------------------------------------------------- cancellation
{
  const log = new CancellationLog();
  const root = startedEvent("shaolan", shaolan.clips[0]);
  const second = startedEvent("sunpet", sunpet.clips[0], root);
  log.recordStopped(stoppedEvent(second, 0), 0);
  check(log.isCancelled(second, 0), "a stopped chain blocks its own hop");
  const later = { ...second, hop: 2 };
  check(log.isCancelled(later, 0), "a stopped chain blocks every later hop");
  check(!log.isCancelled({ ...root, hop: 0 }, 0), "earlier hops are not retroactively cancelled");
  check(log.isCancelled({ ...second, hop: 2 }, 20000) === false, "cancellation entries expire");

  const capacity = new CancellationLog(15000, 4);
  for (let i = 0; i < 10; i++) {
    capacity.recordStopped({ kind: "stopped", chainId: "chain-" + i, hop: 0 }, i);
  }
  check(capacity.entries.size <= 4, "the cancellation log stays bounded");
}

// ---------------------------------------------------------------- reply timing
{
  const clip = sunpet.clips[0];
  check(Math.abs(replyAt(clip) - Math.max(clip.speechEnd, clip.duration - 0.18)) < 1e-9, "replyAt follows the desktop clamp");
  const message = { kind: "started", fromRole: "shaolan", hop: 0, rootRole: "shaolan", duration: 1.0 };
  const delay = replyDelaySeconds(message, { speechStart: 0.5 });
  check(delay > 0.8 && delay < 1.0, "reply delay compensates a capped pre-roll");
  check(replyDelaySeconds({ duration: 0.05 }, { speechStart: 0 }) > 0, "reply delay never goes negative");
}

// ---------------------------------------------------------------- reply picker
{
  const random = rng(5);
  const picker = new ReplyPicker(random);
  const pool = sunpet.clips.filter((clip) => SHORT_REPLY_IDS.includes(clip.id));
  check(pool.length === SHORT_REPLY_IDS.length, "sunpet exposes every short reply clip");
  const seen = new Set();
  let previous = 0;
  let valid = true;
  for (let i = 0; i < 60; i++) {
    const clip = picker.take(pool);
    valid = valid && clip !== null && SHORT_REPLY_IDS.includes(clip.id);
    if (i % pool.length === 0) seen.clear();
    seen.add(clip.id);
    previous = clip.id;
  }
  check(valid, "companion replies stay inside the short pool");
  check(picker.take([]) === null, "an empty reply pool returns null");
}

// ---------------------------------------------------------------- settings clamps
{
  check(clampSize(shaolan, 1000) === shaolan.maxSize, "size clamps to the pet maximum");
  check(clampSize(shaolan, 10) === shaolan.minSize, "size clamps to the pet minimum");
  check(clampSize(sunpet, Number.NaN) === sunpet.defaultSize, "non-finite sizes fall back to the default");
  check(clampSize(sunpet, 1000) === sunpet.maxSize && sunpet.maxSize !== shaolan.maxSize,
    "each pet keeps its own size range");
}

console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
