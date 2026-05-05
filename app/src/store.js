const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DataTypes, Op, Sequelize } = require("sequelize");

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function streamKey() {
  return crypto.randomBytes(16).toString("hex");
}

function dateString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sqlitePath() {
  if (process.env.SQLITE_FILE) return process.env.SQLITE_FILE;
  return path.join(process.cwd(), "data", "rabbitclone.sqlite");
}

function pairKey(userId, friendId) {
  return [userId, friendId].sort().join(":");
}

class Store {
  constructor(options = {}) {
    this.storage = options.storage || sqlitePath();
    fs.mkdirSync(path.dirname(this.storage), { recursive: true });

    this.sequelize = new Sequelize({
      dialect: "sqlite",
      storage: this.storage,
      logging: process.env.SQL_LOG === "1" ? console.log : false
    });

    this.defineModels();
  }

  defineModels() {
    this.User = this.sequelize.define("User", {
      id: { type: DataTypes.STRING, primaryKey: true },
      username: { type: DataTypes.STRING, allowNull: false, unique: true },
      passwordHash: { type: DataTypes.STRING, allowNull: false },
      role: { type: DataTypes.STRING, allowNull: false, defaultValue: "user" }
    });

    this.Room = this.sequelize.define("Room", {
      id: { type: DataTypes.STRING, primaryKey: true },
      ownerId: { type: DataTypes.STRING, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      startUrl: { type: DataTypes.TEXT, allowNull: false },
      streamKey: { type: DataTypes.STRING, allowNull: false },
      mediaNodeName: { type: DataTypes.STRING, allowNull: true },
      rtspInternalBase: { type: DataTypes.TEXT, allowNull: true },
      rtspPublicBase: { type: DataTypes.TEXT, allowNull: true },
      lastActiveAt: { type: DataTypes.DATE, allowNull: true },
      sessionStartedAt: { type: DataTypes.DATE, allowNull: true },
      stoppedDueToIdleAt: { type: DataTypes.DATE, allowNull: true }
    });

    this.RoomMember = this.sequelize.define("RoomMember", {
      roomId: { type: DataTypes.STRING, allowNull: false },
      userId: { type: DataTypes.STRING, allowNull: false }
    }, {
      indexes: [{ unique: true, fields: ["roomId", "userId"] }]
    });

    this.Invite = this.sequelize.define("Invite", {
      token: { type: DataTypes.STRING, primaryKey: true },
      roomId: { type: DataTypes.STRING, allowNull: false },
      createdBy: { type: DataTypes.STRING, allowNull: false },
      expiresAt: { type: DataTypes.DATE, allowNull: false }
    });

    this.Friendship = this.sequelize.define("Friendship", {
      id: { type: DataTypes.STRING, primaryKey: true },
      pairKey: { type: DataTypes.STRING, allowNull: false, unique: true },
      requesterId: { type: DataTypes.STRING, allowNull: false },
      recipientId: { type: DataTypes.STRING, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false }
    });

    this.Message = this.sequelize.define("Message", {
      id: { type: DataTypes.STRING, primaryKey: true },
      roomId: { type: DataTypes.STRING, allowNull: false },
      userId: { type: DataTypes.STRING, allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false }
    });

    this.BrowserSession = this.sequelize.define("BrowserSession", {
      id: { type: DataTypes.STRING, primaryKey: true },
      roomId: { type: DataTypes.STRING, allowNull: false },
      streamKey: { type: DataTypes.STRING, allowNull: false },
      mediaNodeName: { type: DataTypes.STRING, allowNull: true },
      rtspInternalBase: { type: DataTypes.TEXT, allowNull: true },
      rtspPublicBase: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false },
      startedAt: { type: DataTypes.DATE, allowNull: false },
      lastActiveAt: { type: DataTypes.DATE, allowNull: true },
      stoppedAt: { type: DataTypes.DATE, allowNull: true },
      stopReason: { type: DataTypes.STRING, allowNull: true }
    }, {
      indexes: [{ fields: ["roomId", "status"] }]
    });
  }

  async init() {
    await this.sequelize.authenticate();
    await this.sequelize.sync();
    await this.ensureSchema();
    await this.importLegacyJson();
    await this.ensureAdminUsers();
  }

  async ensureColumn(tableName, columnName, definition) {
    const queryInterface = this.sequelize.getQueryInterface();
    const description = await queryInterface.describeTable(tableName);
    if (description[columnName]) return;
    await queryInterface.addColumn(tableName, columnName, definition);
  }

  async ensureSchema() {
    await this.ensureColumn("Users", "role", {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "user"
    });
    await this.ensureColumn("Rooms", "mediaNodeName", {
      type: DataTypes.STRING,
      allowNull: true
    });
    await this.ensureColumn("Rooms", "rtspInternalBase", {
      type: DataTypes.TEXT,
      allowNull: true
    });
    await this.ensureColumn("Rooms", "rtspPublicBase", {
      type: DataTypes.TEXT,
      allowNull: true
    });
    await this.ensureColumn("BrowserSessions", "mediaNodeName", {
      type: DataTypes.STRING,
      allowNull: true
    });
    await this.ensureColumn("BrowserSessions", "rtspInternalBase", {
      type: DataTypes.TEXT,
      allowNull: true
    });
    await this.ensureColumn("BrowserSessions", "rtspPublicBase", {
      type: DataTypes.TEXT,
      allowNull: true
    });
  }

  async ensureAdminUsers() {
    const configuredAdmins = String(process.env.ADMIN_USERS || "")
      .split(",")
      .map((username) => username.trim().toLowerCase())
      .filter(Boolean);

    if (configuredAdmins.length > 0) {
      await this.User.update(
        { role: "admin" },
        { where: { username: { [Op.in]: configuredAdmins } } }
      );
    }

    if (await this.User.count({ where: { role: "admin" } }) > 0) return;

    const firstUser = await this.User.findOne({ order: [["createdAt", "ASC"]] });
    if (firstUser) {
      await firstUser.update({ role: "admin" });
    }
  }

  async importLegacyJson() {
    const legacyFile = process.env.DATA_FILE || path.join(process.cwd(), "data", "rabbitclone.json");
    if (!fs.existsSync(legacyFile)) return;
    if (await this.User.count() > 0) return;

    const raw = fs.readFileSync(legacyFile, "utf8");
    const legacy = raw.trim() ? JSON.parse(raw) : {};
    const users = Array.isArray(legacy.users) ? legacy.users : [];
    const rooms = Array.isArray(legacy.rooms) ? legacy.rooms : [];
    const invites = Array.isArray(legacy.invites) ? legacy.invites : [];

    await this.sequelize.transaction(async (transaction) => {
      for (const user of users) {
        await this.User.create({
          id: user.id,
          username: user.username,
          passwordHash: user.passwordHash,
          role: user.role || "user",
          createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
          updatedAt: user.updatedAt ? new Date(user.updatedAt) : new Date()
        }, { transaction });
      }

      for (const room of rooms) {
        await this.Room.create({
          id: room.id,
          ownerId: room.ownerId,
          name: room.name,
          startUrl: room.startUrl,
          streamKey: room.streamKey || streamKey(),
          lastActiveAt: room.updatedAt ? new Date(room.updatedAt) : null,
          createdAt: room.createdAt ? new Date(room.createdAt) : new Date(),
          updatedAt: room.updatedAt ? new Date(room.updatedAt) : new Date()
        }, { transaction });

        const members = Array.isArray(room.members) ? room.members : [room.ownerId];
        for (const userId of new Set(members.concat(room.ownerId))) {
          await this.RoomMember.findOrCreate({
            where: { roomId: room.id, userId },
            defaults: { roomId: room.id, userId },
            transaction
          });
        }
      }

      for (const invite of invites) {
        await this.Invite.create({
          token: invite.token,
          roomId: invite.roomId,
          createdBy: invite.createdBy,
          expiresAt: new Date(invite.expiresAt),
          createdAt: invite.createdAt ? new Date(invite.createdAt) : new Date(),
          updatedAt: invite.updatedAt ? new Date(invite.updatedAt) : new Date()
        }, { transaction });
      }
    });
  }

  userToPlain(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      passwordHash: user.passwordHash,
      role: user.role || "user",
      createdAt: dateString(user.createdAt),
      updatedAt: dateString(user.updatedAt)
    };
  }

  async roomToPlain(room) {
    if (!room) return null;
    const members = await this.RoomMember.findAll({
      where: { roomId: room.id },
      order: [["createdAt", "ASC"]]
    });

    return {
      id: room.id,
      ownerId: room.ownerId,
      name: room.name,
      startUrl: room.startUrl,
      streamKey: room.streamKey,
      mediaNodeName: room.mediaNodeName,
      rtspInternalBase: room.rtspInternalBase,
      rtspPublicBase: room.rtspPublicBase,
      members: members.map((member) => member.userId),
      lastActiveAt: dateString(room.lastActiveAt),
      sessionStartedAt: dateString(room.sessionStartedAt),
      stoppedDueToIdleAt: dateString(room.stoppedDueToIdleAt),
      createdAt: dateString(room.createdAt),
      updatedAt: dateString(room.updatedAt)
    };
  }

  inviteToPlain(invite) {
    if (!invite) return null;
    return {
      token: invite.token,
      roomId: invite.roomId,
      createdBy: invite.createdBy,
      expiresAt: dateString(invite.expiresAt),
      createdAt: dateString(invite.createdAt),
      updatedAt: dateString(invite.updatedAt)
    };
  }

  messageToPlain(message, user) {
    return {
      id: message.id,
      roomId: message.roomId,
      userId: message.userId,
      username: user ? user.username : "unknown",
      body: message.body,
      createdAt: dateString(message.createdAt)
    };
  }

  async createUser(username, passwordHash) {
    const isFirstUser = await this.User.count() === 0;
    const user = await this.User.create({
      id: id("usr"),
      username,
      passwordHash,
      role: isFirstUser ? "admin" : "user"
    });
    return this.userToPlain(user);
  }

  async findUserById(userId) {
    return this.userToPlain(await this.User.findByPk(userId));
  }

  async findUserByUsername(username) {
    const normalized = username.toLowerCase();
    return this.userToPlain(await this.User.findOne({ where: { username: normalized } }));
  }

  async listUsers() {
    const users = await this.User.findAll({ order: [["username", "ASC"]] });
    return users.map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role || "user",
      createdAt: dateString(user.createdAt)
    }));
  }

  async createRoom(ownerId, fields) {
    const room = await this.sequelize.transaction(async (transaction) => {
      const created = await this.Room.create({
        id: id("room"),
        ownerId,
        name: fields.name,
        startUrl: fields.startUrl,
        streamKey: streamKey()
      }, { transaction });

      await this.RoomMember.create({
        roomId: created.id,
        userId: ownerId
      }, { transaction });

      return created;
    });

    return this.roomToPlain(room);
  }

  async getRoom(roomId) {
    return this.roomToPlain(await this.Room.findByPk(roomId));
  }

  async roomsForUser(userId) {
    const memberships = await this.RoomMember.findAll({ where: { userId } });
    const roomIds = memberships.map((membership) => membership.roomId);
    if (roomIds.length === 0) return [];

    const rooms = await this.Room.findAll({
      where: { id: { [Op.in]: roomIds } },
      order: [["createdAt", "DESC"]]
    });

    return Promise.all(rooms.map((room) => this.roomToPlain(room)));
  }

  async updateRoom(roomId, fields) {
    const room = await this.Room.findByPk(roomId);
    if (!room) return null;
    await room.update(fields);
    return this.roomToPlain(room);
  }

  async rotateRoomStreamKey(roomId, mediaNode = {}) {
    return this.updateRoom(roomId, {
      streamKey: streamKey(),
      mediaNodeName: mediaNode.name || "local",
      rtspInternalBase: mediaNode.internalBase || null,
      rtspPublicBase: mediaNode.publicBase || null,
      stoppedDueToIdleAt: null,
      lastActiveAt: new Date()
    });
  }

  async markRoomActive(roomId) {
    const room = await this.Room.findByPk(roomId);
    if (!room) return null;
    await room.update({ lastActiveAt: new Date() });
    await this.BrowserSession.update(
      { lastActiveAt: new Date() },
      { where: { roomId, status: "running" } }
    );
    return this.roomToPlain(room);
  }

  async markRoomStopped(roomId, fields = {}) {
    const room = await this.Room.findByPk(roomId);
    if (!room) return null;
    await room.update({
      sessionStartedAt: null,
      stoppedDueToIdleAt: fields.idle ? new Date() : room.stoppedDueToIdleAt
    });
    await this.endBrowserSession(roomId, fields.idle ? "idle" : "manual");
    return this.roomToPlain(room);
  }

  async startBrowserSession(room) {
    const roomId = room.id;
    await this.endBrowserSession(roomId, "replaced");
    const now = new Date();
    const session = await this.BrowserSession.create({
      id: id("sess"),
      roomId,
      streamKey: room.streamKey,
      mediaNodeName: room.mediaNodeName || "local",
      rtspInternalBase: room.rtspInternalBase || null,
      rtspPublicBase: room.rtspPublicBase || null,
      status: "running",
      startedAt: now,
      lastActiveAt: now
    });
    await this.Room.update({
      sessionStartedAt: now,
      lastActiveAt: now,
      stoppedDueToIdleAt: null
    }, { where: { id: roomId } });
    return session;
  }

  async endBrowserSession(roomId, stopReason = "manual") {
    await this.BrowserSession.update({
      status: "stopped",
      stoppedAt: new Date(),
      stopReason
    }, {
      where: { roomId, status: "running" }
    });
  }

  async listIdleRooms(cutoffDate) {
    const rooms = await this.Room.findAll({
      where: {
        sessionStartedAt: { [Op.ne]: null },
        [Op.or]: [
          { lastActiveAt: null },
          { lastActiveAt: { [Op.lt]: cutoffDate } }
        ]
      }
    });

    return Promise.all(rooms.map((room) => this.roomToPlain(room)));
  }

  async addRoomMember(roomId, userId) {
    const room = await this.Room.findByPk(roomId);
    if (!room) return null;
    await this.RoomMember.findOrCreate({
      where: { roomId, userId },
      defaults: { roomId, userId }
    });
    return this.roomToPlain(room);
  }

  async createInvite(roomId, createdBy, expiresInHours = 72) {
    const invite = await this.Invite.create({
      token: crypto.randomBytes(24).toString("hex"),
      roomId,
      createdBy,
      expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
    });
    return this.inviteToPlain(invite);
  }

  async getInvite(token) {
    const invite = await this.Invite.findOne({
      where: {
        token,
        expiresAt: { [Op.gt]: new Date() }
      }
    });
    return this.inviteToPlain(invite);
  }

  async invitesForRoom(roomId) {
    const invites = await this.Invite.findAll({
      where: {
        roomId,
        expiresAt: { [Op.gt]: new Date() }
      },
      order: [["createdAt", "DESC"]]
    });
    return invites.map((invite) => this.inviteToPlain(invite));
  }

  async createFriendRequest(userId, username) {
    const friend = await this.findUserByUsername(username);
    if (!friend) return { ok: false, message: "No user exists with that username." };
    if (friend.id === userId) return { ok: false, message: "You cannot add yourself." };

    const key = pairKey(userId, friend.id);
    const existing = await this.Friendship.findOne({ where: { pairKey: key } });
    if (existing) {
      if (existing.status === "accepted") return { ok: false, message: "You are already friends." };
      if (existing.recipientId === userId) {
        await existing.update({ status: "accepted" });
        return { ok: true, message: `${friend.username} is now your friend.` };
      }
      return { ok: false, message: "Friend request already sent." };
    }

    await this.Friendship.create({
      id: id("fr"),
      pairKey: key,
      requesterId: userId,
      recipientId: friend.id,
      status: "pending"
    });

    return { ok: true, message: `Friend request sent to ${friend.username}.` };
  }

  async listFriends(userId) {
    const friendships = await this.Friendship.findAll({
      where: {
        status: "accepted",
        [Op.or]: [{ requesterId: userId }, { recipientId: userId }]
      },
      order: [["updatedAt", "DESC"]]
    });

    const friendIds = friendships.map((friendship) => (
      friendship.requesterId === userId ? friendship.recipientId : friendship.requesterId
    ));
    if (friendIds.length === 0) return [];

    const users = await this.User.findAll({ where: { id: { [Op.in]: friendIds } } });
    return users.map((user) => ({ id: user.id, username: user.username }));
  }

  async listFriendRequests(userId) {
    const requests = await this.Friendship.findAll({
      where: { recipientId: userId, status: "pending" },
      order: [["createdAt", "DESC"]]
    });

    const requesterIds = requests.map((request) => request.requesterId);
    const users = requesterIds.length > 0
      ? await this.User.findAll({ where: { id: { [Op.in]: requesterIds } } })
      : [];
    const usersById = new Map(users.map((user) => [user.id, user]));

    return requests.map((request) => ({
      id: request.id,
      requester: this.userToPlain(usersById.get(request.requesterId)),
      createdAt: dateString(request.createdAt)
    }));
  }

  async acceptFriendRequest(userId, requestId) {
    const request = await this.Friendship.findOne({
      where: { id: requestId, recipientId: userId, status: "pending" }
    });
    if (!request) return null;
    await request.update({ status: "accepted" });
    return request;
  }

  async rejectFriendRequest(userId, requestId) {
    const request = await this.Friendship.findOne({
      where: { id: requestId, recipientId: userId, status: "pending" }
    });
    if (!request) return null;
    await request.destroy();
    return request;
  }

  async createMessage(roomId, userId, body) {
    const trimmed = String(body || "").trim().slice(0, 2000);
    if (!trimmed) return null;
    const message = await this.Message.create({
      id: id("msg"),
      roomId,
      userId,
      body: trimmed
    });
    const user = await this.User.findByPk(userId);
    await this.markRoomActive(roomId);
    return this.messageToPlain(message, user);
  }

  async listRoomMessages(roomId, limit = 80) {
    const messages = await this.Message.findAll({
      where: { roomId },
      order: [["createdAt", "DESC"]],
      limit
    });
    const userIds = [...new Set(messages.map((message) => message.userId))];
    const users = userIds.length > 0
      ? await this.User.findAll({ where: { id: { [Op.in]: userIds } } })
      : [];
    const usersById = new Map(users.map((user) => [user.id, user]));

    return messages
      .reverse()
      .map((message) => this.messageToPlain(message, usersById.get(message.userId)));
  }

  async adminDashboard() {
    const [
      userCount,
      roomCount,
      runningSessionCount,
      totalSessionCount,
      messageCount,
      users,
      rooms,
      sessions
    ] = await Promise.all([
      this.User.count(),
      this.Room.count(),
      this.BrowserSession.count({ where: { status: "running" } }),
      this.BrowserSession.count(),
      this.Message.count(),
      this.User.findAll({ order: [["createdAt", "DESC"]], limit: 20 }),
      this.Room.findAll({ order: [["updatedAt", "DESC"]], limit: 20 }),
      this.BrowserSession.findAll({ order: [["createdAt", "DESC"]], limit: 30 })
    ]);

    const ownerIds = [...new Set(rooms.map((room) => room.ownerId))];
    const owners = ownerIds.length > 0
      ? await this.User.findAll({ where: { id: { [Op.in]: ownerIds } } })
      : [];
    const ownersById = new Map(owners.map((owner) => [owner.id, owner]));

    return {
      stats: {
        userCount,
        roomCount,
        runningSessionCount,
        totalSessionCount,
        messageCount
      },
      users: users.map((user) => this.userToPlain(user)),
      rooms: await Promise.all(rooms.map(async (room) => ({
        ...(await this.roomToPlain(room)),
        owner: this.userToPlain(ownersById.get(room.ownerId))
      }))),
      sessions: sessions.map((session) => ({
        id: session.id,
        roomId: session.roomId,
        streamKey: session.streamKey,
        mediaNodeName: session.mediaNodeName,
        rtspPublicBase: session.rtspPublicBase,
        status: session.status,
        startedAt: dateString(session.startedAt),
        lastActiveAt: dateString(session.lastActiveAt),
        stoppedAt: dateString(session.stoppedAt),
        stopReason: session.stopReason
      }))
    };
  }
}

module.exports = {
  Store
};
