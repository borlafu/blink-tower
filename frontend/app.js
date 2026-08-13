"use strict";

// Frontend entry point: authentication, the location sections, and the wiring
// between the layout store (order + hidden cameras) and the tiles themselves.
//
// Refresh cadence is chosen in the UI, separately per power source: USB (indoor)
// cameras poll fast; battery (outdoor) cameras poll slowly.

import { api, hide, show } from "./api.js";
import {
  isHidden,
  loadLayout,
  orderCameras,
  saveLayout,
  withHidden,
  withOrder,
} from "./layout.js";
import { enableDropZone } from "./reorder.js";
import {
  clearTiles,
  createTile,
  hasTile,
  setRate,
  startSnapshots,
  updateTile,
} from "./tile.js";

// How often camera metadata (battery, signal, temperature…) is re-read. This
// costs no extra Blink cloud calls: the route serves blinkpy's in-memory
// attributes, refreshed as a side effect of the snapshot polling.
const METADATA_REFRESH_MS = 60000;

const usbSelect = document.getElementById("rate-usb");
const batterySelect = document.getElementById("rate-battery");
const statusEl = document.getElementById("status");
const authEl = document.getElementById("auth");
const authMsgEl = document.getElementById("auth-msg");
const authLoginEl = document.getElementById("auth-login");
const auth2faEl = document.getElementById("auth-2fa");
const loginBtn = document.getElementById("login-btn");
const pinInput = document.getElementById("pin");
const gridEl = document.getElementById("grid");

let layout = loadLayout();

// Latest /api/cameras payload, grouped by Blink network (location).
let camerasByNetwork = new Map();
// Per-location DOM handles: network -> { title, row, tray }.
const sections = new Map();

let metadataTimer = null;

setRate("usb", usbSelect.value);
setRate("battery", batterySelect.value);
usbSelect.addEventListener("change", () => setRate("usb", usbSelect.value));
batterySelect.addEventListener("change", () =>
  setRate("battery", batterySelect.value)
);

async function boot() {
  try {
    const status = await api("/api/status");
    if (status.authenticated) {
      hide(authEl);
      await loadCameras();
    } else {
      showAuth(status.needs_2fa);
    }
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

function showAuth(needs2fa) {
  show(authEl);
  if (needs2fa) {
    hide(authLoginEl);
    show(auth2faEl);
    authMsgEl.textContent = "Blink sent a 2FA pin to your email.";
  } else {
    show(authLoginEl);
    hide(auth2faEl);
    authMsgEl.textContent = "Not connected to Blink yet.";
  }
}

loginBtn.addEventListener("click", async () => {
  loginBtn.disabled = true;
  authMsgEl.textContent = "Connecting…";
  try {
    const status = await api("/api/auth/start", { method: "POST" });
    if (status.authenticated) {
      hide(authEl);
      await loadCameras();
    } else if (status.needs_2fa) {
      showAuth(true);
    }
  } catch (err) {
    authMsgEl.textContent = err.message;
  } finally {
    loginBtn.disabled = false;
  }
});

auth2faEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  authMsgEl.textContent = "Verifying…";
  try {
    const status = await api("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pinInput.value }),
    });
    if (status.authenticated) {
      hide(authEl);
      await loadCameras();
    }
  } catch (err) {
    authMsgEl.textContent = err.message;
  }
});

/** Group cameras by their Blink network (location), preserving API order. */
function groupByNetwork(cameras) {
  const byNetwork = new Map();
  cameras.forEach((camera) => {
    const key = camera.network || "Unknown location";
    if (!byNetwork.has(key)) byNetwork.set(key, []);
    byNetwork.get(key).push(camera);
  });
  return byNetwork;
}

function camerasOf(network) {
  return camerasByNetwork.get(network) || [];
}

/** Cameras of one location in the user's chosen order. */
function orderedCamerasOf(network) {
  return orderCameras(camerasOf(network), network, layout);
}

async function loadCameras() {
  statusEl.textContent = "Loading cameras…";
  const cameras = await api("/api/cameras");
  await renderAll(cameras);
  startMetadataRefresh();
}

async function renderAll(cameras) {
  await clearTiles();
  gridEl.replaceChildren();
  sections.clear();
  camerasByNetwork = groupByNetwork(cameras);

  if (!cameras.length) {
    statusEl.textContent = "No cameras found on this Blink account.";
    return;
  }
  statusEl.textContent = `${cameras.length} camera(s) across your locations.`;

  camerasByNetwork.forEach((_, network) => renderSection(network));
}

function renderSection(network) {
  const section = document.createElement("section");
  section.className = "location";

  const title = document.createElement("h2");
  title.className = "location-title";

  const row = document.createElement("div");
  row.className = "grid";
  enableDropZone(row);

  const tray = document.createElement("div");
  tray.className = "hidden-tray hidden";

  section.append(title, row, tray);
  gridEl.appendChild(section);
  sections.set(network, { title, row, tray });

  orderedCamerasOf(network).forEach((camera) => {
    if (!isHidden(camera.name, layout)) row.appendChild(buildTile(camera));
  });

  refreshSectionChrome(network);
}

function buildTile(camera) {
  const network = camera.network || "Unknown location";
  return createTile(camera, {
    onHide: (name) => onTileHidden(network, name),
    onReorder: (names) => persistOrder(network, names),
  });
}

/**
 * Persist a location's tile order after a drag.
 *
 * Hidden cameras are absent from the DOM, so they are folded back in at their
 * previous index — hiding a camera must not lose its place in the order.
 */
function persistOrder(network, visibleNames) {
  const previous = layout.order[network] || [];
  const apiNames = camerasOf(network).map((camera) => camera.name);
  const merged = [...visibleNames];

  apiNames
    .filter((name) => !visibleNames.includes(name))
    .forEach((name) => {
      // Prefer where the user last had it; otherwise its position as Blink
      // listed it. Either way, clamped to the current length.
      const previousIndex = previous.indexOf(name);
      const fallbackIndex = apiNames.indexOf(name);
      const index = Math.min(
        previousIndex >= 0 ? previousIndex : fallbackIndex,
        merged.length
      );
      merged.splice(index, 0, name);
    });

  layout = withOrder(layout, network, merged);
  saveLayout(layout);
}

function onTileHidden(network, name) {
  layout = withHidden(layout, name, true);
  saveLayout(layout);
  refreshSectionChrome(network);
}

/** Re-insert a previously hidden tile at its stored position. */
function showCamera(network, name) {
  layout = withHidden(layout, name, false);
  saveLayout(layout);

  const camera = camerasOf(network).find((item) => item.name === name);
  const handles = sections.get(network);
  if (!camera || !handles) return;

  if (hasTile(name)) {
    startSnapshots(name);
  } else {
    handles.row.insertBefore(buildTile(camera), nextVisibleElement(network, name));
  }
  refreshSectionChrome(network);
}

/**
 * The tile that a newly shown camera should be inserted before, or null to
 * append: the first camera after it in the stored order that is on screen.
 */
function nextVisibleElement(network, name) {
  const handles = sections.get(network);
  const ordered = orderedCamerasOf(network).map((camera) => camera.name);
  const position = ordered.indexOf(name);
  if (position < 0) return null;

  for (const candidate of ordered.slice(position + 1)) {
    const element = handles.row.querySelector(
      `.cell[data-camera="${CSS.escape(candidate)}"]`
    );
    if (element) return element;
  }
  return null;
}

/** Update a location's heading and its tray of hidden cameras. */
function refreshSectionChrome(network) {
  const handles = sections.get(network);
  if (!handles) return;

  const all = camerasOf(network);
  const hiddenCameras = all.filter((camera) => isHidden(camera.name, layout));
  const visibleCount = all.length - hiddenCameras.length;

  handles.title.textContent = hiddenCameras.length
    ? `${network} · ${visibleCount} of ${all.length} camera(s) shown`
    : `${network} · ${all.length} camera(s)`;

  handles.tray.replaceChildren();
  if (!hiddenCameras.length) {
    hide(handles.tray);
    return;
  }

  const label = document.createElement("span");
  label.className = "tray-label";
  label.textContent = "Hidden:";
  handles.tray.appendChild(label);

  hiddenCameras.forEach((camera) => {
    const button = document.createElement("button");
    button.className = "secondary chip";
    button.textContent = `Show ${camera.name}`;
    button.addEventListener("click", () => showCamera(network, camera.name));
    handles.tray.appendChild(button);
  });

  if (hiddenCameras.length > 1) {
    const showAll = document.createElement("button");
    showAll.className = "secondary chip";
    showAll.textContent = "Show all";
    showAll.addEventListener("click", () => {
      hiddenCameras.forEach((camera) => showCamera(network, camera.name));
    });
    handles.tray.appendChild(showAll);
  }
  show(handles.tray);
}

function startMetadataRefresh() {
  if (metadataTimer) clearInterval(metadataTimer);
  metadataTimer = setInterval(refreshMetadata, METADATA_REFRESH_MS);
}

/**
 * Re-read camera metadata and update the chips in place.
 *
 * Tiles are only rebuilt when the camera set itself changed (one added to or
 * removed from the Blink account); a plain metadata change never interrupts a
 * live stream or resets the grid order.
 */
async function refreshMetadata() {
  let cameras = null;
  try {
    cameras = await api("/api/cameras");
  } catch (err) {
    statusEl.textContent = `Camera info refresh failed: ${err.message}`;
    return;
  }

  const previousNames = [...camerasByNetwork.values()]
    .flat()
    .map((camera) => camera.name)
    .sort();
  const currentNames = cameras.map((camera) => camera.name).sort();

  if (previousNames.join(" ") !== currentNames.join(" ")) {
    await renderAll(cameras);
    return;
  }

  camerasByNetwork = groupByNetwork(cameras);
  cameras.forEach((camera) => updateTile(camera));
  statusEl.textContent = `${cameras.length} camera(s) across your locations.`;
  camerasByNetwork.forEach((_, network) => refreshSectionChrome(network));
}

// Best-effort release of backend live sessions when the page goes away. The
// server also times sessions out, so a lost request is not fatal.
window.addEventListener("pagehide", () => {
  clearTiles();
});

boot();
