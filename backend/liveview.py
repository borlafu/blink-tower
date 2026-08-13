"""On-demand live view: blinkpy's Immedia stream -> ffmpeg -> browser HLS.

blinkpy handles the proprietary Immedia protocol (TLS connect, auth frames,
keep-alive ping, cloud command polling) inside `BlinkLiveStream.feed()`. We
patch its buggy reader (see backend.blinkpy_patches), attach a sink that pipes
the MPEG-TS payloads into ffmpeg, and ffmpeg repackages them as HLS.

Sessions are best-effort: Blink caps them (~5 min) and they drain the camera
battery, so each has a hard timeout and an explicit stop.
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import IO, Optional

from .blink_client import BlinkError, client
from .config import settings
from .paths import UnsafeNameError, safe_dir_name

HLS_SEGMENT_SECONDS = 2
HLS_PLAYLIST_SIZE = 5
PLAYLIST_NAME = "index.m3u8"


class LiveViewError(RuntimeError):
    """Raised when a live view session cannot be started."""


class _FfmpegSink:
    """Blinkpy writes MPEG-TS payloads here; we forward them to ffmpeg stdin."""

    def __init__(self, writer: asyncio.StreamWriter) -> None:
        self._writer = writer
        self._closed = False

    def write(self, data: bytes) -> None:
        if not self._closed:
            self._writer.write(data)

    async def drain(self) -> None:
        if not self._closed:
            try:
                await self._writer.drain()
            except (ConnectionError, BrokenPipeError):
                self._closed = True

    def is_closing(self) -> bool:
        return self._closed or self._writer.is_closing()

    def close(self) -> None:
        self._closed = True


class _Session:
    """One live pipeline (ffmpeg + blinkpy feed) for one camera."""

    def __init__(self, camera: str, directory: Path) -> None:
        self.camera = camera
        self.directory = directory
        self.process: Optional[asyncio.subprocess.Process] = None
        self.stream = None  # blinkpy BlinkLiveStream
        self.sink: Optional[_FfmpegSink] = None
        self.log_file: Optional[IO[bytes]] = None  # ffmpeg stdout/stderr sink
        self.tasks: list[asyncio.Task] = []


class LiveViewManager:
    """Tracks at most one live session per camera."""

    def __init__(self) -> None:
        self._sessions: dict[str, _Session] = {}
        self._lock = asyncio.Lock()

    def playlist_relpath(self, camera: str) -> str:
        """URL path (under /hls) for a camera's playlist.

        Must use the same sanitized segment as ``_directory_for``.
        """

        return f"{safe_dir_name(camera)}/{PLAYLIST_NAME}"

    def _directory_for(self, camera: str) -> Path:
        try:
            return settings.hls_dir / safe_dir_name(camera)
        except UnsafeNameError as exc:
            raise LiveViewError(f"Unusable camera name: {exc}") from exc

    async def start(self, camera: str) -> str:
        """Start the pipeline and return the HLS playlist relpath."""

        async with self._lock:
            await self._stop_unlocked(camera)

            cam = client.get_camera(camera)  # raises BlinkError if unknown
            try:
                stream = await cam.init_livestream()
            except NotImplementedError as exc:
                raise LiveViewError(
                    f"This camera does not support live view: {exc}"
                ) from exc
            except BlinkError:
                raise
            except Exception as exc:
                raise LiveViewError(
                    f"Blink refused the live view (throttled/offline): {exc}"
                ) from exc

            directory = self._directory_for(camera)
            _reset_dir(directory)

            proc, log_file = await self._spawn_ffmpeg(directory)
            sess = _Session(camera, directory)
            sess.process = proc
            sess.log_file = log_file
            sess.stream = stream
            sess.sink = _FfmpegSink(proc.stdin)  # type: ignore[arg-type]
            stream.clients.append(sess.sink)

            sess.tasks.append(asyncio.create_task(self._run_feed(sess)))
            sess.tasks.append(
                asyncio.create_task(
                    self._auto_stop(camera, settings.liveview_max_seconds)
                )
            )
            self._sessions[camera] = sess

        await self._wait_for_playlist(camera, directory)
        return self.playlist_relpath(camera)

    async def _spawn_ffmpeg(
        self, directory: Path
    ) -> tuple[asyncio.subprocess.Process, IO[bytes]]:
        """Start ffmpeg; the caller owns closing the returned log handle."""

        playlist = directory / PLAYLIST_NAME
        log = open(directory / "ffmpeg.log", "wb")
        args = [
            "ffmpeg",
            "-hide_banner",
            "-fflags",
            "nobuffer",
            "-i",
            "pipe:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-f",
            "hls",
            "-hls_time",
            str(HLS_SEGMENT_SECONDS),
            "-hls_list_size",
            str(HLS_PLAYLIST_SIZE),
            "-hls_flags",
            "delete_segments+append_list+omit_endlist",
            str(playlist),
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=log,
                stderr=log,
            )
        except FileNotFoundError as exc:
            log.close()
            raise LiveViewError("ffmpeg not found on PATH.") from exc
        return proc, log

    async def _run_feed(self, sess: _Session) -> None:
        """Run blinkpy's feed loop; tear the session down when it ends."""

        try:
            await sess.stream.feed()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Blink ends sessions on its own schedule; report, then tear down.
            print(f"[blink-tower] live feed for {sess.camera!r} ended: {exc}")
        finally:
            asyncio.create_task(self.stop(sess.camera))

    async def _auto_stop(self, camera: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        await self.stop(camera)

    async def _wait_for_playlist(
        self, camera: str, directory: Path, attempts: int = 40
    ) -> None:
        playlist = directory / PLAYLIST_NAME
        for _ in range(attempts):
            if playlist.exists() and playlist.stat().st_size > 0:
                return
            sess = self._sessions.get(camera)
            if sess and sess.process and sess.process.returncode is not None:
                break
            await asyncio.sleep(0.5)

        await self.stop(camera)
        raise LiveViewError(
            "Live view did not start. The camera may be offline/busy or the "
            "Blink session expired. See hls_tmp/<camera>/ffmpeg.log."
        )

    async def stop(self, camera: str) -> None:
        async with self._lock:
            await self._stop_unlocked(camera)

    async def _stop_unlocked(self, camera: str) -> None:
        sess = self._sessions.pop(camera, None)
        if sess is None:
            return

        if sess.sink is not None:
            sess.sink.close()
        for task in sess.tasks:
            task.cancel()
        if sess.stream is not None:
            try:
                sess.stream.stop()
            except Exception as exc:
                print(f"[blink-tower] stopping stream {sess.camera!r} failed: {exc}")

        proc = sess.process
        if proc is not None and proc.returncode is None:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()

        if sess.log_file is not None and not sess.log_file.closed:
            sess.log_file.close()

        _reset_dir(sess.directory)

    def is_live(self, camera: str) -> bool:
        sess = self._sessions.get(camera)
        return sess is not None and sess.process is not None and (
            sess.process.returncode is None
        )

    async def stop_all(self) -> None:
        for camera in list(self._sessions.keys()):
            await self.stop(camera)


def _reset_dir(directory: Path) -> None:
    """Clear and recreate a camera's HLS directory."""

    if directory.exists():
        shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True, exist_ok=True)


manager = LiveViewManager()
