// Page wiring: rendering, Web Audio playback, the reply chain and the settings menu.
// All conversation rules live in core.js so they stay testable without a browser.

import {
  PlaybackSelector, ReplyPicker, CancellationLog,
  shouldReply, startedEvent, stoppedEvent, replyDelaySeconds,
  clampSize, SHORT_REPLY_IDS, VOLUME_STEPS,
} from "./core.js";

const CATALOG_URL = new URL("../assets/pets.json", import.meta.url).href;
const STORAGE_KEY = "alan-desktop-pets:web:v1";
const PET_ORDER = ["shaolan", "sunpet", "fengge"];
const CONCURRENCY = 4;

/* ------------------------------------------------------------------ helpers */

const $ = (selector, root = document) => root.querySelector(selector);

/** Menu heading for one pet, matching the Windows context menu wording. */
function menuTitle(config) {
  if (config.id === "fengge") return `好事桌宠 · ${config.clipCount} 句原声`;
  if (config.id === "sunpet") return `孙宇晨 · 太对了（${config.clipCount} 句）`;
  return `${config.name}（${config.clipCount} 句）`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

let toastTimer = 0;
function toast(text) {
  const node = $("#toast");
  node.textContent = text;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

/* ----------------------------------------------------------------- settings */

function defaultPetSettings(pet) {
  return {
    size: pet.defaultSize,
    volume: 0.65,
    randomMode: true,
    pinnedId: 0,
    excludedIds: null, // null means "never configured": the catalog defaults apply
    x: null,
    y: null,
  };
}

function defaultSettings() {
  return { version: 1, reduceMotion: false, bridgeEnabled: true, pets: {} };
}

function loadSettings(pets) {
  const base = defaultSettings();
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== "object") stored = {};
  base.reduceMotion = stored.reduceMotion === true;
  base.bridgeEnabled = stored.bridgeEnabled !== false;
  const source = stored.pets && typeof stored.pets === "object" ? stored.pets : {};
  for (const pet of pets) {
    const saved = source[pet.id] && typeof source[pet.id] === "object" ? source[pet.id] : {};
    const next = defaultPetSettings(pet);
    if (Number.isFinite(saved.size)) next.size = clampSize(pet, saved.size);
    if (Number.isFinite(saved.volume)) next.volume = clamp(saved.volume, 0, 1);
    if (typeof saved.randomMode === "boolean") next.randomMode = saved.randomMode;
    if (Number.isInteger(saved.pinnedId) && saved.pinnedId >= 0) next.pinnedId = saved.pinnedId;
    if (Array.isArray(saved.excludedIds)) {
      next.excludedIds = saved.excludedIds.filter((id) => Number.isInteger(id) && id > 0);
    } else if (saved.excludedIds === null) {
      next.excludedIds = null;
    }
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      next.x = saved.x;
      next.y = saved.y;
    }
    base.pets[pet.id] = next;
  }
  return base;
}

/* ------------------------------------------------------------------- audio */

class AudioEngine {
  constructor() {
    this.context = null;
    this.gains = new Map();
    this.buffers = new Map(); // petId -> Map(clipId -> AudioBuffer)
    this.current = new Map(); // petId -> { source, gain }
  }

  ensureContext() {
    if (!this.context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.context = new Ctor({ latencyHint: "interactive" });
    }
    return this.context;
  }

  async resume() {
    const context = this.ensureContext();
    if (context.state !== "running") {
      try { await context.resume(); } catch { /* the next gesture retries */ }
    }
    return context;
  }

  gainNode(petId) {
    let node = this.gains.get(petId);
    if (!node) {
      node = this.ensureContext().createGain();
      node.connect(this.ensureContext().destination);
      this.gains.set(petId, node);
    }
    return node;
  }

  setVolume(petId, volume) {
    const node = this.gains.get(petId);
    if (node) node.gain.setTargetAtTime(volume, this.ensureContext().currentTime, 0.01);
  }

  async loadPet(pet) {
    const context = this.ensureContext();
    const store = new Map();
    const clips = pet.config.clips.slice();
    const workers = new Array(Math.min(CONCURRENCY, clips.length)).fill(null).map(async () => {
      while (clips.length > 0) {
        const clip = clips.shift();
        const response = await fetch(pet.config.audioBase + clip.file);
        if (!response.ok) throw new Error("HTTP " + response.status + " for " + clip.file);
        const bytes = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        store.set(clip.id, buffer);
        pet.onProgress(store.size, pet.config.clips.length);
      }
    });
    await Promise.all(workers);
    this.buffers.set(pet.config.id, store);
  }

  buffer(petId, clipId) {
    const store = this.buffers.get(petId);
    return store ? store.get(clipId) : null;
  }

  play(petId, buffer, volume) {
    this.stop(petId, 0);
    const context = this.ensureContext();
    const now = context.currentTime;
    const gain = this.gainNode(petId);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.008);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(now);
    this.current.set(petId, { source, gain });
    return { source, startedAt: now, wallClock: performance.now() };
  }

  stop(petId, fade = 0.02) {
    const playing = this.current.get(petId);
    if (!playing) return;
    this.current.delete(petId);
    const context = this.ensureContext();
    const now = context.currentTime;
    try {
      if (fade > 0) {
        playing.gain.gain.cancelScheduledValues(now);
        playing.gain.gain.setValueAtTime(playing.gain.gain.value, now);
        playing.gain.gain.linearRampToValueAtTime(0, now + fade);
        playing.source.stop(now + fade);
      } else {
        playing.source.stop(now);
      }
    } catch {
      /* already ended */
    }
  }

  isPlaying(petId) {
    return this.current.has(petId);
  }
}

/* -------------------------------------------------------------------- pets */

const engine = new AudioEngine();
const cancellations = new CancellationLog();
const pets = new Map();
let settings = null;

function createPet(config) {
  const element = document.createElement("div");
  element.className = "pet loading";
  element.dataset.pet = config.id;
  element.dataset.motion = config.motion;
  element.style.setProperty("--accent", config.accent);
  element.innerHTML = `
    <div class="bubble" role="status" aria-live="polite"></div>
    <button class="face" type="button">
      <img alt="" draggable="false">
    </button>
    <div class="tag"></div>`;
  const image = $("img", element);
  image.src = config.face;
  image.alt = config.name;
  const button = $(".face", element);
  button.setAttribute("aria-label", menuTitle(config) + "，点击说话，拖动移动，右键设置");

  const pet = {
    config,
    element,
    button,
    image,
    bubble: $(".bubble", element),
    tag: $(".tag", element),
    selector: null,
    replyPicker: new ReplyPicker(),
    pendingReply: null,
    activeEvent: null,
    activeReplySource: null,
    playing: false,
    ready: false,
    x: 0,
    y: 0,
    width: config.defaultSize,
    height: config.defaultSize,
    progress: 0,
    onProgress: null,
  };
  element.style.width = pet.width + "px";
  pet.tag.textContent = config.name;
  pets.set(config.id, pet);
  return pet;
}

function petSettings(pet) {
  return settings.pets[pet.config.id];
}

function layoutMetrics() {
  const compact = window.innerWidth < 560;
  return { side: compact ? 14 : 34, bottom: compact ? 46 : 34, gap: compact ? 8 : 14 };
}

/** Shrink the row on narrow screens instead of letting the pets overlap. */
function displayScaleFor(row) {
  const { side, gap } = layoutMetrics();
  const natural = row.reduce((sum, pet) => sum + petSettings(pet).size, 0) + gap * (row.length - 1);
  const available = window.innerWidth - side * 2;
  return Math.max(0.5, Math.min(1, available / natural));
}

function applySize(pet) {
  const size = petSettings(pet).size;
  const scale = pet.scale || 1;
  pet.width = Math.round(size * scale);
  pet.element.style.width = pet.width + "px";
  pet.element.style.zIndex = String(pet.width);
}

function refreshScales() {
  const row = PET_ORDER.map((id) => pets.get(id)).filter(Boolean);
  if (row.length === 0) return row;
  const scale = displayScaleFor(row);
  for (const pet of row) {
    pet.scale = scale;
    applySize(pet);
    measure(pet);
  }
  return row;
}

/* ---------------------------------------------------------------- placement */

function measure(pet) {
  const rect = pet.element.getBoundingClientRect();
  pet.width = rect.width || pet.width;
  pet.height = rect.height || pet.height;
}

function clampPosition(pet) {
  measure(pet);
  const maxX = Math.max(0, window.innerWidth - pet.width);
  const maxY = Math.max(0, window.innerHeight - pet.height - 8);
  pet.x = clamp(pet.x, 0, maxX);
  pet.y = clamp(pet.y, 0, maxY);
  place(pet);
}

function place(pet) {
  pet.element.style.transform = `translate3d(${Math.round(pet.x)}px, ${Math.round(pet.y)}px, 0)`;
}

/** Lay the pets out in a row on the bottom-right, like 启动三宠.cmd does on the desktop. */
function layoutDefault() {
  const row = refreshScales();
  if (row.length === 0) return;
  const { side, bottom, gap } = layoutMetrics();
  const scale = row[0].scale;
  const total = row.reduce((sum, pet) => sum + pet.width, 0) + gap * scale * (row.length - 1);
  let x = window.innerWidth - side - total;
  for (const pet of row) {
    pet.x = Math.max(0, x);
    pet.y = window.innerHeight - bottom - pet.height;
    place(pet);
    x += pet.width + gap * scale;
  }
}

window.addEventListener("resize", () => {
  const row = [...pets.values()];
  if (row.length > 0 && row.every((pet) => !pet.userPlaced)) {
    layoutDefault();
    return;
  }
  refreshScales();
  for (const pet of row) clampPosition(pet);
});

/* ---------------------------------------------------------------- playback */

function showCaption(pet, text, sticky) {
  pet.bubble.textContent = text;
  pet.bubble.classList.add("show");
  clearTimeout(pet.captionTimer);
  if (!sticky) pet.captionTimer = setTimeout(() => pet.bubble.classList.remove("show"), 2400);
}

function hideCaption(pet) {
  clearTimeout(pet.captionTimer);
  pet.bubble.classList.remove("show");
}

function setSpeaking(pet, speaking) {
  pet.playing = speaking;
  pet.element.classList.toggle("speaking", speaking && !settings.reduceMotion);
}

function cancelPendingReply(pet) {
  const pending = pet.pendingReply;
  if (!pending) return;
  clearTimeout(pending.timer);
  pet.pendingReply = null;
}

/** Stop one pet's voice and tell the chain that its sentence ended early. */
function stopPet(pet, announce = true) {
  cancelPendingReply(pet);
  if (announce && pet.activeEvent) dispatch(stoppedEvent(pet.activeEvent, performance.now()));
  engine.stop(pet.config.id);
  pet.activeEvent = null;
  pet.activeReplySource = null;
  setSpeaking(pet, false);
  hideCaption(pet);
}

function speak(pet, clip, parent = null) {
  if (!pet.ready) {
    toast("语音还在装载，马上就好…");
    return;
  }
  stopPet(pet, true);
  const buffer = engine.buffer(pet.config.id, clip.id);
  if (!buffer) {
    toast("这句暂时无法播放");
    return;
  }
  const event = startedEvent(pet.config.id, clip, parent, performance.now());
  pet.activeEvent = event;
  pet.activeReplySource = parent;
  pet.selector?.recordPlayed(clip.id);
  const playback = engine.play(pet.config.id, buffer, petSettings(pet).volume);
  setSpeaking(pet, true);
  showCaption(pet, clip.label, true);

  // Clear "speaking" when the audio really stops, so a reply that lands on the
  // tail of this sentence is not mistaken for a busy pet.
  const finish = () => {
    if (pet.activeEvent !== event) return;
    setSpeaking(pet, false);
    pet.activeEvent = null;
    pet.activeReplySource = null;
    clearTimeout(pet.captionHide);
    pet.captionHide = setTimeout(() => pet.bubble.classList.remove("show"), 550);
  };
  playback.source.addEventListener("ended", finish, { once: true });

  // Watchdog: if the decoder or device never reports the end, recover anyway.
  clearTimeout(pet.endTimer);
  pet.endTimer = setTimeout(finish, (buffer.duration + 1.2) * 1000);

  dispatch(event);
}

/** Fan one event out to every pet, exactly like the named-pipe bus in the desktop build. */
function dispatch(event) {
  for (const pet of pets.values()) receive(pet, event);
}

function receive(pet, message) {
  if (message.kind === "stopped") {
    cancellations.recordStopped(message);
    const pending = pet.pendingReply;
    if (pending && pending.message.chainId === message.chainId && message.hop <= pending.message.hop) {
      cancelPendingReply(pet);
    }
    if (pet.activeReplySource && pet.activeReplySource.chainId === message.chainId && message.hop <= pet.activeReplySource.hop) {
      stopPet(pet, false);
    }
    return;
  }
  if (cancellations.isCancelled(message)) return;
  if (!shouldReply(pet.config.id, message)) return;
  cancelPendingReply(pet);
  if (!settings.bridgeEnabled) return;
  // A pet that is still finishing its own sentence in this same chain may line up
  // the next answer; any other kind of busy pet skips it, like the desktop build.
  const busy = pet.playing;
  if (busy && !(pet.activeReplySource && pet.activeReplySource.chainId === message.chainId)) return;
  const elapsed = (performance.now() - message.startedAt) / 1000;
  if (elapsed > message.duration + 0.25) return;

  const clip = pickReplyClip(pet);
  if (!clip) return;
  const delay = replyDelaySeconds(message, clip);
  pet.pendingReply = {
    message,
    clip,
    timer: setTimeout(() => runPendingReply(pet), Math.round(delay * 1000)),
  };
}

async function runPendingReply(pet) {
  const pending = pet.pendingReply;
  if (!pending) return;
  pet.pendingReply = null;
  if (!settings.bridgeEnabled || pet.playing) return;
  if (cancellations.isCancelled(pending.message)) return;
  await pet.readyPromise;
  if (!settings.bridgeEnabled || pet.playing || cancellations.isCancelled(pending.message)) return;
  speak(pet, pending.clip, pending.message);
}

function pickReplyClip(pet) {
  const clips = pet.config.clips;
  if (pet.config.id === "sunpet") {
    const pool = clips.filter((clip) => SHORT_REPLY_IDS.includes(clip.id) && !pet.selector.isExcluded(clip.id));
    return pet.replyPicker.take(pool);
  }
  if (pet.config.id === "fengge") return pet.replyPicker.take(clips);
  return null; // shaolan starts chains and never answers
}

function playNext(pet) {
  const clip = pet.selector ? pet.selector.next() : pet.config.clips[0];
  if (clip) speak(pet, clip);
}

/* ---------------------------------------------------------------- the menu */

const menuState = { pet: null, expanded: new Set() };

function menuItem({ label, checked, expandable, onClick, className }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mi" + (className ? " " + className : "");
  button.setAttribute("role", checked === undefined ? "menuitem" : "menuitemradio");
  if (checked !== undefined) button.setAttribute("aria-checked", String(Boolean(checked)));
  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = checked ? "✓" : "";
  const text = document.createElement("span");
  text.className = "label";
  text.textContent = label;
  button.append(mark, text);
  if (expandable) {
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "›";
    button.append(arrow);
    button.setAttribute("aria-expanded", "false");
  }
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function separator() {
  const node = document.createElement("div");
  node.className = "sep";
  return node;
}

function heading(text) {
  const node = document.createElement("div");
  node.className = "mh";
  node.textContent = text;
  return node;
}

function expandableSection(key, label, buildChildren) {
  const expanded = menuState.expanded.has(key);
  const button = menuItem({
    label,
    expandable: true,
    onClick: (event) => {
      event.stopPropagation();
      if (menuState.expanded.has(key)) menuState.expanded.delete(key);
      else menuState.expanded.add(key);
      renderMenu();
    },
    className: "expandable",
  });
  button.setAttribute("aria-expanded", String(expanded));
  const group = document.createElement("div");
  if (expanded) {
    group.className = "sub";
    buildChildren(group);
  }
  return [button, group];
}

function renderMenu() {
  const menu = $("#menu");
  const pet = menuState.pet;
  if (!pet) return;
  menu.textContent = "";
  const config = pet.config;
  const current = petSettings(pet);

  menu.append(heading(menuTitle(config)));

  if (pet.selector) {
    menu.append(separator());
    menu.append(heading("播放方式"));
    menu.append(menuItem({
      label: "随机一句（一轮不重复）",
      checked: current.randomMode,
      onClick: () => {
        pet.selector.setRandomMode(true);
        persist();
        renderMenu();
        toast("播放方式：随机一句");
      },
    }));
    const pinned = pet.selector.pinnedClip;
    menu.append(menuItem({
      label: pinned ? `固定播一句（${String(pinned.id).padStart(2, "0")} ${pinned.label}）` : "固定播一句",
      checked: !current.randomMode,
      onClick: () => {
        pet.selector.setRandomMode(false);
        persist();
        renderMenu();
        toast("已固定：" + pet.selector.pinnedClip.label);
      },
    }));

    menu.append(separator());
    menu.append(...expandableSection("choose", "挑一句", (group) => {
      for (const clip of config.clips) {
        group.append(menuItem({
          label: `${String(clip.id).padStart(2, "0")}  ${clip.label}`,
          checked: !current.randomMode && current.pinnedId === clip.id,
          className: "clip",
          onClick: () => {
            const chosen = pet.selector.choose(clip.id);
            if (!chosen) return;
            persist();
            closeMenu();
            speak(pet, chosen);
          },
        }));
      }
    }));

    menu.append(menuItem({
      label: `轮播内容（已选 ${pet.selector.allowedCount} / ${config.clipCount}）…`,
      onClick: () => {
        closeMenu();
        openFilterDialog(pet);
      },
    }));
  }

  menu.append(menuItem({
    label: "随机播一次",
    onClick: () => {
      closeMenu();
      playNext(pet);
    },
  }));
  menu.append(menuItem({
    label: "停止播放",
    onClick: () => {
      closeMenu();
      stopPet(pet, true);
    },
  }));

  menu.append(separator());
  menu.append(menuItem({
    label: settings.bridgeEnabled ? "关闭捧哏联动" : "开启捧哏联动",
    checked: settings.bridgeEnabled,
    onClick: () => {
      settings.bridgeEnabled = !settings.bridgeEnabled;
      if (!settings.bridgeEnabled) {
        for (const each of pets.values()) {
          cancelPendingReply(each);
          if (each.activeReplySource) stopPet(each, false);
        }
      }
      persist();
      renderMenu();
      toast(settings.bridgeEnabled ? "捧哏联动：开" : "捧哏联动：关");
    },
  }));
  menu.append(menuItem({
    label: settings.bridgeEnabled ? "联动：三只宠物都在场" : "联动：已关闭",
    className: "note",
    onClick: null,
  }));

  menu.append(separator());
  menu.append(...expandableSection("volume", "音量", (group) => {
    for (const step of VOLUME_STEPS) {
      group.append(menuItem({
        label: step === 0 ? "静音" : Math.round(step * 100) + "%",
        checked: Math.abs(current.volume - step) < 0.01,
        onClick: () => {
          current.volume = step;
          engine.setVolume(config.id, step);
          persist();
          renderMenu();
        },
      }));
    }
  }));

  menu.append(...expandableSection("size", config.sizeMenu, (group) => {
    config.sizeSteps.forEach((step, index) => {
      group.append(menuItem({
        label: config.sizeLabels[index] + (step !== config.defaultSize ? "" : "（默认）"),
        checked: Math.abs(current.size - step) < 1,
        onClick: () => {
          current.size = step;
          applySize(pet);
          clampPosition(pet);
          persist();
          renderMenu();
        },
      }));
    });
  }));

  menu.append(menuItem({
    label: "减少动态效果",
    checked: settings.reduceMotion,
    onClick: () => {
      settings.reduceMotion = !settings.reduceMotion;
      for (const each of pets.values()) setSpeaking(each, each.playing);
      persist();
      renderMenu();
    },
  }));

  menu.append(menuItem({
    label: "移回屏幕右下角",
    onClick: () => {
      closeMenu();
      layoutDefault();
      persist();
    },
  }));

  menu.append(separator());
  menu.append(menuItem({
    label: "停止全部并重新排列",
    onClick: () => {
      closeMenu();
      for (const each of pets.values()) stopPet(each, true);
      layoutDefault();
      persist();
    },
  }));
}

function openMenu(pet, clientX, clientY) {
  menuState.pet = pet;
  menuState.expanded.clear();
  renderMenu();
  const menu = $("#menu");
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const x = clamp(clientX, 8, window.innerWidth - rect.width - 8);
  const y = clientY + rect.height > window.innerHeight - 8 ? Math.max(8, clientY - rect.height) : clientY;
  menu.style.left = Math.round(x) + "px";
  menu.style.top = Math.round(y) + "px";
  menu.focus?.();
}

function closeMenu() {
  const menu = $("#menu");
  menu.hidden = true;
  menuState.pet = null;
}

/* -------------------------------------------------------------- filter dialog */

function openFilterDialog(pet) {
  const backdrop = $("#backdrop");
  const sheet = $(".sheet", backdrop);
  const config = pet.config;
  sheet.textContent = "";
  sheet.setAttribute("aria-label", "轮播内容 · " + config.name);

  const title = document.createElement("h2");
  title.textContent = "轮播内容 · " + config.name;
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "取消勾选只影响随机轮播和自动接话；固定播放、手动挑一句不受影响。";
  const count = document.createElement("div");
  count.className = "count";
  const list = document.createElement("div");
  list.className = "list";

  const refresh = () => {
    count.textContent = `已选 ${pet.selector.allowedCount} / ${config.clipCount} 句`;
    for (const row of list.children) {
      row.querySelector("input").checked = !pet.selector.isExcluded(Number(row.dataset.id));
    }
  };

  for (const clip of config.clips) {
    const row = document.createElement("label");
    row.className = "row";
    row.dataset.id = String(clip.id);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      if (!pet.selector.toggleExcluded(clip.id)) {
        input.checked = true;
        toast("至少要保留一句用于随机轮播");
      } else {
        persist();
      }
      refresh();
    });
    const text = document.createElement("span");
    text.textContent = `${String(clip.id).padStart(2, "0")}  ${clip.label}`;
    row.append(input, text);
    list.append(row);
  }

  const footer = document.createElement("footer");
  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "ghost";
  restore.textContent = "全部恢复";
  restore.addEventListener("click", () => {
    pet.selector.enableAll();
    persist();
    refresh();
  });
  const done = document.createElement("button");
  done.type = "button";
  done.className = "primary";
  done.textContent = "完成";
  done.addEventListener("click", closeFilterDialog);
  footer.append(restore, done);

  sheet.append(title, note, count, list, footer);
  refresh();
  backdrop.hidden = false;
  done.focus();
}

function closeFilterDialog() {
  $("#backdrop").hidden = true;
}

/* --------------------------------------------------------------- persistence */

const persist = debounce(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    toast("设置暂时无法保存");
  }
}, 150);

function persistNow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: keep running without saving */
  }
}

/* ---------------------------------------------------------------- interaction */

function bindPet(pet) {
  const button = pet.button;
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let longPress = 0;
  let suppressClick = false;
  let pointerId = null;

  const onMove = (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 5) {
      moved = true;
      clearTimeout(longPress);
      document.body.classList.add("dragging");
    }
    if (!moved) return;
    pet.x = originX + dx;
    pet.y = originY + dy;
    place(pet);
  };

  const onUp = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    clearTimeout(longPress);
    if (dragging) {
      button.removeEventListener("pointermove", onMove);
      button.removeEventListener("pointerup", onUp);
      button.removeEventListener("pointercancel", onUp);
      try { button.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
      dragging = false;
      document.body.classList.remove("dragging");
      if (moved) {
        clampPosition(pet);
        pet.userPlaced = true;
        persist();
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
    }
  };

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    engine.resume();
    pointerId = event.pointerId;
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    originX = pet.x;
    originY = pet.y;
    button.setPointerCapture(event.pointerId);
    button.addEventListener("pointermove", onMove);
    button.addEventListener("pointerup", onUp);
    button.addEventListener("pointercancel", onUp);
    longPress = setTimeout(() => {
      if (moved) return;
      suppressClick = true;
      onUp({ pointerId });
      openMenu(pet, event.clientX, event.clientY);
    }, 550);
  });

  button.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (moved) {
      moved = false;
      return;
    }
    playNext(pet);
  });

  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu(pet, event.clientX, event.clientY);
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "Menu" || (event.shiftKey && event.key === "F10")) {
      const rect = button.getBoundingClientRect();
      event.preventDefault();
      openMenu(pet, rect.right - 40, rect.top);
    }
  });
}

document.addEventListener("pointerdown", (event) => {
  engine.resume();
  const menu = $("#menu");
  if (!menu.hidden && !menu.contains(event.target) && !event.target.closest?.(".pet")) closeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#backdrop").hidden) closeFilterDialog();
  else closeMenu();
});

$("#backdrop").addEventListener("click", (event) => {
  if (event.target === $("#backdrop")) closeFilterDialog();
});

window.addEventListener("pagehide", persistNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistNow();
});

/* ------------------------------------------------------------------- loading */

function updateStatus() {
  const total = [...pets.values()].reduce((sum, pet) => sum + pet.config.clipCount, 0);
  const loaded = [...pets.values()].reduce((sum, pet) => sum + pet.progress, 0);
  const status = $("#status");
  if (loaded >= total) {
    status.textContent = "语音已就绪 · 三宠联动已开启";
    status.classList.add("ready");
  } else {
    status.textContent = `语音装载中 ${loaded} / ${total}`;
  }
}

async function loadPetAudio(pet) {
  pet.onProgress = (done) => {
    pet.progress = done;
    updateStatus();
  };
  pet.readyPromise = engine
    .loadPet(pet)
    .then(() => {
      pet.ready = true;
      pet.element.classList.remove("loading");
    })
    .catch((error) => {
      console.error(error);
      pet.element.classList.remove("loading");
      pet.element.classList.add("failed");
      toast(pet.config.name + " 的语音装载失败，请刷新重试");
      throw error;
    });
  return pet.readyPromise;
}

/* ---------------------------------------------------------------------- boot */

async function boot() {
  const response = await fetch(CATALOG_URL);
  const catalog = await response.json();
  settings = loadSettings(catalog.pets);

  for (const id of PET_ORDER) {
    const config = catalog.pets.find((pet) => pet.id === id);
    if (!config) continue;
    config.audioBase = `assets/${id}/sounds/`;
    config.face = `assets/${id}/face.png`;
    const pet = createPet(config);
    pet.selector = config.selectable
      ? new PlaybackSelector(config.clips, settings.pets[id])
      : null;
    applySize(pet);
    $("#pets").append(pet.element);
    bindPet(pet);
  }

  await Promise.all([...pets.values()].map((pet) => pet.image.decode().catch(() => {})));
  refreshScales();

  for (const pet of pets.values()) {
    const saved = petSettings(pet);
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      pet.x = saved.x;
      pet.y = saved.y;
      pet.userPlaced = true;
      clampPosition(pet);
    }
  }
  const unplaced = [...pets.values()].filter((pet) => !Number.isFinite(petSettings(pet).x));
  for (const pet of unplaced) {
    petSettings(pet).x = null; // let layoutDefault fill it in
  }
  if (unplaced.length > 0) layoutDefault();

  document.body.classList.add("ready");
  updateStatus();

  // Audio is large, so it loads after the first paint, one pet at a time.
  for (const id of PET_ORDER) {
    const pet = pets.get(id);
    if (!pet) continue;
    try {
      await loadPetAudio(pet);
    } catch {
      /* already surfaced */
    }
  }
}

$("#try").addEventListener("click", async () => {
  await engine.resume();
  const pet = pets.get("shaolan");
  if (!pet) return;
  if (!pet.ready) {
    toast("语音还在装载，马上就好…");
    await pet.readyPromise.catch(() => {});
  }
  const clip = pet.selector.randomOnce();
  if (clip) speak(pet, clip);
});

boot().catch((error) => {
  console.error(error);
  $("#status").textContent = "加载失败：" + error.message;
});

// Keep the store honest when positions change without a drag (window resize).
window.addEventListener("resize", () => persist());
