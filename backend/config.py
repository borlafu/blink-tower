"""Application configuration loaded from environment variables.

Fails fast at import time if required Blink credentials are missing so the
server never starts in a half-configured state.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# Root of the project (parent of the backend package).
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Default limits / paths. No magic numbers scattered through the code.
# Protective floor between forced captures per camera; the UI refresh-rate
# selector drives the actual polling cadence (never below this floor).
DEFAULT_SNAPSHOT_MIN_INTERVAL_SECONDS = 2.0
DEFAULT_LIVEVIEW_MAX_SECONDS = 280.0  # Blink caps live sessions ~5 min.
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000

# Bind addresses that only accept connections from this machine.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


class ConfigError(RuntimeError):
    """Raised when the environment is not configured correctly."""


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of runtime configuration."""

    blink_username: str
    blink_password: str
    creds_path: Path
    hls_dir: Path
    frontend_dir: Path
    snapshot_min_interval_seconds: float
    liveview_max_seconds: float
    host: str
    port: int


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"Missing required environment variable {name!r}. "
            "Copy .env.example to .env and fill in your Blink credentials."
        )
    return value


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"Environment variable {name!r} must be a number.") from exc


def load_settings() -> Settings:
    """Build the settings object, validating required inputs."""

    return Settings(
        blink_username=_require("BLINK_USERNAME"),
        blink_password=_require("BLINK_PASSWORD"),
        creds_path=Path(
            os.environ.get("BLINK_CREDS_PATH", PROJECT_ROOT / "blink_creds.json")
        ),
        hls_dir=Path(os.environ.get("HLS_DIR", PROJECT_ROOT / "hls_tmp")),
        frontend_dir=PROJECT_ROOT / "frontend",
        snapshot_min_interval_seconds=_float_env(
            "SNAPSHOT_MIN_INTERVAL_SECONDS", DEFAULT_SNAPSHOT_MIN_INTERVAL_SECONDS
        ),
        liveview_max_seconds=_float_env(
            "LIVEVIEW_MAX_SECONDS", DEFAULT_LIVEVIEW_MAX_SECONDS
        ),
        host=os.environ.get("HOST", DEFAULT_HOST),
        port=int(os.environ.get("PORT", DEFAULT_PORT)),
    )


def is_loopback_bind(host: str) -> bool:
    """Return True when ``host`` only accepts connections from this machine.

    The app has no authentication, so a non-loopback bind exposes the cameras
    to everyone on the network. Callers warn the user in that case.
    """

    return host.strip().lower() in LOOPBACK_HOSTS


def ensure_ffmpeg_available() -> None:
    """Verify the ffmpeg binary is on PATH (needed for liveview)."""

    if shutil.which("ffmpeg") is None:
        raise ConfigError(
            "ffmpeg not found on PATH. Install it (e.g. `brew install ffmpeg`) "
            "to enable live view. Snapshot mode works without it."
        )


settings = load_settings()
