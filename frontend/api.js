"use strict";

// Shared HTTP + visibility helpers used by every frontend module.

/**
 * Call a JSON API route and unwrap the {success, data, error} envelope.
 *
 * Throws an Error carrying the server's message (and HTTP status) so callers
 * can surface it directly to the user.
 */
export async function api(path, options) {
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

export function show(el) {
  el.classList.remove("hidden");
}

export function hide(el) {
  el.classList.add("hidden");
}
