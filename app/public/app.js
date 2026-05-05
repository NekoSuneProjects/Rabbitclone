(function () {
  const room = window.RABBITCLONE_ROOM;
  const statusElement = document.querySelector("[data-room-status]");

  async function refreshStatus() {
    if (!statusElement) return;
    const roomId = statusElement.getAttribute("data-room-status");
    try {
      const response = await fetch(`/api/rooms/${roomId}/status`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const payload = await response.json();
      statusElement.textContent = payload.status.running ? "running" : payload.status.status;
      statusElement.classList.toggle("running", Boolean(payload.status.running));
    } catch {
      statusElement.textContent = "offline";
    }
  }

  if (statusElement) {
    window.setInterval(refreshStatus, 5000);
  }

  if (!room || typeof io !== "function") return;

  const socket = io();
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatMessages = document.getElementById("chatMessages");
  const startCallButton = document.getElementById("startCall");
  const hangupCallButton = document.getElementById("hangupCall");
  const localVideo = document.getElementById("localVideo");
  const remoteVideos = document.getElementById("remoteVideos");
  const peers = new Map();
  let localStream = null;
  let callEnabled = false;

  function appendMessage(message) {
    if (!chatMessages) return;

    const article = document.createElement("article");
    article.className = "message";

    const meta = document.createElement("div");
    const strong = document.createElement("strong");
    const time = document.createElement("time");
    const body = document.createElement("p");

    strong.textContent = message.username || "unknown";
    time.textContent = new Date(message.createdAt).toLocaleTimeString();
    body.textContent = message.body || "";

    meta.append(strong, time);
    article.append(meta, body);
    chatMessages.append(article);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function createPeer(target, polite) {
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    if (localStream) {
      for (const track of localStream.getTracks()) {
        peer.addTrack(track, localStream);
      }
    }

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("call:signal", {
          target,
          signal: { candidate: event.candidate }
        });
      }
    };

    peer.ontrack = (event) => {
      let video = document.getElementById(`remote-${target}`);
      if (!video) {
        video = document.createElement("video");
        video.id = `remote-${target}`;
        video.autoplay = true;
        video.playsInline = true;
        remoteVideos.append(video);
      }
      video.srcObject = event.streams[0];
    };

    peer.onnegotiationneeded = async () => {
      if (polite) return;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit("call:signal", {
        target,
        signal: { description: peer.localDescription }
      });
    };

    peers.set(target, peer);
    return peer;
  }

  async function ensureLocalMedia() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    if (localVideo) localVideo.srcObject = localStream;
    return localStream;
  }

  function removePeer(socketId) {
    const peer = peers.get(socketId);
    if (peer) {
      peer.close();
      peers.delete(socketId);
    }
    const video = document.getElementById(`remote-${socketId}`);
    if (video) video.remove();
  }

  async function handleSignal(payload) {
    if (!callEnabled) return;
    if (!payload || !payload.from || !payload.signal) return;
    await ensureLocalMedia();
    const peer = peers.get(payload.from) || createPeer(payload.from, true);

    if (payload.signal.description) {
      await peer.setRemoteDescription(payload.signal.description);
      if (payload.signal.description.type === "offer") {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit("call:signal", {
          target: payload.from,
          signal: { description: peer.localDescription }
        });
      }
    }

    if (payload.signal.candidate) {
      await peer.addIceCandidate(payload.signal.candidate);
    }
  }

  function markActive() {
    if (document.visibilityState === "visible") {
      socket.emit("presence:active");
    }
  }

  function throttle(fn, delay) {
    let last = 0;
    return () => {
      const current = Date.now();
      if (current - last < delay) return;
      last = current;
      fn();
    };
  }

  const throttledActive = throttle(markActive, 15000);

  socket.on("connect", () => {
    socket.emit("room:join", room.id, () => markActive());
  });

  socket.on("chat:message", appendMessage);

  socket.on("session:idle-closed", () => {
    if (statusElement) {
      statusElement.textContent = "idle closed";
      statusElement.classList.remove("running");
    }
  });

  socket.on("call:user-ready", async (payload) => {
    if (!callEnabled) return;
    await ensureLocalMedia();
    createPeer(payload.socketId, false);
  });

  socket.on("call:signal", (payload) => {
    handleSignal(payload).catch(console.error);
  });

  socket.on("call:user-left", (payload) => {
    removePeer(payload.socketId);
  });

  if (chatForm && chatInput) {
    chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = chatInput.value.trim();
      if (!body) return;
      socket.emit("chat:send", body);
      chatInput.value = "";
    });
  }

  if (startCallButton) {
    startCallButton.addEventListener("click", async () => {
      callEnabled = true;
      await ensureLocalMedia();
      socket.emit("call:ready");
    });
  }

  if (hangupCallButton) {
    hangupCallButton.addEventListener("click", () => {
      socket.emit("call:leave");
      for (const socketId of peers.keys()) removePeer(socketId);
      if (localStream) {
        for (const track of localStream.getTracks()) track.stop();
      }
      localStream = null;
      callEnabled = false;
      if (localVideo) localVideo.srcObject = null;
    });
  }

  for (const eventName of ["click", "keydown", "pointermove", "touchstart"]) {
    window.addEventListener(eventName, throttledActive, { passive: true });
  }

  document.addEventListener("visibilitychange", markActive);

  window.setInterval(markActive, 30000);
})();
