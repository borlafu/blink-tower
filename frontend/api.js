"use strict";

// Shared HTTP + visibility helpers used by every frontend module.

// The backend requires this header on state-changing API calls. A custom header
// cannot be sent cross-origin without a CORS preflight, which the app never
// grants — so this is what stops another site firing requests at your cameras.
const CSRF_HEADER = "X-Requested-With";
const CSRF_HEADER_VALUE = "blink-tower";

/**
 * Call a JSON API route and unwrap the {success, data, error} envelope.
 *
 * Throws an Error carrying the server's message (and HTTP status) so callers
 * can surface it directly to the user.
 */
export async function api(path, options) {
  const opts = { ...(options || {}) };
  opts.headers = { ...(opts.headers || {}), [CSRF_HEADER]: CSRF_HEADER_VALUE };
  const res = await fetch(path, opts);
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
