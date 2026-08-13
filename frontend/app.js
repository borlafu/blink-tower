"use strict";

// Frontend controller: snapshot grid with on-demand HLS live view.
// Refresh cadence is chosen in the UI, separately per power source:
// USB (indoor) cameras poll fast; battery (outdoor) cameras poll slowly.
const usbSelect = document.getElementById("rate-usb");
const batterySelect = document.getElementById("rate-battery");
const rates = {
  usb: Number(usbSelect.value) * 1000,
  battery: Number(batterySelect.value) * 1000,
};

const statusEl = document.getElementById("status");
const authEl = document.getElementById("auth");
const authMsgEl = document.getElementById("auth-msg");
const authLoginEl = document.getElementById("auth-login");
const auth2faEl = document.getElementById("auth-2fa");
const loginBtn = document.getElementById("login-btn");
const pinInput = document.getElementById("pin");
const gridEl = document.getElementById("grid");

// Per-camera runtime state: { timer, hls, video, img, live }.
const cells = new Map();

// Changing a rate restarts polling for that power group's non-live cameras.
function bindRate(select, power) {
  select.addEventListener("change", () => {
    rates[power] = Number(select.value) * 1000;
    cells.forEach((state, name) => {
      if (!state.live && state.power === power) {
        stopSnapshots(name);
        startSnapshots(name);
      }
    });
  });
}
bindRate(usbSelect, "usb");
bindRate(batterySelect, "battery");

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    // Non-JSON (should not happen for /api/*).
  }
  if (!res.ok || (body && body.success === false)) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body ? body.data : null;
}

function show(el) {
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
}

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

async function loadCameras() {
  statusEl.textContent = "Loading cameras…";
  const cameras = await api("/api/cameras");
  gridEl.innerHTML = "";
  cells.clear();
  if (!cameras.length) {
    statusEl.textContent = "No cameras found on this Blink account.";
    return;
  }
  statusEl.textContent = `${cameras.length} camera(s) across your locations.`;

  // Group cameras by their Blink network (location), preserving order.
  const byNetwork = new Map();
  cameras.forEach((cam) => {
    const key = cam.network || "Unknown location";
    if (!byNetwork.has(key)) byNetwork.set(key, []);
    byNetwork.get(key).push(cam);
  });

  byNetwork.forEach((group, network) => {
    const section = document.createElement("section");
    section.className = "location";
    const title = document.createElement("h2");
    title.className = "location-title";
    title.textContent = `${network} · ${group.length} camera(s)`;
    const row = document.createElement("div");
    row.className = "grid";
    section.append(title, row);
    gridEl.appendChild(section);
    group.forEach((cam) => buildCell(cam, row));
  });
}

function buildCell(camera, container) {
  const name = camera.name;

  const cell = document.createElement("div");
  cell.className = "cell";

  const view = document.createElement("div");
  view.className = "view";
  const img = document.createElement("img");
  img.alt = name;
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.controls = true;
  hide(video);
  view.appendChild(img);
  view.appendChild(video);

  const bar = document.createElement("div");
  bar.className = "bar";
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = camera.power === "usb" ? "USB · indoor" : "battery · outdoor";
  const badge = document.createElement("span");
  badge.className = "badge";
  const liveBtn = document.createElement("button");
  liveBtn.textContent = "Go live";
  bar.append(label, tag, badge, liveBtn);

  const err = document.createElement("div");
  err.className = "err";

  cell.append(view, bar, err);
  container.appendChild(cell);

  const state = {
    img,
    video,
    badge,
    liveBtn,
    err,
    power: camera.power === "usb" ? "usb" : "battery",
    timer: null,
    hls: null,
    live: false,
  };
  cells.set(name, state);

  liveBtn.addEventListener("click", () => toggleLive(name));
  startSnapshots(name);
}

function startSnapshots(name) {
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

function stopSnapshots(name) {
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

async function stopLive(name) {
  const state = cells.get(name);
  state.liveBtn.disabled = true;
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
  hide(state.video);
  show(state.img);
  state.badge.textContent = "";
  state.badge.classList.remove("live");
  state.liveBtn.textContent = "Go live";
  state.liveBtn.disabled = false;
  state.live = false;
  startSnapshots(name);
}

boot();
