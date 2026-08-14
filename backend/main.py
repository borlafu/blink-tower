"""FastAPI app: serves the frontend and proxies Blink snapshots + live view.

Routes
------
GET  /                       -> single-page UI
GET  /api/status             -> {authenticated, needs_2fa}
POST /api/auth/start         -> begin login (may require 2FA)
POST /api/auth/verify        -> submit emailed 2FA pin
GET  /api/cameras            -> list cameras
GET  /api/snapshot/{name}    -> latest JPEG (near-live)
POST /api/liveview/{name}/start -> {playlist} HLS URL
POST /api/liveview/{name}/stop
GET  /hls/{name}/...         -> HLS playlist + segments (static)
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .access import (
    CSRF_HEADER,
    CSRF_HEADER_VALUE,
    has_csrf_header,
    is_request_allowed,
    requires_csrf_header,
)
from .blink_client import BlinkError, NotAuthenticated, client
from .blinkpy_patches import apply_patches
from .config import (
    ConfigError,
    ensure_ffmpeg_available,
    is_loopback_bind,
    settings,
)
from .liveview import LiveViewError, manager

# Sent on every response. hls.js builds its worker and MediaSource from blob:
# URLs, so media-src and worker-src must allow blob: — without them live view
# breaks silently while snapshots keep working.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "img-src 'self' data:; "
    "media-src 'self' blob:; "
    "worker-src blob:; "
    "script-src 'self'; "
    "style-src 'self'; "
    "connect-src 'self'; "
    "frame-ancestors 'none'"
)

SECURITY_HEADERS = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}

HLS_PREFIX = "/hls/"


def _ok(data=None) -> dict:
    return {"success": True, "data": data, "error": None}


def _err(message: str) -> dict:
    return {"success": False, "data": None, "error": message}


def _warn_if_exposed() -> None:
    """Warn early when the configured bind address is not loopback.

    This is only a hint: the real enforcement is the access gate below, which
    checks the peer address of every request and so cannot be bypassed by
    passing --host to uvicorn.
    """

    if is_loopback_bind(settings.host):
        return
    print(
        f"[blink-tower] WARNING: HOST is {settings.host!r}, not loopback. "
        "Non-local requests will be refused with 403 — this app has no login of "
        "its own, so authentication belongs to a reverse proxy or VPN in front "
        "of it. See deploy/README.md."
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    apply_patches()  # fix blinkpy's livestream reader before any live view.
    settings.hls_dir.mkdir(parents=True, exist_ok=True)
    _warn_if_exposed()
    try:
        ensure_ffmpeg_available()
    except ConfigError as exc:
        # Live view needs ffmpeg; snapshots do not. Warn, don't crash.
        print(f"[blink-tower] warning: {exc}")
    try:
        await client.authenticate()
    except BlinkError as exc:
        print(f"[blink-tower] Blink auth deferred: {exc}")
    yield
    await manager.stop_all()
    await client.close()


app = FastAPI(title="Blink Tower", lifespan=lifespan)

# Serve HLS output and static frontend assets. check_dir=False so mounts do
# not fail before the directory is created in lifespan.
app.mount("/hls", StaticFiles(directory=str(settings.hls_dir), check_dir=False), name="hls")
app.mount(
    "/static",
    StaticFiles(directory=str(settings.frontend_dir), check_dir=False),
    name="static",
)


@app.middleware("http")
async def access_gate(request: Request, call_next):
    """Refuse non-local requests, enforce CSRF, and add hardening headers.

    Runs before the StaticFiles mounts, so it covers /hls (live video segments)
    and /static as well as the API. Gating only /api/* would leave the video
    stream readable at a guessable path.
    """

    if not is_request_allowed(request):
        return JSONResponse(
            status_code=403,
            content=_err(
                "Refused: this app only accepts requests from the machine it runs "
                "on. Authentication belongs to a reverse proxy or VPN in front of "
                "it — see deploy/README.md. If you ARE behind a local reverse "
                "proxy, start uvicorn with --no-proxy-headers: enabled proxy "
                "headers (uvicorn's default) replace the peer address with "
                "X-Forwarded-For, which makes every forwarded client look remote."
            ),
        )

    if requires_csrf_header(request.method, request.url.path) and not has_csrf_header(
        request.headers
    ):
        return JSONResponse(
            status_code=403,
            content=_err(
                f"Missing {CSRF_HEADER}: {CSRF_HEADER_VALUE} header. This blocks "
                "cross-site requests; use the app's own UI."
            ),
        )

    response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    if request.url.path.startswith(HLS_PREFIX):
        # Live segments are per-session and deleted on stop; never cache them.
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(NotAuthenticated)
async def _not_authenticated(_: Request, exc: NotAuthenticated) -> JSONResponse:
    return JSONResponse(status_code=401, content=_err(str(exc)))


@app.exception_handler(BlinkError)
async def _blink_error(_: Request, exc: BlinkError) -> JSONResponse:
    return JSONResponse(status_code=503, content=_err(str(exc)))


@app.exception_handler(LiveViewError)
async def _liveview_error(_: Request, exc: LiveViewError) -> JSONResponse:
    return JSONResponse(status_code=503, content=_err(str(exc)))


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(settings.frontend_dir / "index.html")


@app.get("/api/status")
async def status() -> dict:
    return _ok({"authenticated": client.authenticated, "needs_2fa": client.needs_2fa})


@app.post("/api/auth/start")
async def auth_start() -> dict:
    await client.authenticate()
    return _ok({"authenticated": client.authenticated, "needs_2fa": client.needs_2fa})


class VerifyBody(BaseModel):
    pin: str


@app.post("/api/auth/verify")
async def auth_verify(body: VerifyBody) -> dict:
    await client.verify_2fa(body.pin)
    return _ok({"authenticated": client.authenticated, "needs_2fa": client.needs_2fa})


@app.get("/api/cameras")
async def cameras() -> dict:
    infos = client.list_cameras()
    return _ok([info.__dict__ for info in infos])


@app.get("/api/snapshot/{name}")
async def snapshot(name: str) -> Response:
    image = await client.get_snapshot(name)
    return Response(
        content=image,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/liveview/{name}/start")
async def liveview_start(name: str) -> dict:
    relpath = await manager.start(name)
    return _ok({"playlist": f"/hls/{relpath}"})


@app.post("/api/liveview/{name}/stop")
async def liveview_stop(name: str) -> dict:
    await manager.stop(name)
    return _ok({"stopped": True})


def run() -> None:
    """Entry point for `python -m backend.main`."""

    import uvicorn

    # proxy_headers must stay off: the access gate authorizes on the real peer
    # address, and uvicorn's default (True) would replace it with the
    # X-Forwarded-For value. See backend/access.py.
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        proxy_headers=False,
    )


if __name__ == "__main__":
    run()
