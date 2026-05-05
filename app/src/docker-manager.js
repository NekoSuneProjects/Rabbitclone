const Docker = require("dockerode");

function dockerOptions() {
  if (process.env.DOCKER_SOCKET) {
    return { socketPath: process.env.DOCKER_SOCKET };
  }

  if (process.platform === "win32") {
    return { socketPath: "//./pipe/docker_engine" };
  }

  return { socketPath: "/var/run/docker.sock" };
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function readHostPort(inspect, containerPort) {
  const bindings = inspect.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
  if (!bindings || bindings.length === 0) return null;
  return bindings[0].HostPort;
}

class DockerManager {
  constructor() {
    this.docker = new Docker(dockerOptions());
    this.workerImage = process.env.WORKER_IMAGE || "rabbitclone-worker:local";
    this.workerNetwork = process.env.WORKER_NETWORK || "rabbitclone_net";
    this.rtspInternalBase = trimTrailingSlash(process.env.RTSP_INTERNAL_BASE || "rtsp://mediamtx:8554");
    this.rtspPublicBase = trimTrailingSlash(process.env.RTSP_PUBLIC_BASE || "rtsp://localhost:8554");
    this.captureSize = process.env.CAPTURE_SIZE || "1280x720";
    this.fps = process.env.FPS || "30";
    this.videoBitrate = process.env.VIDEO_BITRATE || "2500k";
    this.inDocker = process.env.RUNNING_IN_DOCKER === "1";
  }

  workerName(roomId) {
    return `rabbitclone-worker-${roomId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  }

  async isAvailable() {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async findContainer(roomId) {
    const name = this.workerName(roomId);
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`rabbitclone.roomId=${roomId}`] }
    });
    const match = containers.find((container) => container.Names.includes(`/${name}`)) || containers[0];
    if (!match) return null;
    return this.docker.getContainer(match.Id);
  }

  async status(room) {
    try {
      const container = await this.findContainer(room.id);
      if (!container) {
        return { exists: false, running: false, status: "missing" };
      }

      const inspect = await container.inspect();
      return {
        exists: true,
        running: Boolean(inspect.State?.Running),
        status: inspect.State?.Status || "unknown",
        id: inspect.Id,
        desktopPort: readHostPort(inspect, 6080),
        apiPort: readHostPort(inspect, 3001)
      };
    } catch (error) {
      return {
        exists: false,
        running: false,
        status: "docker-error",
        error: error.message
      };
    }
  }

  desktopUrl(req, status) {
    if (!status.desktopPort) return null;
    const configuredBase = process.env.DESKTOP_PUBLIC_BASE;
    if (configuredBase) {
      return `${trimTrailingSlash(configuredBase)}:${status.desktopPort}/vnc.html?autoconnect=true&resize=remote`;
    }

    const host = req.hostname;
    const protocol = req.protocol || "http";
    return `${protocol}://${host}:${status.desktopPort}/vnc.html?autoconnect=true&resize=remote`;
  }

  streamUrl(room) {
    return `${this.rtspPublicBase}/${room.streamKey}`;
  }

  async startRoom(room) {
    const existing = await this.findContainer(room.id);
    if (existing) {
      const inspect = await existing.inspect();
      if (inspect.State?.Running) return inspect;
      await existing.remove({ force: true });
    }

    const name = this.workerName(room.id);
    const container = await this.docker.createContainer({
      Image: this.workerImage,
      name,
      Env: [
        `ROOM_ID=${room.id}`,
        `START_URL=${room.startUrl}`,
        `RTSP_URL=${this.rtspInternalBase}/${room.streamKey}`,
        `CAPTURE_SIZE=${this.captureSize}`,
        `VIEWPORT=${this.captureSize}`,
        `FPS=${this.fps}`,
        `VIDEO_BITRATE=${this.videoBitrate}`
      ],
      Labels: {
        "rabbitclone.managed": "true",
        "rabbitclone.roomId": room.id
      },
      ExposedPorts: {
        "6080/tcp": {},
        "3001/tcp": {}
      },
      HostConfig: {
        AutoRemove: false,
        NetworkMode: this.workerNetwork,
        ShmSize: 1024 * 1024 * 1024,
        RestartPolicy: { Name: "unless-stopped" },
        PortBindings: {
          "6080/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }],
          "3001/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }]
        }
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [this.workerNetwork]: {
            Aliases: [name]
          }
        }
      }
    });

    await container.start();
    return container.inspect();
  }

  async stopRoom(room) {
    const container = await this.findContainer(room.id);
    if (!container) return;
    await container.remove({ force: true });
  }

  async navigate(room, url) {
    const status = await this.status(room);
    if (!status.running) return { skipped: true };

    const name = this.workerName(room.id);
    const baseUrl = this.inDocker
      ? `http://${name}:3001`
      : `http://127.0.0.1:${status.apiPort}`;

    const response = await fetch(`${baseUrl}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Worker navigation failed: ${response.status} ${body}`);
    }

    return response.json();
  }
}

module.exports = {
  DockerManager
};

