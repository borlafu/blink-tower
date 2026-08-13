# Blink Tower

**Every camera. One wall.** —
[borlafu.github.io/blink-tower](https://borlafu.github.io/blink-tower/)

Self-hosted web app to watch **all your Blink cameras at once**, side by side,
grouped by location.

## How it works (and the Blink reality)

Blink has **no local API** — even though your cameras are on your wifi, every
request goes through Blink's cloud and needs your Blink account credentials
(plus a one-time 2FA pin). Blink battery cameras are also not built for
continuous streaming. So this app is a **hybrid**:

- **Snapshot grid (default):** every camera shown side by side, **grouped by
  location** (one group per Blink sync module / network). Cameras are split by
  power source — **USB/indoor** (Blink Mini) vs **battery/outdoor** — and the two
  groups refresh at independent rates chosen in the UI header (USB default 5s;
  battery default 1 min, to spare the battery). Reliable, near-live.
  Each tile shows what Blink reports about the camera: online state, model,
  battery level and state, wifi and sync-module signal, temperature and motion
  setting, with serial, firmware and last motion clip under **Details**.
- **Live view (on demand):** a per-camera "Go live" button opens Blink's real
  video stream. Blink uses a proprietary Immedia protocol over TLS (not RTSP);
  blinkpy speaks it, and `ffmpeg` repackages the MPEG-TS into browser HLS.
  Best-effort — Blink caps sessions (~5 min) and it drains the camera battery,
  so each session has a hard timeout and an explicit Stop.

  > Note: blinkpy 0.25.9's live-stream reader has a framing bug that delivers
  > zero video ([fronzbot/blinkpy#1262](https://github.com/fronzbot/blinkpy/issues/1262));
  > `backend/blinkpy_patches.py` patches it at startup.

Built on [`blinkpy`](https://github.com/fronzbot/blinkpy) (auth, snapshots,
liveview) + FastAPI + a vanilla JS frontend using
[`hls.js`](https://github.com/video-dev/hls.js).

## Requirements

- Python 3.10+
- `ffmpeg` on your PATH (only needed for live view; snapshots work without it)
  - macOS: `brew install ffmpeg`

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# edit .env: set BLINK_USERNAME and BLINK_PASSWORD
```

## Run

```bash
uvicorn backend.main:app
# then open http://localhost:8000
```

First launch:

1. Click **Connect to Blink**.
2. Blink emails a **2FA pin** — enter it in the app.
3. The session is cached to `blink_creds.json`, so 2FA is only needed once.
4. Your cameras appear grouped by location and start refreshing.

Click **Go live** on a camera for real video; **Stop live** returns to
snapshots.

## Arranging the grid

- **Reorder:** grab a tile by the **⠿** handle in its title bar and drag it to a
  new slot. Reordering is within a location — tiles do not move between Blink
  networks.
- **Hide / show:** **Hide** removes a tile and **stops polling it**, so a camera
  you never watch costs no Blink cloud calls and no battery. Hidden cameras
  appear as **Show `<name>`** buttons under their location, next to a
  **Show all** shortcut.
- Order and hidden cameras are remembered **per browser** (`localStorage`, key
  `blink-tower.layout.v1`) — not per Blink account, so a different browser or
  device starts from the default layout. Clearing site data resets it.
- Camera info on the tiles is re-read once a minute. This costs no extra Blink
  calls: it reads the values the snapshot polling already refreshed.

## Configuration

Snapshot refresh rates, tile order and hidden cameras are all chosen in the UI
(not config). Remaining optional knobs live in `.env` (see `.env.example`): a
protective capture floor, live-view timeout, creds/HLS paths, bind host/port. By
default the server binds to `127.0.0.1` (local only).

## Security

This app is built for **single-user local use**. Read this before exposing it.

- **No authentication.** Anyone who can reach the port can view your cameras
  and start live streams. The default bind is `127.0.0.1`, so only this machine
  can connect. Setting `HOST` to anything else prints a warning at startup —
  if you need remote access, put it behind a VPN (e.g. WireGuard/Tailscale) or
  an authenticating reverse proxy. Note the warning checks the `HOST` setting;
  passing `--host` to `uvicorn` directly bypasses the check.
- **Credentials come from the environment only** — never hardcoded. `.env` and
  the cached session file `blink_creds.json` are gitignored; do not commit
  them. The session file holds your Blink account password and refresh tokens,
  and is written with `0600` (owner-only) permissions.
- **No CSRF protection.** While the app is running, another site open in your
  browser can fire a simple cross-origin `POST` at `/api/auth/start` or
  `/api/liveview/{name}/start`. It cannot read the response, but the side
  effect (starting a stream, draining a camera battery) still happens. Not a
  concern for a loopback-only single-user setup; worth fixing before any
  multi-user or exposed deployment.
- **Error messages are verbose on purpose.** Upstream Blink/blinkpy failure
  text is passed through to the client to make local debugging possible. Do not
  expose this app to untrusted clients as-is.
- Camera names arriving from the Blink cloud are sanitized before being used as
  filesystem paths (`backend/paths.py`), and rendered with `textContent` in the
  frontend — no path traversal, no XSS.

## Limitations

- Snapshots are near-live (a few seconds behind), not video.
- Live view depends on Blink's undocumented liveview endpoint and may end early
  or fail if the camera is busy/offline; the app reports the error and falls
  back to snapshots.

## License

MIT — see [LICENSE](LICENSE). The vendored `frontend/vendor/hls.min.js` is
Apache-2.0; see [frontend/vendor/README.md](frontend/vendor/README.md).
