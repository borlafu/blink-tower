# Blink Tower application image.
#
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t blink-tower .
#
# The app binds loopback only and refuses non-local requests, so this image is
# meant to run with a reverse proxy sharing its network namespace — see
# deploy/docker-compose.yml.

FROM python:3.13-slim

# ffmpeg is only needed for live view; snapshots work without it. Installed here
# so the image supports both without a second variant.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so code edits do not invalidate the pip layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Writable locations for the cached Blink session and the HLS segments. The
# session file holds account credentials, so it lives in a volume, never a layer.
ENV BLINK_CREDS_PATH=/data/blink_creds.json \
    HLS_DIR=/tmp/hls \
    HOST=127.0.0.1 \
    PORT=8000 \
    PYTHONUNBUFFERED=1

# Run as a non-root user that owns only what it needs to write.
RUN useradd --create-home --uid 10001 tower \
    && mkdir -p /data /tmp/hls \
    && chown -R tower:tower /data /tmp/hls
USER tower

# Loopback only: the gate in backend/access.py refuses anything else, and the
# proxy reaches us through a shared network namespace.
#
# --no-proxy-headers is REQUIRED. Uvicorn enables proxy headers by default and
# then replaces the peer address with X-Forwarded-For, which would make every
# proxied request look remote and be refused with 403.
CMD ["uvicorn", "backend.main:app", \
     "--host", "127.0.0.1", "--port", "8000", \
     "--no-proxy-headers"]
