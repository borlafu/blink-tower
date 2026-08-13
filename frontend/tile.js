"use strict";

// One camera tile: snapshot polling, on-demand HLS live view, metadata chips,
// hide button and drag handle.
//
// Snapshot cadence is chosen per power source in the header: USB (indoor)
// cameras poll fast, battery (outdoor) cameras poll slowly to spare the battery.

import { api, hide, show } from "./api.js";
import { renderChips, renderDetails } from "./camera-meta.js";
import { makeDraggable } from "./reorder.js";

const MILLISECONDS_PER_SECOND = 1000;

// Per-camera runtime state: { element, img, video, badge, liveBtn, err, chipRow,
// detailsBody, camera, power, timer, hls, live }.
const cells = new Map();

const rates = { usb: 5000, battery: 60000 };

/** Set the poll interval (in seconds) for one power group. */
export function setRate(power, seconds) {
  rates[power] = Number(seconds) * MILLISECONDS_PER_SECOND;
  cells.forEach((state, name) => {
    if (!state.live && state.power === power) {
      stopSnapshots(name);
      startSnapshots(name);
    }
  });
}

export function knownNames() {
  return [...cells.keys()];
}

export function hasTile(name) {
  return cells.has(name);
}

function buildView(name) {
  const view = document.createElement("div");
  view.className = "view";

  const img = document.createElement("img");
  img.alt = name;

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.controls = true;
  hide(video);

  view.append(img, video);
  return { view, img, video };
}

function buildBar(camera) {
  const bar = document.createElement("div");
  bar.className = "bar";

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder within this location";
  handle.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "name";
  label.textContent = camera.name;

  const badge = document.createElement("span");
  badge.className = "badge";

  bar.append(handle, label, badge);
  return { bar, handle, badge };
}

function buildActions(camera) {
  const actions = document.createElement("div");
  actions.className = "actions";

  const liveBtn = document.createElement("button");
  liveBtn.textContent = "Go live";

  const hideBtn = document.createElement("button");
  hideBtn.className = "secondary";
  hideBtn.textContent = "Hide";
  hideBtn.title = `Hide ${camera.name} and stop refreshing it`;

  actions.append(liveBtn, hideBtn);
  return { actions, liveBtn, hideBtn };
}

/** Collapsible panel for the rarely-needed fields (serial, firmware, …). */
function buildDetails() {
  const details = document.createElement("details");
  details.className = "details";

  const summary = document.createElement("summary");
  summary.textContent = "Details";

  const detailsBody = document.createElement("div");
  detailsBody.className = "details-body";

  details.append(summary, detailsBody);
  return { details, detailsBody };
}

/**
 * Build a tile for ``camera`` and register its runtime state.
 *
 * ``onHide`` is called with the camera name after the tile has been torn down;
 * ``onReorder`` receives the grid's new camera order after a drag.
 * Returns the tile element — the caller decides where to insert it.
 */
export function createTile(camera, { onHide, onReorder }) {
  const name = camera.name;

  const cell = document.createElement("div");
  cell.className = "cell";
  cell.dataset.camera = name;
  cell.dataset.network = camera.network || "";

  const { view, img, video } = buildView(name);
  const { bar, handle, badge } = buildBar(camera);

  const chipRow = document.createElement("div");
  chipRow.className = "chips";

  const { actions, liveBtn, hideBtn } = buildActions(camera);
  const { details, detailsBody } = buildDetails();

  const err = document.createElement("div");
  err.className = "err";

  cell.append(view, bar, chipRow, actions, details, err);

  const state = {
    element: cell,
    img,
    video,
    badge,
    liveBtn,
    err,
    chipRow,
    detailsBody,
    camera,
    power: camera.power === "usb" ? "usb" : "battery",
    timer: null,
    hls: null,
    live: false,
  };
  cells.set(name, state);

  renderChips(chipRow, camera);
  renderDetails(detailsBody, camera);

  liveBtn.addEventListener("click", () => toggleLive(name));
  hideBtn.addEventListener("click", async () => {
    hideBtn.disabled = true;
    await teardownTile(name);
    cell.remove();
    onHide(name);
  });
  makeDraggable(cell, handle, onReorder);

  startSnapshots(name);
  return cell;
}

/**
 * Refresh a tile's metadata in place.
 *
 * Deliberately does not rebuild the tile: a rebuild would drop an active live
 * stream and reset the user's tile order.
 */
export function updateTile(camera) {
  const state = cells.get(camera.name);
  if (!state) return;
  state.camera = camera;
  state.power = camera.power === "usb" ? "usb" : "battery";
  renderChips(state.chipRow, camera);
  renderDetails(state.detailsBody, camera);
}

export function startSnapshots(name) {
  const state = cells.get(name);
  if (!state || state.timer) return;
  const tick = () => {
    state.img.src = `/api/snapshot/${encodeURIComponent(name)}?t=${Date.now()}`;
  };
  state.img.onerror = () => {
    state.err.textContent = "Snapshot unavailable (camera offline or busy).";
  };
  state.img.onload = () => {
    state.err.textContent = "";
  };
  tick();
  state.timer = setInterval(tick, rates[state.power] || rates.usb);
}

export function stopSnapshots(name) {
  const state = cells.get(name);
  if (state && state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

async function toggleLive(name) {
  const state = cells.get(name);
  if (!state) return;
  if (state.live) {
    await stopLive(name);
  } else {
    await startLive(name);
  }
}

async function startLive(name) {
  const state = cells.get(name);
  state.err.textContent = "";
  state.liveBtn.disabled = true;
  state.liveBtn.textContent = "Starting…";
  try {
    const data = await api(`/api/liveview/${encodeURIComponent(name)}/start`, {
      method: "POST",
    });
    stopSnapshots(name);
    attachHls(state, data.playlist);
    hide(state.img);
    show(state.video);
    state.badge.textContent = "● LIVE";
    state.badge.classList.add("live");
    state.liveBtn.textContent = "Stop live";
    state.live = true;
  } catch (err) {
    state.err.textContent = err.message;
    state.liveBtn.textContent = "Go live";
  } finally {
    state.liveBtn.disabled = false;
  }
}

function attachHls(state, playlist) {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ liveDurationInfinity: true });
    hls.loadSource(playlist);
    hls.attachMedia(state.video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => state.video.play());
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) state.err.textContent = "Live stream error.";
    });
    state.hls = hls;
  } else {
    // Safari plays HLS natively.
    state.video.src = playlist;
    state.video.play();
  }
}

/** Release the player and the backend live session for one camera. */
async function releaseLive(state, name) {
  try {
    await api(`/api/liveview/${encodeURIComponent(name)}/stop`, { method: "POST" });
  } catch (err) {
    state.err.textContent = err.message;
  }
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  state.video.removeAttribute("src");
  state.live = false;
}

async function stopLive(name) {
  const state = cells.get(name);
  state.liveBtn.disabled = true;
  await releaseLive(state, name);
  hide(state.video);
  show(state.img);
  state.badge.textContent = "";
  state.badge.classList.remove("live");
  state.liveBtn.textContent = "Go live";
  state.liveBtn.disabled = false;
  startSnapshots(name);
}

/**
 * Stop all activity for a camera and forget its state.
 *
 * An active live view is stopped on the backend first: hiding a tile must
 * release the Blink session, not just remove the element from the page.
 */
export async function teardownTile(name) {
  const state = cells.get(name);
  if (!state) return;
  stopSnapshots(name);
  if (state.live) await releaseLive(state, name);
  cells.delete(name);
}

/** Tear down every tile (used when the camera list is reloaded). */
export async function clearTiles() {
  await Promise.all(knownNames().map((name) => teardownTile(name)));
}
