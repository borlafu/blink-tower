"""Filesystem-name helpers.

Camera names come from the Blink cloud account and end up as directory names
under the HLS output dir (which is recursively deleted between sessions), so
they are sanitized to a single safe path segment before touching the disk.
"""

from __future__ import annotations

import re

# Anything outside this set becomes an underscore.
_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9 ._-]+")
_FALLBACK_NAME = "camera"
MAX_SEGMENT_LENGTH = 64


class UnsafeNameError(ValueError):
    """Raised when a name cannot be reduced to a usable path segment."""


def safe_dir_name(name: str) -> str:
    """Reduce ``name`` to one safe path segment (no separators, no traversal).

    >>> safe_dir_name("Mini - 3SPK")
    'Mini - 3SPK'
    >>> safe_dir_name("../../etc")
    '.._.._etc'
    """

    if not isinstance(name, str) or not name.strip():
        raise UnsafeNameError("Camera name is empty.")

    cleaned = _UNSAFE_CHARS.sub("_", name.strip())[:MAX_SEGMENT_LENGTH].strip()

    # ".", ".." and dot-only names would escape or hide the directory.
    if not cleaned or set(cleaned) <= {"."}:
        return _FALLBACK_NAME
    return cleaned
