# RabbitClone

RabbitClone is a Docker-first prototype for this pipeline:

```text
Browser UI -> Chromium worker in Docker -> X display + browser audio capture -> FFmpeg -> RTSP-over-TCP -> VRChat
```

It includes:

- Login and register pages with hashed passwords and signed auth cookies.
- SQLite storage through Sequelize for users, rooms, friends, invites, and chat messages.
- Non-destructive SQLite schema updates; new columns/tables are added without resetting accounts.
- Room creation, friend/member invites by username, expiring invite links, and per-room URL control.
- A random RTSP endpoint for each new browser worker session.
- Optional random MediaMTX node selection for each new browser session.
- Automatic idle shutdown for room browser sessions.
- Room text chat plus browser-based voice/video calls through WebRTC signaling.
- Admin dashboard for users, rooms, browser sessions, and message totals.
- Tailwind-powered dark green UI with a watch layout for the room screen.
- A Docker-managed Chromium worker per room with noVNC remote desktop access.
- MediaMTX as the RTSP server.
- GitHub Actions that build amd64 and arm64 web app/worker images and validate the compose file.

## Run locally

1. Copy `.env.example` to `.env` and change `AUTH_SECRET`.
2. Start the app and RTSP server:

```bash
docker compose up -d app mediamtx
```

3. Open `http://localhost:8080`, register, create a room, and press `Start`.

The first registered user becomes admin. Existing installs with no admin promote the oldest account on startup. You can also force admins with:

```env
ADMIN_USERS=yourusername,anotheradmin
```

If you run behind a reverse proxy, keep `TRUST_PROXY_HOPS` set to the number of proxy hops in front of the app. It defaults to `1`.

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

`RTSP_PUBLIC_BASE` defaults to `rtspt://localhost:8554` for the URL shown in the UI. The worker still publishes internally to MediaMTX with `rtsp://` plus FFmpeg `-rtsp_transport tcp`. If VRChat is running on another PC or headset, set it to this host machine's reachable LAN/public address, for example:

```env
RTSP_PUBLIC_BASE=rtspt://192.168.1.50:8554
```

## Multiple MediaMTX nodes

For one local MediaMTX node, leave `MEDIA_NODES` empty and use `RTSP_INTERNAL_BASE` plus `RTSP_PUBLIC_BASE`.

For multiple nodes, set `MEDIA_NODES`. A new browser session picks one node at random and stores that choice with the session:

```env
MEDIA_NODES=local|rtsp://mediamtx:8554|rtspt://192.168.1.50:8554,edge2|rtsp://mediamtx-edge2:8554|rtspt://192.168.1.51:8554
```

Each entry is `name|internalPublishBase|publicPlaybackBase`. The app must be able to reach the internal base from the Docker network, and VRChat must be able to reach the public base.

## Runtime shape

- `app` manages users, rooms, friends, chat, and Docker worker containers.
- The app stores data in SQLite at `SQLITE_FILE`; in Docker this is `/data/rabbitclone.sqlite`.
- Keep `./data:/data` mounted in compose. Rebuilding or pulling new images will not reset accounts as long as the same host `./data` folder is reused.
- `WORKER_IMAGE` must point at the worker image the app should launch, for example `ghcr.io/nekosuneprojects/rabbitclone-worker:main`.
- `AUTO_PULL_WORKER_IMAGE=1` lets the app pull the worker image through the mounted Docker socket when it is missing.
- Each started room gets a container named `rabbitclone-worker-<room id>`.
- The `worker-image` service is not needed in deploy compose. Real workers are created on demand by the app, one Docker container per started room/session.
- Workers publish to MediaMTX internally over RTSP TCP at `rtsp://mediamtx:8554/<stream key>`.
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

The worker captures browser video from X11 and browser audio through PulseAudio when `ENABLE_BROWSER_AUDIO=1`. Voice/video calls are browser-to-browser WebRTC; deploy TURN/STUN infrastructure for reliable calls across strict NAT networks.
