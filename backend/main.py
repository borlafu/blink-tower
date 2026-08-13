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

from .blink_client import BlinkError, NotAuthenticated, client
from .blinkpy_patches import apply_patches
from .config import (
    ConfigError,
    ensure_ffmpeg_available,
    is_loopback_bind,
    settings,
)
from .liveview import LiveViewError, manager


def _ok(data=None) -> dict:
    return {"success": True, "data": data, "error": None}


def _err(message: str) -> dict:
    return {"success": False, "data": None, "error": message}


def _warn_if_exposed() -> None:
    """Warn loudly when the configured bind address is not loopback.

    There is no login on this app: reaching the port is enough to see the
    cameras. Note this checks the HOST setting only — passing --host to uvicorn
    directly bypasses it.
    """

    if is_loopback_bind(settings.host):
        return
    print(
        f"[blink-tower] WARNING: HOST is {settings.host!r}, not loopback. "
        "This app has NO authentication — anyone who can reach this port can "
        "view your cameras and start live streams. Put it behind a VPN or "
        "authenticating reverse proxy, or use the default 127.0.0.1."
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

    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
