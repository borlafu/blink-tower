"use strict";

// Formatters that turn a /api/cameras record into the chips and detail rows
// shown on a tile. Pure: they build DOM nodes and strings, and never touch
// network state or the layout store.
//
// Everything is rendered with textContent (never innerHTML) because camera names
// and firmware strings arrive from the Blink cloud.

// Blink's signal scales are undocumented small integers, so values are drawn as
// bars with the raw number kept in the tooltip. Never invent a percentage.
const BATTERY_LEVEL_MAX = 3;
const SIGNAL_BARS_MAX = 5;
const FILLED_BAR = "▮";
const EMPTY_BAR = "▯";

// dBm window used when a signal reading is negative: -50 or better reads full,
// -90 or worse reads empty.
const DBM_BEST = -50;
const DBM_WORST = -90;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

function isPresent(value) {
  return value !== null && value !== undefined && value !== "";
}

/** Render ``value`` out of ``max`` as filled/empty bars. */
function bars(value, max) {
  const filled = Math.max(0, Math.min(max, Math.round(value)));
  return FILLED_BAR.repeat(filled) + EMPTY_BAR.repeat(max - filled);
}

/**
 * Map a wifi/LFR reading onto a 0-5 bar scale.
 *
 * Blink reports either a small positive scale (roughly 1-5) or a negative dBm
 * value depending on the model, so both are handled.
 */
function signalBars(value) {
  if (value <= 0) {
    const span = DBM_BEST - DBM_WORST;
    const normalized = (value - DBM_WORST) / span;
    return bars(normalized * SIGNAL_BARS_MAX, SIGNAL_BARS_MAX);
  }
  return bars(value, SIGNAL_BARS_MAX);
}

/** Format 100ths of a volt (Blink's unit) as volts. */
function formatVoltage(hundredths) {
  return `${(hundredths / 100).toFixed(2)} V`;
}

function formatTemperature(camera) {
  const parts = [];
  if (isPresent(camera.temperature_f)) {
    parts.push(`${Math.round(camera.temperature_f)}°F`);
  }
  if (isPresent(camera.temperature_c)) parts.push(`${camera.temperature_c}°C`);
  return parts.join(" / ");
}

/** Human-readable age of an ISO 8601 timestamp, or null when absent. */
export function formatAge(isoString) {
  if (!isPresent(isoString)) return null;
  const then = Date.parse(isoString);
  if (Number.isNaN(then)) return String(isoString);

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < SECONDS_PER_MINUTE) return "just now";
  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ago`;
  }
  if (seconds < SECONDS_PER_DAY) {
    return `${Math.floor(seconds / SECONDS_PER_HOUR)}h ago`;
  }
  return `${Math.floor(seconds / SECONDS_PER_DAY)}d ago`;
}

/**
 * The chips shown in the tile bar: [{text, title, className}].
 *
 * Fields Blink did not report are omitted rather than rendered as "null" or a
 * placeholder dash. Battery chips only appear for battery-powered cameras.
 */
export function chipsFor(camera) {
  const chips = [];

  chips.push(
    camera.online
      ? { text: "● online", title: "Camera is reachable", className: "ok" }
      : {
          text: "○ offline",
          title: "Blink reports this camera offline",
          className: "warn",
        }
  );

  if (isPresent(camera.model)) {
    chips.push({
      text: camera.model,
      title: isPresent(camera.product_type)
        ? `Model (Blink type "${camera.product_type}")`
        : "Model",
    });
  }

  if (camera.power !== "usb") {
    // Bars when Blink reports a level; otherwise the raw voltage, which most
    // models do report. Never a derived percentage.
    if (isPresent(camera.battery_level)) {
      chips.push({
        text: `🔋 ${bars(camera.battery_level, BATTERY_LEVEL_MAX)}`,
        title:
          `Battery level ${camera.battery_level} of ${BATTERY_LEVEL_MAX} ` +
          "(Blink's own scale, not a percentage)",
      });
    } else if (isPresent(camera.battery_voltage)) {
      chips.push({
        text: `🔋 ${formatVoltage(camera.battery_voltage)}`,
        title: "Battery voltage reported by Blink (no level reported for this model)",
      });
    }
    if (isPresent(camera.battery_state)) {
      chips.push({
        text: camera.battery_state,
        title: "Battery state reported by Blink",
        className: camera.battery_state === "ok" ? "ok" : "warn",
      });
    }
  }

  if (isPresent(camera.wifi_strength)) {
    chips.push({
      text: `wifi ${signalBars(camera.wifi_strength)}`,
      title: `Wifi signal (raw value ${camera.wifi_strength})`,
    });
  }

  if (isPresent(camera.sync_signal_strength)) {
    chips.push({
      text: `sync ${signalBars(camera.sync_signal_strength)}`,
      title: `Signal to the sync module (raw LFR value ${camera.sync_signal_strength})`,
    });
  }

  const temperature = formatTemperature(camera);
  if (temperature) {
    chips.push({ text: temperature, title: "Temperature reported by the camera" });
  }

  // Strictly a boolean: Blink reports the string "unknown" when the camera
  // config is missing, which must not read as "motion on".
  if (typeof camera.motion_enabled === "boolean") {
    chips.push({
      text: camera.motion_enabled ? "motion on" : "motion off",
      title: "Blink motion detection setting",
    });
  }

  return chips;
}

/** The label/value pairs shown in the collapsible details panel. */
export function detailsFor(camera) {
  const rows = [];
  const add = (label, value) => {
    if (isPresent(value)) rows.push({ label, value: String(value) });
  };

  add("Model", camera.model);
  add("Blink type", camera.product_type);
  add("Firmware", camera.firmware);
  add("Serial", camera.serial);
  add("Camera id", camera.camera_id);
  if (camera.power !== "usb" && isPresent(camera.battery_voltage)) {
    add("Battery voltage", formatVoltage(camera.battery_voltage));
  }
  add("Last motion clip", formatAge(camera.last_record));
  add("Location", camera.network);
  return rows;
}

/** Replace the contents of ``container`` with the chips for ``camera``. */
export function renderChips(container, camera) {
  container.replaceChildren(
    ...chipsFor(camera).map((chip) => {
      const el = document.createElement("span");
      el.className = chip.className ? `tag ${chip.className}` : "tag";
      el.textContent = chip.text;
      if (chip.title) el.title = chip.title;
      return el;
    })
  );
}

/** Replace the contents of ``container`` with the detail rows for ``camera``. */
export function renderDetails(container, camera) {
  container.replaceChildren(
    ...detailsFor(camera).map((row) => {
      const line = document.createElement("div");
      line.className = "detail-row";
      const label = document.createElement("span");
      label.className = "detail-label";
      label.textContent = row.label;
      const value = document.createElement("span");
      value.className = "detail-value";
      value.textContent = row.value;
      line.append(label, value);
      return line;
    })
  );
}
