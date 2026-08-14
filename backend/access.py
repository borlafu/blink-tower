"""The app's single authorization decision, plus its CSRF rule.

This app has no login of its own: authentication is delegated to whatever sits in
front of it (a reverse proxy asking for a password, or a VPN like Tailscale). The
app's job is to *enforce* that arrangement — it refuses any request that did not
arrive over loopback, so a mistaken bind address fails closed instead of quietly
publishing every camera.

Keeping the decision in one small, pure module means there is exactly one place to
read, review, and later change. See ``deploy/README.md`` for the deployment
recipes this assumes.
"""

from __future__ import annotations

from typing import Optional

# Peer *addresses* that mean "this machine".
#
# Deliberately NOT the same thing as config.LOOPBACK_HOSTS, which holds bind
# *host strings* and includes "localhost" — a name that never appears as a peer
# address. Do not merge the two: a hostname in this set would never match, and a
# raw address in that one would not be a valid bind check.
LOOPBACK_PEERS = frozenset({"127.0.0.1", "::1", "::ffff:127.0.0.1"})

# Paths served without the gate. Empty of anything sensitive on purpose; it
# exists so that an app-level login page has an obvious home later.
PUBLIC_PATHS = frozenset({"/favicon.ico"})

# HTTP methods that change state and therefore need CSRF protection.
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Custom header required on state-changing API calls. Any custom header forces a
# CORS preflight, which this app never grants, so a cross-origin "simple POST"
# cannot reach a handler.
CSRF_HEADER = "x-requested-with"
CSRF_HEADER_VALUE = "blink-tower"

API_PREFIX = "/api/"


def is_loopback_peer(host: Optional[str]) -> bool:
    """Return True when ``host`` is this machine.

    ``None`` means the server could not tell us the peer address; that is treated
    as untrusted, never as local.
    """

    if not host:
        return False
    return host.strip().lower() in LOOPBACK_PEERS


def is_public_path(path: str) -> bool:
    return path in PUBLIC_PATHS


def is_request_allowed(request) -> bool:
    """THE authorization decision for the whole app.

    Today: the request must come from this machine, because authentication is
    delegated to a proxy or VPN running here that forwards over loopback.

    To add an app-level login later this becomes::

        return is_loopback_peer(peer) or has_valid_session(request)

    and nothing else about the gate changes.

    Note: this reads the peer address from the ASGI scope, so the server must run
    with ``--no-proxy-headers``. Uvicorn enables proxy headers *by default*, and
    when enabled it overwrites the peer with the ``X-Forwarded-For`` value — so a
    reverse proxy forwarding a LAN client would make that client look remote and
    every request would be refused. ``run()`` in main.py sets this correctly; the
    deploy examples pass the flag explicitly.

    Never combine proxy headers with ``--forwarded-allow-ips '*'``: that would let
    any client spoof ``X-Forwarded-For: 127.0.0.1`` and walk straight through this
    check.
    """

    if is_public_path(request.url.path):
        return True
    peer = request.client.host if request.client else None
    return is_loopback_peer(peer)


def requires_csrf_header(method: str, path: str) -> bool:
    """Return True when a request must carry the CSRF header to be accepted.

    Applies to state-changing API calls. Relevant even without cookies: browsers
    cache HTTP basic-auth credentials and will attach them to cross-site
    requests, so a proxy password alone does not stop a hostile page from firing
    a POST at us.
    """

    return method.upper() in UNSAFE_METHODS and path.startswith(API_PREFIX)


def has_csrf_header(headers) -> bool:
    """Check the CSRF header on a mapping of request headers (case-insensitive)."""

    return headers.get(CSRF_HEADER, "").strip().lower() == CSRF_HEADER_VALUE
