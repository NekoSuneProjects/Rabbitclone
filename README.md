# RabbitClone

RabbitClone is a Docker-first prototype for this pipeline:

```text
Browser UI -> Chromium worker in Docker -> X display capture -> FFmpeg -> RTSP -> VRChat
```

It includes:

- Login and register pages with hashed passwords and signed auth cookies.
- SQLite storage through Sequelize for users, rooms, friends, invites, and chat messages.
- Room creation, friend/member invites by username, expiring invite links, and per-room URL control.
- A random RTSP endpoint for each new browser worker session.
- Automatic idle shutdown for room browser sessions.
- Room text chat plus browser-based voice/video calls through WebRTC signaling.
- A Docker-managed Chromium worker per room with noVNC remote desktop access.
- MediaMTX as the RTSP server.
- GitHub Actions that build amd64 and arm64 web app/worker images and validate the compose file.

## Run locally

1. Copy `.env.example` to `.env` and change `AUTH_SECRET`.
2. Build the app and worker images:

```bash
docker compose --profile build build
```

3. Start the app and RTSP server:

```bash
docker compose up -d app mediamtx
```

4. Open `http://localhost:8080`, register, create a room, and press `Start`.

The room page shows:

- The RTSP URL to paste into a compatible VRChat video player.
- A fresh RTSP path each time a stopped room is started.
- Live chat, friend invite controls, and voice/video call controls.
- A noVNC desktop link for controlling the Docker Chromium browser.
- A URL form that navigates the running Chromium instance.
- Invite controls for username-based access and shareable invite links.

## Idle sessions

Room browser sessions close automatically after `IDLE_SHUTDOWN_MINUTES`, which defaults to `10`. Opening the room page, keeping the room page visible, chatting, changing URL, or interacting with the room marks it active. After an idle shutdown, press `Start` to create a fresh browser session with a new random RTSP endpoint.

## VRChat network note

`RTSP_PUBLIC_BASE` defaults to `rtsp://localhost:8554`. If VRChat is running on another PC or headset, set it to this host machine's reachable LAN/public address, for example:

```env
RTSP_PUBLIC_BASE=rtsp://192.168.1.50:8554
```

## Runtime shape

- `app` manages users, rooms, friends, chat, and Docker worker containers.
- The app stores data in SQLite at `SQLITE_FILE`; in Docker this is `/data/rabbitclone.sqlite`.
- `WORKER_IMAGE` must point at the worker image the app should launch, for example `ghcr.io/nekosuneprojects/rabbitclone-worker:main`.
- `AUTO_PULL_WORKER_IMAGE=1` lets the app pull the worker image through the mounted Docker socket when it is missing.
- `worker-image` is a build-only compose service that produces `rabbitclone-worker:local`.
- Each started room gets a container named `rabbitclone-worker-<room id>`.
- Workers publish to MediaMTX internally at `rtsp://mediamtx:8554/<stream key>`.
- MediaMTX exposes RTSP on host port `8554`.

## GitHub Actions images

The Docker workflow builds and pushes multi-architecture images for `linux/amd64` and `linux/arm64`, so the same GHCR tags can run on x86 hosts and ARM64 devices such as a Raspberry Pi 4/5 running a 64-bit OS.

The app image builds the SQLite native addon from source inside Docker for each target architecture. If you previously hit a `GLIBC_2.38 not found` error on ARM64, rebuild the app image with no cache so the old prebuilt addon is not reused:

```bash
docker compose build --no-cache app
```

For GHCR deployments, make sure the `app` service receives this environment value:

```yaml
environment:
  WORKER_IMAGE: ghcr.io/nekosuneprojects/rabbitclone-worker:main
  AUTO_PULL_WORKER_IMAGE: "1"
```

If the GHCR package is private, run `docker login ghcr.io` on the Docker host first.

## Limitations

This worker captures browser video from X11. Browser audio capture is not enabled yet; adding PulseAudio capture to the FFmpeg command is the next step if your VRChat player needs audio. Voice/video calls are browser-to-browser WebRTC; deploy TURN/STUN infrastructure for reliable calls across strict NAT networks.
