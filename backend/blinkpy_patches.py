"""Bug fixes for blinkpy's live-stream reader, applied at runtime.

blinkpy 0.25.9 ships a working Immedia handshake in `BlinkLiveStream.feed()`
(connect, send auth frames, keep-alive), but its `recv()` frames the incoming
IMMI stream with `StreamReader.read(n)`, which returns *up to* n bytes. Across
TLS record boundaries the very first 9-byte header read is often short, and the
code treats that as fatal and breaks — so no video ever reaches the client.
This is the "connects then 0 bytes / EOF" symptom.

We replace `recv()` with a `readexactly()`-framed version, and `poll()` with
one that tolerates a transient hiccup instead of tearing the session down on
the first non-`908` reply.

Upstream: https://github.com/fronzbot/blinkpy/issues/1262
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import ssl
from typing import Any

from blinkpy import api as blink_api
from blinkpy.livestream import BlinkLiveStream

_LOGGER = logging.getLogger(__name__)

HEADER_LENGTH = 9
MSGTYPE_VIDEO = 0x00
TS_SYNC_BYTE = 0x47  # MPEG-TS packets start with this.
MAX_PAYLOAD_LENGTH = 1 << 20  # 1 MiB sanity cap.

POLL_MAX_FAILURES = 5
STATUS_IN_PROGRESS = 908
RUNNING_STATES = frozenset({"new", "running"})


async def _recv_readexactly(self: Any) -> None:
    """Frame the IMMI stream with readexactly and forward video to clients."""

    try:
        while not self.target_reader.at_eof():
            header = await self.target_reader.readexactly(HEADER_LENGTH)
            msgtype = header[0]
            payload_length = int.from_bytes(header[5:9], byteorder="big")

            if payload_length <= 0:
                continue
            if payload_length > MAX_PAYLOAD_LENGTH:
                _LOGGER.warning("Implausible frame length %d; ending", payload_length)
                return

            payload = await self.target_reader.readexactly(payload_length)

            # Only forward regular video (MPEG-TS) payloads.
            if msgtype != MSGTYPE_VIDEO or payload[0] != TS_SYNC_BYTE:
                continue

            for writer in list(self.clients):
                if not writer.is_closing():
                    writer.write(payload)
                    await writer.drain()
            await asyncio.sleep(0)
    except asyncio.IncompleteReadError:
        _LOGGER.debug("Livestream closed by peer (EOF)")
    except (ConnectionResetError, BrokenPipeError, ssl.SSLError) as err:
        _LOGGER.debug("Livestream connection closed: %s", err)
    finally:
        if self.target_writer is not None and not self.target_writer.is_closing():
            self.target_writer.close()


async def _poll_tolerant(self: Any) -> None:
    """Keep the cloud command alive, surviving transient poll failures."""

    failures = 0
    try:
        while not self.target_reader.at_eof():
            try:
                response = await blink_api.request_command_status(
                    self.camera.sync.blink, self.camera.network_id, self.command_id
                )
            except Exception as err:  # noqa: BLE001 - transient network/API
                _LOGGER.debug("Command poll hiccup: %s", err)
                response = None

            if not response or response.get("status_code", 0) != STATUS_IN_PROGRESS:
                failures += 1
                if failures >= POLL_MAX_FAILURES:
                    _LOGGER.warning("Command polling failed %d times; ending", failures)
                    return
                await asyncio.sleep(self.polling_interval)
                continue

            failures = 0
            for command in response.get("commands", []):
                if command.get("id") == self.command_id:
                    if command.get("state_condition") not in RUNNING_STATES:
                        return
                    break
            await asyncio.sleep(self.polling_interval)
    finally:
        with contextlib.suppress(Exception):
            await blink_api.request_command_done(
                self.camera.sync.blink, self.camera.network_id, self.command_id
            )


def apply_patches() -> None:
    """Install the recv/poll fixes on BlinkLiveStream (idempotent)."""

    if getattr(BlinkLiveStream, "recv", None) is not _recv_readexactly:
        BlinkLiveStream.recv = _recv_readexactly
    if getattr(BlinkLiveStream, "poll", None) is not _poll_tolerant:
        BlinkLiveStream.poll = _poll_tolerant
