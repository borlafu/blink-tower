# Deploying Blink Tower safely

Blink Tower has **no login of its own**. It refuses any request that did not come
from the machine it runs on (HTTP 403), so authentication is the job of whatever
you put in front of it.

That means the app is safe to run as-is, and the deployment question becomes:
*how do other devices reach it?*

## Pick one

| Recipe | Threat it addresses | Use when |
| --- | --- | --- |
| [`docker-compose.yml`](docker-compose.yml) | Other devices on your network | You want the whole thing (app + authenticating proxy) in one command |
| [`Caddyfile.example`](Caddyfile.example) | Other devices and guests on your wifi | You run the app directly and want a friendly LAN hostname |
| [`tailscale.md`](tailscale.md) | The internet | You want it **outside** the house too |

They compose: Tailscale for remote access, Caddy if you also want a friendly
local hostname. You do not need all three.

## Docker Compose (the quickest way to see it working)

```bash
cd deploy
cp .env.docker.example .env.docker     # put your real Blink credentials in it
docker compose up --build -d
curl -k -u viewer:verify-me https://localhost:8443/api/status
```

Then open <https://localhost:8443> — user `viewer`, password `verify-me`.
**Change that password before any real use:**

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'your-password'
# paste the hash into Caddyfile.docker, then: docker compose restart caddy
```

### Why the proxy shares the app's network namespace

The app refuses any request whose peer address is not loopback. On a normal
bridge network Caddy would reach it from `172.x.x.x` and **every request would be
refused with 403**. So `caddy` uses `network_mode: "service:app"`, which puts it
inside the app's network namespace: it connects over `127.0.0.1`, the peer stays
loopback, and the invariant holds without weakening the gate.

One consequence worth remembering: the published port is declared on the `app`
service, not on `caddy`. The app's own `8000` is never published.

### The certificate warning is expected

Caddy issues a certificate from its own CA, which your browser does not trust
yet. The chain is valid — it is only missing trust. To verify without changing
anything:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
curl --cacert ./caddy-root.crt -u viewer:verify-me https://localhost:8443/api/status
```

For a browser without warnings, install that root into your OS trust store — your
call, since it affects your whole machine.

### Credentials and state

- `.env.docker` is gitignored and passed at runtime; `.dockerignore` keeps `.env`
  and `blink_creds.json` out of every image layer.
- The cached Blink session persists in the `blink-session` volume, so the 2FA pin
  is needed once, not on every restart.
- HLS segments live on a tmpfs — disposable by nature, and never written to disk.

## Never do this

- **Do not port-forward the app**, with or without a proxy. There is no login to
  brute-force because there is no login at all — an exposed port is an open
  camera feed.
- **Do not set `HOST` to `0.0.0.0`** expecting it to work. Non-local requests are
  refused. Bind stays `127.0.0.1`; the proxy is the only listener.
- **Do not run `tailscale funnel`.** It publishes the service to the public
  internet, which is the one thing this setup exists to prevent.

## You must pass `--no-proxy-headers`

**Uvicorn enables proxy headers by default**, and when they are enabled it
*replaces* the request's peer address with the `X-Forwarded-For` value. The access
gate authorizes on the peer address, so with the default settings a reverse proxy
forwarding your tablet would make that tablet look remote — and every request
would be refused with 403:

```bash
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers
```

`python -m backend.main` already sets this correctly; only the `uvicorn` CLI needs
the flag. The 403 body says so too, so a forgotten flag explains itself instead of
looking like a broken proxy.

**Never use `--forwarded-allow-ips '*'`.** Docker guides hand it out freely. Combined
with proxy headers it lets any client send `X-Forwarded-For: 127.0.0.1` and walk
straight through the gate.

Proxy headers become safe to enable only once the app has a session login of its
own, because the authorization decision then stops depending on the peer address.

## Running it as a service

[`com.blinktower.app.plist.example`](com.blinktower.app.plist.example) is a macOS
launchd unit. On Linux the equivalent systemd unit is:

```ini
[Service]
WorkingDirectory=/opt/blink-tower
EnvironmentFile=/opt/blink-tower/.env
ExecStart=/opt/blink-tower/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers
Restart=on-failure
```

Keep `.env` and `blink_creds.json` owner-only (`chmod 600`). Both hold your Blink
account password.
