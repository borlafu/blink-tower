"use strict";

// Per-browser grid layout: tile order (per location) and hidden cameras.
//
// Stored in localStorage rather than on the server: this app is single-user and
// local, so a per-browser preference needs no new endpoint and no auth. Every
// function here is pure — they return new layout objects instead of mutating the
// one they were given.

const STORAGE_KEY = "blink-tower.layout.v1";
const LAYOUT_VERSION = 1;

/** Shape: { version, order: { [network]: string[] }, hidden: string[] }. */
function emptyLayout() {
  return { version: LAYOUT_VERSION, order: {}, hidden: [] };
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Drop anything that does not match the expected shape, keeping the rest. */
function sanitize(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== LAYOUT_VERSION) {
    return null;
  }
  const order = {};
  const rawOrder = raw.order && typeof raw.order === "object" ? raw.order : {};
  Object.keys(rawOrder).forEach((network) => {
    if (isStringArray(rawOrder[network])) order[network] = [...rawOrder[network]];
  });
  const hidden = isStringArray(raw.hidden) ? [...raw.hidden] : [];
  return { version: LAYOUT_VERSION, order, hidden };
}

/**
 * Read the stored layout, falling back to an empty one.
 *
 * Missing, corrupt or older-version data resets to the default with a console
 * warning — a bad stored value must never break the camera grid, and must never
 * fail silently either. localStorage access itself can throw (Safari private
 * browsing), so it is guarded too.
 */
export function loadLayout() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn(`[blink-tower] cannot read saved layout: ${err.message}`);
    return emptyLayout();
  }
  if (!raw) return emptyLayout();

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[blink-tower] saved layout is not valid JSON: ${err.message}`);
    return emptyLayout();
  }

  const clean = sanitize(parsed);
  if (!clean) {
    console.warn("[blink-tower] saved layout has an unexpected shape; ignoring it.");
    return emptyLayout();
  }
  return clean;
}

/** Persist a layout. Storage failures warn instead of breaking the UI. */
export function saveLayout(layout) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch (err) {
    console.warn(`[blink-tower] could not save layout: ${err.message}`);
  }
}

/**
 * Sort one location's cameras by the stored order.
 *
 * Cameras missing from the stored order (newly added to the Blink account) keep
 * their API position at the end; stored names that no longer exist are ignored.
 */
export function orderCameras(cameras, network, layout) {
  const stored = layout.order[network];
  if (!stored || !stored.length) return [...cameras];

  const rank = new Map(stored.map((name, index) => [name, index]));
  const rankOf = (name) =>
    rank.has(name) ? rank.get(name) : Number.MAX_SAFE_INTEGER;

  return cameras
    .map((camera, index) => ({ camera, index }))
    .sort((a, b) => {
      const byRank = rankOf(a.camera.name) - rankOf(b.camera.name);
      // Ties (both unknown to the stored order) keep their API order.
      return byRank !== 0 ? byRank : a.index - b.index;
    })
    .map((entry) => entry.camera);
}

export function isHidden(name, layout) {
  return layout.hidden.includes(name);
}

/** Return a copy of ``layout`` with ``name`` hidden or shown. */
export function withHidden(layout, name, hidden) {
  const others = layout.hidden.filter((item) => item !== name);
  return {
    ...layout,
    hidden: hidden ? [...others, name] : others,
  };
}

/** Return a copy of ``layout`` with a new tile order for one location. */
export function withOrder(layout, network, names) {
  return {
    ...layout,
    order: { ...layout.order, [network]: [...names] },
  };
}
