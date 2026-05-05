const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const express = require("express");
const helmet = require("helmet");
const http = require("http");
const jwt = require("jsonwebtoken");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const { DockerManager } = require("./docker-manager");
const { Store } = require("./store");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const store = new Store();
const docker = new DockerManager();

const PORT = Number(process.env.PORT || 8080);
const AUTH_COOKIE = "rabbitclone_auth";
const AUTH_SECRET = process.env.AUTH_SECRET || "dev-change-me";
const IDLE_SHUTDOWN_MINUTES = Number(process.env.IDLE_SHUTDOWN_MINUTES || 10);
const IDLE_SHUTDOWN_MS = Math.max(1, IDLE_SHUTDOWN_MINUTES) * 60 * 1000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", true);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validateUsername(username) {
  return /^[a-z0-9_]{3,32}$/.test(username);
}

function validateUrl(input) {
  const parsed = new URL(String(input || "").trim());
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs can be opened in a room.");
  }
  return parsed.toString();
}

function safeNext(value) {
  const next = String(value || "/rooms");
  if (!next.startsWith("/") || next.startsWith("//")) return "/rooms";
  return next;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username
  };
}

function setAuthCookie(res, userId) {
  const token = jwt.sign({ sub: userId }, AUTH_SECRET, { expiresIn: "7d" });
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "1",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE);
}

function canAccessRoom(room, user) {
  return room && user && (room.ownerId === user.id || room.members.includes(user.id));
}

function redirectWithMessage(res, pathName, type, message) {
  res.redirect(`${pathName}?${type}=${encodeURIComponent(message)}`);
}

function parseCookies(header) {
  return String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");
      if (index === -1) return cookies;
      cookies[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
      return cookies;
    }, {});
}

async function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, AUTH_SECRET);
    return store.findUserById(payload.sub);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    const nextUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${nextUrl}`);
  }
  next();
}

const requireRoom = asyncHandler(async (req, res, next) => {
  const room = await store.getRoom(req.params.roomId);
  if (!canAccessRoom(room, req.user)) {
    return res.status(404).render("error", {
      title: "Room not found",
      message: "That room does not exist or you do not have access to it."
    });
  }
  req.room = room;
  next();
});

async function touchRoom(roomId) {
  await store.markRoomActive(roomId);
}

app.use(asyncHandler(async (req, res, next) => {
  req.user = await userFromToken(req.cookies[AUTH_COOKIE]);
  res.locals.user = publicUser(req.user);
  res.locals.notice = req.query.notice || "";
  res.locals.error = req.query.error || "";
  next();
}));

app.get("/", (req, res) => {
  res.redirect(req.user ? "/rooms" : "/login");
});

app.get("/login", (req, res) => {
  res.render("login", {
    title: "Log in",
    next: safeNext(req.query.next)
  });
});

app.post("/login", authLimiter, asyncHandler(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const user = await store.findUserByUsername(username);
  const password = String(req.body.password || "");

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).render("login", {
      title: "Log in",
      next: safeNext(req.body.next),
      error: "Invalid username or password."
    });
  }

  setAuthCookie(res, user.id);
  res.redirect(safeNext(req.body.next));
}));

app.get("/register", (req, res) => {
  res.render("register", {
    title: "Register",
    next: safeNext(req.query.next)
  });
});

app.post("/register", authLimiter, asyncHandler(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || "");

  if (!validateUsername(username)) {
    return res.status(400).render("register", {
      title: "Register",
      next: safeNext(req.body.next),
      error: "Use 3-32 lowercase letters, numbers, or underscores."
    });
  }

  if (password.length < 8) {
    return res.status(400).render("register", {
      title: "Register",
      next: safeNext(req.body.next),
      error: "Password must be at least 8 characters."
    });
  }

  if (await store.findUserByUsername(username)) {
    return res.status(409).render("register", {
      title: "Register",
      next: safeNext(req.body.next),
      error: "That username is already registered."
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await store.createUser(username, passwordHash);
  setAuthCookie(res, user.id);
  res.redirect(safeNext(req.body.next));
}));

app.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.redirect("/login");
});

app.get("/friends", requireAuth, asyncHandler(async (req, res) => {
  res.render("friends", {
    title: "Friends",
    friends: await store.listFriends(req.user.id),
    requests: await store.listFriendRequests(req.user.id)
  });
}));

app.post("/friends", requireAuth, asyncHandler(async (req, res) => {
  const result = await store.createFriendRequest(req.user.id, normalizeUsername(req.body.username));
  redirectWithMessage(res, "/friends", result.ok ? "notice" : "error", result.message);
}));

app.post("/friends/:requestId/accept", requireAuth, asyncHandler(async (req, res) => {
  const accepted = await store.acceptFriendRequest(req.user.id, req.params.requestId);
  redirectWithMessage(res, "/friends", accepted ? "notice" : "error", accepted ? "Friend request accepted." : "Friend request not found.");
}));

app.post("/friends/:requestId/reject", requireAuth, asyncHandler(async (req, res) => {
  const rejected = await store.rejectFriendRequest(req.user.id, req.params.requestId);
  redirectWithMessage(res, "/friends", rejected ? "notice" : "error", rejected ? "Friend request rejected." : "Friend request not found.");
}));

app.get("/rooms", requireAuth, asyncHandler(async (req, res) => {
  const rooms = await Promise.all((await store.roomsForUser(req.user.id)).map(async (room) => ({
    ...room,
    owner: publicUser(await store.findUserById(room.ownerId)),
    streamUrl: docker.streamUrl(room),
    status: await docker.status(room)
  })));

  res.render("rooms", {
    title: "Rooms",
    rooms
  });
}));

app.post("/rooms", requireAuth, asyncHandler(async (req, res) => {
  const name = String(req.body.name || "").trim();
  let startUrl;

  try {
    startUrl = validateUrl(req.body.startUrl || "https://example.com/");
  } catch (error) {
    return redirectWithMessage(res, "/rooms", "error", error.message);
  }

  if (name.length < 2 || name.length > 80) {
    return redirectWithMessage(res, "/rooms", "error", "Room name must be 2-80 characters.");
  }

  const room = await store.createRoom(req.user.id, { name, startUrl });
  res.redirect(`/rooms/${room.id}`);
}));

app.get("/rooms/:roomId", requireAuth, requireRoom, asyncHandler(async (req, res) => {
  await touchRoom(req.room.id);
  const room = await store.getRoom(req.room.id);
  const status = await docker.status(room);
  const usersById = new Map((await store.listUsers()).map((user) => [user.id, user]));
  const members = room.members.map((userId) => usersById.get(userId)).filter(Boolean);

  res.render("room", {
    title: room.name,
    room,
    members,
    friends: await store.listFriends(req.user.id),
    messages: await store.listRoomMessages(room.id),
    invites: await store.invitesForRoom(room.id),
    idleMinutes: IDLE_SHUTDOWN_MINUTES,
    streamUrl: docker.streamUrl(room),
    status,
    desktopUrl: docker.desktopUrl(req, status),
    isOwner: room.ownerId === req.user.id,
    appBaseUrl: process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`
  });
}));

app.post("/rooms/:roomId/start", requireAuth, requireRoom, asyncHandler(async (req, res) => {
  try {
    const currentStatus = await docker.status(req.room);
    const room = currentStatus.running ? await store.markRoomActive(req.room.id) : await store.rotateRoomStreamKey(req.room.id);
    await docker.startRoom(room);
    redirectWithMessage(res, `/rooms/${req.room.id}`, "notice", "Room worker started.");
  } catch (error) {
    redirectWithMessage(res, `/rooms/${req.room.id}`, "error", error.message);
  }
}));

app.post("/rooms/:roomId/stop", requireAuth, requireRoom, asyncHandler(async (req, res) => {
  try {
    await docker.stopRoom(req.room);
    await store.markRoomStopped(req.room.id);
    redirectWithMessage(res, `/rooms/${req.room.id}`, "notice", "Room worker stopped.");
  } catch (error) {
    redirectWithMessage(res, `/rooms/${req.room.id}`, "error", error.message);
  }
}));

app.post("/rooms/:roomId/url", requireAuth, requireRoom, asyncHandler(async (req, res) => {
  let startUrl;
  try {
    startUrl = validateUrl(req.body.startUrl);
  } catch (error) {
    return redirectWithMessage(res, `/rooms/${req.room.id}`, "error", error.message);
  }

  const room = await store.updateRoom(req.room.id, { startUrl, lastActiveAt: new Date() });

  try {
    await docker.navigate(room, startUrl);
    redirectWithMessage(res, `/rooms/${room.id}`, "notice", "Room URL updated.");
  } catch (error) {
    redirectWithMessage(res, `/rooms/${room.id}`, "error", error.message);
  }
}));

app.post("/rooms/:roomId/invites", requireAuth, requireRoom, asyncHandler(async (req, res) => {
  await store.createInvite(req.room.id, req.user.id);
  redirectWithMessage(res, `/rooms/${req.room.id}`, "notice", "Invite link created.");
}));

app.post("/rooms/:roomId/members", requireAuth, requireRoom, asyncHandler(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const invited = await store.findUserByUsername(username);
  if (!invited) {
    return redirectWithMessage(res, `/rooms/${req.room.id}`, "error", "No user exists with that username.");
  }

  await store.addRoomMember(req.room.id, invited.id);
  redirectWithMessage(res, `/rooms/${req.room.id}`, "notice", `${invited.username} can now access this room.`);
}));

app.get("/invite/:token", requireAuth, asyncHandler(async (req, res) => {
  const invite = await store.getInvite(req.params.token);
  if (!invite) {
    return res.status(404).render("error", {
      title: "Invite expired",
      message: "This invite link is invalid or expired."
    });
  }

  const room = await store.addRoomMember(invite.roomId, req.user.id);
  if (!room) {
    return res.status(404).render("error", {
      title: "Room not found",
      message: "The invited room no longer exists."
    });
  }

  redirectWithMessage(res, `/rooms/${room.id}`, "notice", "Invite accepted.");
}));

app.get("/api/rooms/:roomId/status", requireAuth, requireRoom, asyncHandler(async (req, res) => {
  const status = await docker.status(req.room);
  res.json({
    status,
    streamUrl: docker.streamUrl(req.room),
    desktopUrl: docker.desktopUrl(req, status)
  });
}));

io.use(async (socket, next) => {
  try {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const user = await userFromToken(cookies[AUTH_COOKIE]);
    if (!user) return next(new Error("unauthorized"));
    socket.user = user;
    next();
  } catch (error) {
    next(error);
  }
});

io.on("connection", (socket) => {
  socket.on("room:join", async (roomId, ack) => {
    try {
      const room = await store.getRoom(roomId);
      if (!canAccessRoom(room, socket.user)) {
        if (ack) ack({ ok: false, error: "room denied" });
        return;
      }

      socket.data.roomId = room.id;
      socket.join(`room:${room.id}`);
      await touchRoom(room.id);
      socket.to(`room:${room.id}`).emit("presence:joined", publicUser(socket.user));
      if (ack) ack({ ok: true, user: publicUser(socket.user) });
    } catch (error) {
      if (ack) ack({ ok: false, error: error.message });
    }
  });

  socket.on("presence:active", async () => {
    if (socket.data.roomId) await touchRoom(socket.data.roomId);
  });

  socket.on("chat:send", async (body, ack) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = await store.getRoom(roomId);
      if (!canAccessRoom(room, socket.user)) return;
      const message = await store.createMessage(roomId, socket.user.id, body);
      if (!message) return;
      io.to(`room:${roomId}`).emit("chat:message", message);
      if (ack) ack({ ok: true });
    } catch (error) {
      if (ack) ack({ ok: false, error: error.message });
    }
  });

  socket.on("call:ready", () => {
    if (!socket.data.roomId) return;
    socket.to(`room:${socket.data.roomId}`).emit("call:user-ready", {
      socketId: socket.id,
      user: publicUser(socket.user)
    });
  });

  socket.on("call:signal", (payload) => {
    if (!payload || !payload.target) return;
    socket.to(payload.target).emit("call:signal", {
      from: socket.id,
      user: publicUser(socket.user),
      signal: payload.signal
    });
  });

  socket.on("call:leave", () => {
    if (!socket.data.roomId) return;
    socket.to(`room:${socket.data.roomId}`).emit("call:user-left", { socketId: socket.id });
  });

  socket.on("disconnect", () => {
    if (!socket.data.roomId) return;
    socket.to(`room:${socket.data.roomId}`).emit("call:user-left", { socketId: socket.id });
  });
});

async function closeIdleRooms() {
  const cutoff = new Date(Date.now() - IDLE_SHUTDOWN_MS);
  const rooms = await store.listIdleRooms(cutoff);

  for (const room of rooms) {
    try {
      const status = await docker.status(room);
      if (!status.running) {
        await store.markRoomStopped(room.id);
        continue;
      }
      await docker.stopRoom(room);
      await store.markRoomStopped(room.id, { idle: true });
      io.to(`room:${room.id}`).emit("session:idle-closed", {
        roomId: room.id,
        idleMinutes: IDLE_SHUTDOWN_MINUTES
      });
    } catch (error) {
      console.error(`Failed to close idle room ${room.id}:`, error.message);
    }
  }
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", {
    title: "Server error",
    message: err.message || "Unexpected server error."
  });
});

async function start() {
  await store.init();
  setInterval(() => {
    closeIdleRooms().catch((error) => console.error("Idle check failed:", error));
  }, 60 * 1000);

  server.listen(PORT, () => {
    console.log(`RabbitClone app listening on http://localhost:${PORT}`);
    console.log(`SQLite database: ${store.storage}`);
    console.log(`Idle room shutdown: ${IDLE_SHUTDOWN_MINUTES} minutes`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
