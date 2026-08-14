# Blink Tower over Tailscale — remote access without opening a port

The best remote-access option for this app: no port forwarding, no public DNS
record, no certificate management, and the service is reachable only from your
own devices.

> **Not verified in this repo.** These commands are written from the Tailscale
> docs and are lint-checked, but nobody has run them against your tailnet. Treat
> the first run as the real test.

## Setup

On the machine running Blink Tower:

```bash
# 1. Join your tailnet (opens a browser to authenticate once).
tailscale up

# 2. Confirm the app is running and loopback-only.
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/status   # expect 200

# 3. Publish it inside the tailnet over HTTPS.
tailscale serve --bg --https=443 localhost:8000

# 4. Check what you just exposed, and to whom.
tailscale serve status
```

You now have `https://<machine>.<your-tailnet>.ts.net`, with a real
publicly-trusted certificate (so no per-device CA trust, unlike the Caddy
recipe), reachable **only** from devices signed into your tailnet.

Enable MagicDNS in the admin console if that hostname does not resolve.

## Do not use Funnel

```bash
tailscale funnel 443 on    # ← DO NOT DO THIS
```

`serve` publishes to your tailnet. **`funnel` publishes to the entire internet.**
One word apart, opposite consequences. Since this app has no login of its own,
Funnel would put your live camera feeds on the open web.

If you ever need genuinely public access, the app needs a real authentication
layer first — not Funnel.

## Restrict which devices can reach it

By default any device on your tailnet can reach the app. Tighten that in the
admin console's ACL editor:

```jsonc
{
  "acls": [
    {
      // Only these devices may reach the camera host; everything else is denied.
      "action": "accept",
      "src":    ["tag:trusted-viewer"],
      "dst":    ["tag:camera-host:443"]
    }
  ]
}
```

Tag the host running Blink Tower `camera-host`, and tag your phone and laptop
`trusted-viewer`.

## The honest caveat

Under this model, **a compromised or stolen tailnet device is access**. Tailscale
authenticates the *device*; there is no second password in front of the cameras.

Mitigations worth the few minutes:

- Enable device approval so a new device cannot silently join.
- Set key expiry so a lost device drops off the tailnet on its own.
- Remove devices you no longer own from the admin console.

If you want a password on top of device identity, that is the app-level session
gate described in `backend/access.py` — the authorization decision there is
written to be swapped for exactly that.
