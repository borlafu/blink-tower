"""Thin async wrapper around blinkpy.

Owns a single authenticated Blink session and exposes the small surface the
web app needs: authentication (with one-time 2FA), camera listing, throttled
snapshots, and liveview URL retrieval.

Blink is a cloud service: there is no local API even when cameras share your
wifi. All calls here go through Blink's servers.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from aiohttp import ClientSession
from blinkpy.auth import Auth
from blinkpy.blinkpy import Blink, BlinkTwoFARequiredError
from blinkpy.camera import BlinkCameraMini
from blinkpy.helpers.util import json_load

# Blink product types that are USB/wired (indoor) rather than battery.
USB_PRODUCT_TYPES = {"owl", "hawk"}

# The cached session file holds account tokens: owner-only, never group/world.
CREDS_FILE_MODE = 0o600

from .config import settings


class BlinkError(RuntimeError):
    """Raised for recoverable Blink interaction failures."""


class NotAuthenticated(BlinkError):
    """Raised when an operation needs an authenticated session."""


@dataclass(frozen=True)
class CameraInfo:
    """Immutable view of a camera for the API layer."""

    name: str
    network: str
    power: str  # "usb" (indoor/wired) or "battery" (outdoor)
    battery: Optional[str]
    temperature: Optional[float]


class BlinkClient:
    """Manages one Blink session for the whole app."""

    def __init__(self) -> None:
        self._session: Optional[ClientSession] = None
        self._blink: Optional[Blink] = None
        self._auth_lock = asyncio.Lock()
        self._cam_locks: dict[str, asyncio.Lock] = {}
        self._last_snap: dict[str, float] = {}
        self._needs_2fa = False
        self._authenticated = False

    @property
    def authenticated(self) -> bool:
        return self._authenticated

    @property
    def needs_2fa(self) -> bool:
        return self._needs_2fa

    async def _new_session(self) -> ClientSession:
        if self._session is None or self._session.closed:
            self._session = ClientSession()
        return self._session

    async def authenticate(self) -> None:
        """Log in, reusing a cached session file when present.

        Sets ``needs_2fa`` when Blink emailed a verification pin; the caller
        then routes the user to ``verify_2fa``.
        """

        async with self._auth_lock:
            if self._authenticated:
                return

            session = await self._new_session()

            if settings.creds_path.exists():
                creds = await json_load(str(settings.creds_path))
            else:
                creds = {
                    "username": settings.blink_username,
                    "password": settings.blink_password,
                }

            blink = Blink(session=session)
            blink.auth = Auth(creds, no_prompt=True, session=session)
            self._blink = blink

            try:
                logged_in = await blink.start()
            except BlinkTwoFARequiredError:
                # Blink emailed a 2FA pin; wait for the user to submit it.
                self._needs_2fa = True
                return
            except Exception as exc:  # blinkpy raises broad errors on bad creds
                raise BlinkError(f"Blink login failed: {exc}") from exc

            if not logged_in:
                raise BlinkError(
                    "Blink login failed. Check BLINK_USERNAME / BLINK_PASSWORD."
                )

            await self._finalize_login()

    async def verify_2fa(self, pin: str) -> None:
        """Complete login using the emailed 2FA pin."""

        pin = (pin or "").strip()
        if not pin:
            raise BlinkError("2FA pin is required.")
        if self._blink is None:
            raise NotAuthenticated("Call authenticate() before verifying 2FA.")

        async with self._auth_lock:
            try:
                verified = await self._blink.auth.complete_2fa_login(pin)
                if not verified:
                    raise BlinkError("2FA verification failed. Check the pin.")
                # Finish setup now that tokens are in place.
                if not await self._blink.start():
                    raise BlinkError("Setup failed after 2FA.")
            except BlinkError:
                raise
            except Exception as exc:
                raise BlinkError(f"2FA verification failed: {exc}") from exc

            self._needs_2fa = False
            await self._finalize_login()

    async def _finalize_login(self) -> None:
        assert self._blink is not None
        # Persist the session so 2FA is only needed once.
        await self._blink.save(str(settings.creds_path))
        _restrict_perms(settings.creds_path)
        self._authenticated = True

    def _get_camera(self, name: str):
        if not self._authenticated or self._blink is None:
            raise NotAuthenticated("Not logged in to Blink.")
        camera = self._blink.cameras.get(name)
        if camera is None:
            raise BlinkError(f"Unknown camera {name!r}.")
        return camera

    def list_cameras(self) -> list[CameraInfo]:
        """Return cameras grouped by their Blink network (location).

        Each Blink sync module is a location (e.g. "Home", "Parents"), so we
        walk the sync modules and tag every camera with its network name.
        """

        if not self._authenticated or self._blink is None:
            raise NotAuthenticated("Not logged in to Blink.")

        infos: list[CameraInfo] = []
        seen: set[str] = set()
        for sync in self._blink.sync.values():
            network = getattr(sync, "name", None) or "Unknown location"
            for name, cam in sync.cameras.items():
                infos.append(_camera_info(name, network, cam))
                seen.add(name)

        # Fallback: include any camera not attached to a discovered sync module.
        for name, cam in self._blink.cameras.items():
            if name not in seen:
                infos.append(_camera_info(name, "Unknown location", cam))

        return infos

    def _lock_for(self, name: str) -> asyncio.Lock:
        return self._cam_locks.setdefault(name, asyncio.Lock())

    async def get_snapshot(self, name: str) -> bytes:
        """Return the latest JPEG for a camera.

        Triggers a fresh capture only when the min interval has elapsed (or the
        cache is empty), otherwise serves the last cached frame. This keeps 5s
        polling from hammering Blink / draining the camera battery.
        """

        camera = self._get_camera(name)
        async with self._lock_for(name):
            elapsed = time.monotonic() - self._last_snap.get(name, 0.0)
            cached = camera.image_from_cache
            stale = elapsed >= settings.snapshot_min_interval_seconds
            if cached is None or stale:
                try:
                    await camera.snap_picture()
                    await self._blink.refresh(force=True)  # type: ignore[union-attr]
                except Exception as exc:
                    raise BlinkError(f"Snapshot failed for {name!r}: {exc}") from exc
                self._last_snap[name] = time.monotonic()

            image = camera.image_from_cache
            if image is None:
                raise BlinkError(f"No image available yet for {name!r}.")
            return image

    def get_camera(self, name: str):
        """Return the underlying blinkpy camera object (for live streaming)."""

        return self._get_camera(name)

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()


def _restrict_perms(path: Path) -> None:
    """Tighten the cached session file to owner-only access.

    Best effort: on filesystems that reject chmod we warn rather than fail the
    login, but never stay silent about it.
    """

    try:
        os.chmod(path, CREDS_FILE_MODE)
    except OSError as exc:
        print(
            f"[blink-tower] WARNING: could not restrict permissions on {path} "
            f"({exc}). It holds your Blink tokens — fix it with "
            f"`chmod 600 {path}`."
        )


def _power_source(cam) -> str:
    """Classify a camera as USB (indoor/wired) or battery (outdoor).

    Blink Minis (product type "owl"/"hawk", class BlinkCameraMini) are wired
    USB indoor cameras; everything else (Outdoor/Indoor, doorbells) runs on
    batteries.
    """

    if isinstance(cam, BlinkCameraMini):
        return "usb"
    if getattr(cam, "product_type", None) in USB_PRODUCT_TYPES:
        return "usb"
    return "battery"


def _camera_info(name: str, network: str, cam) -> CameraInfo:
    """Build a CameraInfo from a blinkpy camera object."""

    attrs = getattr(cam, "attributes", {}) or {}
    return CameraInfo(
        name=name,
        network=network,
        power=_power_source(cam),
        battery=attrs.get("battery"),
        temperature=attrs.get("temperature"),
    )


# Single shared client for the app.
client = BlinkClient()
