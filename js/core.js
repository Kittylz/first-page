// Pure playback and conversation logic for the web build.
//
// Nothing here touches the DOM, the network or Web Audio, so `node js/test-core.mjs`
// can exercise every rule the desktop app covers in CoreTests.cs and PetBridgeTests.cs.

export const ROLES = ["shaolan", "sunpet", "fengge"];

/** Hard ceiling on one conversation chain: shaolan -> sunpet -> fengge -> sunpet. */
export const MAX_HOP = 3;

/** SunPet answers with short clips only, exactly like the Windows build. */
export const SHORT_REPLY_IDS = [1, 2, 4, 11, 13, 14];

/** The moment a clip's voice stops, clamped so a long silent tail cannot stall a reply. */
export function replyAt(clip) {
  return Math.max(clip.speechEnd, clip.duration - 0.18);
}

/**
 * BridgeRules.ShouldReply from PetBridge.cs.
 * `message` only needs { kind, fromRole, hop, rootRole }.
 */
export function shouldReply(role, message) {
  if (!message || message.kind !== "started" || message.hop < 0 || message.hop >= MAX_HOP) return false;
  if (role === "sunpet") {
    return (
      (message.fromRole === "shaolan" && message.hop === 0 && message.rootRole === "shaolan") ||
      (message.fromRole === "fengge" && message.hop === 0 && message.rootRole === "fengge") ||
      (message.fromRole === "fengge" && message.hop === 2 && message.rootRole === "shaolan")
    );
  }
  return role === "fengge" && message.fromRole === "sunpet" && message.hop === 1 && message.rootRole === "shaolan";
}

/**
 * Wait before the answer starts, so both voices meet at the same instant.
 * Ported from the replyTimer interval in PetWindow.cs.
 */
export function replyDelaySeconds(message, replyClip) {
  const preRoll = Math.min(0.16, Math.max(0, replyClip.speechStart || 0));
  return Math.max(0.001, message.duration - preRoll - 0.01);
}

let sequence = 0;

/**
 * Build a "started" event for `role`, chained onto `parent` (or a new chain).
 * Throws when the chain is exhausted, mirroring AnnounceReply's guard.
 */
export function startedEvent(role, clip, parent = null, now = 0) {
  if (parent && !shouldReply(role, parent)) {
    throw new Error("This reply would exceed or violate the bounded desktop pet chain.");
  }
  const id = (++sequence).toString(36).padStart(6, "0") + Math.random().toString(36).slice(2, 10);
  return {
    kind: "started",
    fromRole: role,
    eventId: id,
    chainId: parent ? parent.chainId : id,
    rootRole: parent ? parent.rootRole : role,
    parentEventId: parent ? parent.eventId : null,
    hop: parent ? parent.hop + 1 : 0,
    clipId: clip.id,
    duration: replyAt(clip),
    startedAt: now,
  };
}

/** A stopped event cancels every later hop of the same chain. */
export function stoppedEvent(message, now = 0) {
  return {
    kind: "stopped",
    fromRole: message.fromRole,
    eventId: message.eventId,
    chainId: message.chainId,
    rootRole: message.rootRole,
    parentEventId: message.parentEventId,
    hop: message.hop,
    startedAt: now,
  };
}

/**
 * Tracks cancelled chains so a reply that was already scheduled cannot play
 * after its ancestor stopped (BridgeCancellation.cs).
 */
export class CancellationLog {
  constructor(lifetimeMs = 15000, capacity = 128) {
    this.lifetimeMs = lifetimeMs;
    this.capacity = capacity;
    this.entries = new Map();
  }

  recordStopped(message, now = Date.now()) {
    if (!message || message.kind !== "stopped" || !message.chainId) return;
    if (message.hop < 0 || message.hop > MAX_HOP) return;
    this.prune(now);
    const entry = this.entries.get(message.chainId);
    if (entry) {
      entry.minimumHop = Math.min(entry.minimumHop, message.hop);
      entry.expires = now + this.lifetimeMs;
      return;
    }
    if (this.entries.size >= this.capacity) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, value] of this.entries) {
        if (value.expires < oldest) {
          oldest = value.expires;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) this.entries.delete(oldestKey);
    }
    this.entries.set(message.chainId, { minimumHop: message.hop, expires: now + this.lifetimeMs });
  }

  isCancelled(message, now = Date.now()) {
    if (!message || message.kind !== "started" || !message.chainId) return false;
    this.prune(now);
    const entry = this.entries.get(message.chainId);
    return Boolean(entry) && message.hop >= entry.minimumHop;
  }

  prune(now) {
    for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key);
  }

  get size() {
    this.prune(Date.now());
    return this.entries.size;
  }
}

/** One shuffled pass over `count` items, never repeating across the boundary. */
export class ShuffleBag {
  constructor(random = Math.random) {
    this.random = random;
    this.remaining = [];
    this.previous = -1;
    this.previousCount = -1;
  }

  next(count) {
    if (count <= 0) {
      this.remaining.length = 0;
      this.previousCount = count;
      return -1;
    }
    if (this.previousCount !== count) this.remaining.length = 0;
    this.previousCount = count;
    if (this.remaining.length === 0) {
      for (let i = 0; i < count; i++) this.remaining.push(i);
      for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.remaining[i], this.remaining[j]] = [this.remaining[j], this.remaining[i]];
      }
      const end = count - 1;
      if (count > 1 && this.remaining[end] === this.previous) {
        const j = Math.floor(this.random() * end);
        [this.remaining[end], this.remaining[j]] = [this.remaining[j], this.remaining[end]];
      }
    }
    this.previous = this.remaining[this.remaining.length - 1];
    this.remaining.pop();
    return this.previous;
  }
}

/**
 * PlaybackSelector.cs: random-without-repeats, fixed pin, and the exclusion filter.
 * `settings` is the persisted object for one pet, so validation writes back into it.
 */
export class PlaybackSelector {
  constructor(clips, settings, random = Math.random) {
    if (!Array.isArray(clips) || clips.length === 0) throw new Error("A clip catalog cannot be empty.");
    if (!settings) throw new Error("A settings object is required.");
    this.clips = clips.slice();
    this.settings = settings;
    this.random = random;
    this.byId = new Map();
    for (const clip of this.clips) {
      if (!clip || !(clip.id > 0) || this.byId.has(clip.id)) throw new Error("The clip catalog has a missing or duplicate id.");
      this.byId.set(clip.id, clip);
    }
    this.excluded = new Set();
    this.remaining = [];
    this.lastId = 0;
    this.validate();
  }

  /** Repairs a damaged configuration instead of leaving the pet silent forever. */
  validate() {
    const cleaned = new Set();
    if (this.settings.excludedIds === null || this.settings.excludedIds === undefined) {
      for (const clip of this.clips) if (clip.defaultOff) cleaned.add(clip.id);
      if (cleaned.size === this.clips.length) cleaned.delete(this.clips[0].id);
    } else {
      for (const id of this.settings.excludedIds) if (this.byId.has(id)) cleaned.add(id);
      if (cleaned.size === this.clips.length) {
        cleaned.clear();
        for (const clip of this.clips) if (clip.defaultOff) cleaned.add(clip.id);
        if (cleaned.size === this.clips.length) cleaned.delete(this.clips[0].id);
      }
    }
    const same = cleaned.size === this.excluded.size && [...cleaned].every((id) => this.excluded.has(id));
    if (!same) this.remaining.length = 0;
    this.excluded = cleaned;
    this.settings.excludedIds = this.clips.filter((clip) => cleaned.has(clip.id)).map((clip) => clip.id);
    if (!this.byId.has(this.settings.pinnedId)) {
      this.settings.pinnedId = 0;
      if (!this.settings.randomMode) this.settings.randomMode = true;
    }
    return this;
  }

  get allowedCount() {
    this.validate();
    return this.clips.length - this.excluded.size;
  }

  get pinnedClip() {
    this.validate();
    return this.byId.get(this.settings.pinnedId) || null;
  }

  isExcluded(id) {
    this.validate();
    return this.excluded.has(id);
  }

  /** Replies bypass selection but still become the last spoken clip. */
  recordPlayed(id) {
    if (this.byId.has(id)) this.lastId = id;
  }

  next() {
    this.validate();
    if (!this.settings.randomMode) {
      const clip = this.byId.get(this.settings.pinnedId);
      if (!clip) return null;
      this.lastId = clip.id;
      return clip;
    }
    return this.randomOnce();
  }

  randomOnce() {
    this.validate();
    if (this.remaining.length === 0) {
      for (const clip of this.clips) if (!this.excluded.has(clip.id)) this.remaining.push(clip);
      for (let i = this.remaining.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.remaining[i], this.remaining[j]] = [this.remaining[j], this.remaining[i]];
      }
      const end = this.remaining.length - 1;
      if (this.remaining.length > 1 && this.remaining[end].id === this.lastId) {
        const j = Math.floor(this.random() * end);
        [this.remaining[end], this.remaining[j]] = [this.remaining[j], this.remaining[end]];
      }
    }
    if (this.remaining.length === 0) return null;
    const clip = this.remaining[this.remaining.length - 1];
    this.remaining.pop();
    this.lastId = clip.id;
    return clip;
  }

  choose(id) {
    this.validate();
    const clip = this.byId.get(id);
    if (!clip) return null;
    if (!this.settings.randomMode) this.settings.pinnedId = clip.id;
    this.lastId = clip.id;
    return clip;
  }

  setRandomMode(randomMode) {
    this.validate();
    if (!randomMode && this.settings.pinnedId === 0) {
      this.settings.pinnedId = this.byId.has(this.lastId) ? this.lastId : this.clips[0].id;
    }
    this.settings.randomMode = randomMode;
  }

  toggleExcluded(id) {
    this.validate();
    if (!this.byId.has(id)) return false;
    if (this.excluded.has(id)) {
      this.excluded.delete(id);
    } else {
      if (this.excluded.size === this.clips.length - 1) return false;
      this.excluded.add(id);
    }
    this.settings.excludedIds = this.clips.filter((clip) => this.excluded.has(clip.id)).map((clip) => clip.id);
    this.remaining.length = 0;
    return true;
  }

  enableAll() {
    this.settings.excludedIds = [];
    this.validate();
    this.remaining.length = 0;
  }
}

/** Short answers, one shuffled pass at a time, never the same clip twice in a row. */
export class ReplyPicker {
  constructor(random = Math.random) {
    this.random = random;
    this.bag = new ShuffleBag(random);
    this.signature = "";
    this.previousId = 0;
  }

  /** `pool` is an array of allowed clips; `previousId` is the caller's own memory. */
  take(pool) {
    if (!pool || pool.length === 0) return null;
    const signature = pool.map((clip) => clip.id).join(",");
    if (signature !== this.signature) {
      this.bag = new ShuffleBag(this.random);
      this.signature = signature;
    }
    const index = this.bag.next(pool.length);
    if (index < 0 || index >= pool.length) return null;
    const clip = pool[index];
    if (pool.length > 1 && clip.id === this.previousId) return pool[(index + 1) % pool.length];
    this.previousId = clip.id;
    return clip;
  }
}

/** Clamp a persisted size into the range one pet actually supports. */
export function clampSize(pet, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return pet.defaultSize;
  return Math.min(pet.maxSize, Math.max(pet.minSize, number));
}

/** Volume presets shown in the menu, matching the Windows build. */
export const VOLUME_STEPS = [0, 0.25, 0.5, 0.65, 0.8, 1];
