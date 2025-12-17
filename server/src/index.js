import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.join(__dirname, "..", "..");
const webRoot = path.join(repoRoot, "web");
const contentRoot = path.join(repoRoot, "content");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// Jackbox-style reconnect window
const PLAYER_REJOIN_GRACE_MS = 60_000; // 60s

// Round 1 tuning
const R1_BLOCKS_TOTAL = 4;
const QUESTIONS_PER_BLOCK = 6;

// Category pick
const CATEGORY_PICK_OPTIONS = 4;
const CATEGORY_PICK_TIMEOUT_MS = 12_000;

// Score tuning (v0.1)
const SCORE_CORRECT = 200;
const SCORE_WRONG = -100;
const SCORE_TIMEOUT = -150;

const AVATARS = [
  "cat",
  "goat",
  "panda",
  "koala",
  "monkey",
  "lion",
  "bear",
  "dog",
  "tiger",
];
// ----------------------
// Game options (v0.1)
// ----------------------
const DEFAULT_ROOM_OPTIONS = {
  contentRating: "standard", // "family" | "standard"
  middleCount: 0, // 0..3 (server clamps later)
  selectedMiddleGames: null, // paid-only later; null for now
};

// For now, you have 0 middle games available.
// Later, this becomes e.g. ["triangulate", ...]
function getAvailableMiddleGamesForRoom(/* room */) {
  return [];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sanitizeOptions(room, incoming = {}) {
  const next = { ...room.options };

  if (
    incoming.contentRating === "family" ||
    incoming.contentRating === "standard"
  ) {
    next.contentRating = incoming.contentRating;
  }

  if (Number.isFinite(incoming.middleCount)) {
    const available = getAvailableMiddleGamesForRoom(room).length;
    const cap = Math.min(3, available); // dynamic cap
    next.middleCount = clamp(Math.trunc(incoming.middleCount), 0, cap);
  }

  // Paid-only later:
  // - if you implement paid, validate incoming.selectedMiddleGames ∈ available
  // - for now ignore any client-sent selectedMiddleGames
  next.selectedMiddleGames = null;

  return next;
}

function broadcastOptions(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit("server:options_updated", {
    roomCode,
    gameStatus: room.gameStatus,
    options: room.options,
    // helpful for UI gating (shows why middleCount is capped)
    availableMiddleGames: getAvailableMiddleGamesForRoom(room),
  });
}

function pickAvatar(room) {
  const used = new Set(Object.values(room.players).map((p) => p.avatarId));
  const available = AVATARS.filter((a) => !used.has(a));
  const pool = available.length ? available : AVATARS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ----------------------
// Static + routes
// ----------------------
app.use("/web", express.static(webRoot));
app.get("/", (req, res) => res.redirect("/host"));
app.get("/host", (req, res) =>
  res.sendFile(path.join(webRoot, "host", "index.html"))
);
app.get("/phone", (req, res) =>
  res.sendFile(path.join(webRoot, "phone", "index.html"))
);

// ----------------------
// Content loading
// ----------------------
function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadContentOrThrow() {
  if (!fs.existsSync(contentRoot)) {
    throw new Error(
      `Missing /content folder at ${contentRoot}. Create it and add question files.`
    );
  }

  const categoriesPath = path.join(contentRoot, "categories.v1.json");
  if (!fs.existsSync(categoriesPath)) {
    throw new Error(`Missing ${categoriesPath}`);
  }

  const categoriesDoc = readJson(categoriesPath);
  const categories = categoriesDoc.categories || [];

  // Load question files
  const files = fs
    .readdirSync(contentRoot)
    .filter(
      (f) =>
        f.startsWith("questions.") &&
        (f.endsWith(".json") || f.endsWith(".v1.json"))
    );

  const questionsByCategoryId = Object.create(null);
  const questionIndex = Object.create(null); // id -> question

  for (const f of files) {
    const full = path.join(contentRoot, f);
    const arr = readJson(full);

    if (!Array.isArray(arr)) {
      throw new Error(`Expected array in ${f}`);
    }

    for (const q of arr) {
      if (
        !q?.id ||
        !q?.categoryId ||
        !q?.prompt ||
        !q?.answers ||
        !q?.correct
      ) {
        throw new Error(`Invalid question in ${f}: ${JSON.stringify(q)}`);
      }
      if (questionIndex[q.id]) {
        throw new Error(`Duplicate question id detected: ${q.id}`);
      }

      // Normalize
      const normalized = {
        id: String(q.id),
        categoryId: String(q.categoryId),
        prompt: String(q.prompt),
        answers: q.answers,
        correct: String(q.correct).toUpperCase(),
        timeLimitMs: Number.isFinite(q.timeLimitMs) ? q.timeLimitMs : 5000,
      };

      questionIndex[normalized.id] = normalized;

      if (!questionsByCategoryId[normalized.categoryId]) {
        questionsByCategoryId[normalized.categoryId] = [];
      }
      questionsByCategoryId[normalized.categoryId].push(normalized);
    }
  }

  // Basic sanity checks
  const mustHave = [
    "general",
    "us_history",
    "geography",
    "movies",
    "music",
    "video_games",
    "words",
    "science",
    "sports",
    "decades",
    "what_next",
    "animals",
  ];

  for (const id of mustHave) {
    const list = questionsByCategoryId[id] || [];
    if (list.length < 10) {
      throw new Error(
        `Category "${id}" must have at least 10 questions. Found ${list.length}.`
      );
    }
  }

  return { categories, questionsByCategoryId, questionIndex };
}

const CONTENT = loadContentOrThrow();
console.log(
  `Loaded content: ${
    Object.keys(CONTENT.questionsByCategoryId).length
  } categories with questions.`
);

// ----------------------
// In-memory rooms store
// ----------------------
const rooms = Object.create(null);

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // omit confusing I/O
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createUniqueRoomCode() {
  for (let i = 0; i < 50; i++) {
    const code = generateRoomCode();
    if (!rooms[code]) return code;
  }
  throw new Error("Failed to generate unique room code");
}

// Not security-grade; fine for party game identity across refresh
function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getPlayerList(room) {
  return Object.values(room.players).map((p) => ({
    playerId: p.playerId,
    displayName: p.displayName,
    score: p.score ?? 0,
    isConnected: !!p.isConnected,
    avatarId: p.avatarId ?? null,
  }));
}

function broadcastPlayerList(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("server:player_list_updated", {
    roomCode,
    players: getPlayerList(room),
  });
}

function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const catName = (id) =>
    CONTENT.categories.find((c) => c.id === id)?.name || id || null;

  const chooserDisplayName =
    room.r1?.chooserPlayerId && room.players[room.r1.chooserPlayerId]
      ? room.players[room.r1.chooserPlayerId].displayName
      : null;

  const pickOptionsDetailed = (room.r1?.pickOptions || []).map((id) => ({
    id,
    name: catName(id),
  }));

  io.to(roomCode).emit("server:state_changed", {
    roomCode,
    gameStatus: room.gameStatus,
    options: room.options,
    state: room.state,
    roundId: room.roundId,
    r1:
      room.roundId === 1
        ? {
            blockIndex: room.r1.blockIndex,
            currentCategoryId: room.r1.currentCategoryId,
            currentCategoryName: catName(room.r1.currentCategoryId),

            chooserPlayerId: room.r1.chooserPlayerId ?? null,
            chooserDisplayName,

            // keep old shape for backwards compatibility
            pickOptions: room.r1.pickOptions ?? null,

            // nice shape for UI
            pickOptionsDetailed,

            // NEW: countdown deadlines (epoch ms)
            pickEndsAt: room.r1.pickEndsAt ?? null,
            questionEndsAt: room.r1.questionEndsAt ?? null,
          }
        : null,
  });
}

// fastest-finger state snapshot (winner + locked out list)
function broadcastR1FastestState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const q = room.r1.currentQuestion;
  const fastest = room.r1.fastest;

  const winner =
    fastest?.winnerPlayerId && room.players[fastest.winnerPlayerId]
      ? {
          playerId: fastest.winnerPlayerId,
          displayName: room.players[fastest.winnerPlayerId].displayName,
          choice: fastest.winnerChoice ?? null,
        }
      : null;

  io.to(roomCode).emit("server:r1_fastest_state", {
    roomCode,
    questionId: q ? q.id : null,
    isOpen: room.state === "ROUND_1_QUESTION_OPEN",
    winner,
    lockedOutPlayerIds: fastest ? Array.from(fastest.lockedOutPlayerIds) : [],
    answeredPlayerIds: fastest ? Array.from(fastest.answeredPlayerIds) : [],

    // NEW: countdown deadline for the current question
    endsAt: room.r1.questionEndsAt ?? null,
  });
}

// ----------------------
// Helpers: random + selection
// ----------------------
function shuffleCopy(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickNUnusedQuestions(room, categoryId, n) {
  const pool = CONTENT.questionsByCategoryId[categoryId] || [];
  const available = pool.filter((q) => !room.usedQuestionIds.has(q.id));
  if (available.length < n) return null;

  const picked = shuffleCopy(available).slice(0, n);
  for (const q of picked) room.usedQuestionIds.add(q.id);
  return picked;
}

function getLastPlaceChooser(room) {
  const players = Object.values(room.players);
  if (players.length === 0) return null;

  let minScore = Infinity;
  for (const p of players) {
    const s = p.score ?? 0;
    if (s < minScore) minScore = s;
  }

  const tied = players.filter((p) => (p.score ?? 0) === minScore);
  if (tied.length === 1) return tied[0].playerId;

  // tie at bottom -> random among tied
  return pickRandom(tied).playerId;
}

function getEligibleCategoryOptions(room) {
  // Exclude general for pick rounds, and exclude categories already used
  const all = [
    "us_history",
    "geography",
    "movies",
    "music",
    "video_games",
    "words",
    "science",
    "sports",
    "decades",
    "what_next",
    "animals",
  ];

  const eligible = [];
  for (const catId of all) {
    if (room.r1.usedCategoryIds.has(catId)) continue;

    const pool = CONTENT.questionsByCategoryId[catId] || [];
    const available = pool.filter((q) => !room.usedQuestionIds.has(q.id));
    if (available.length >= QUESTIONS_PER_BLOCK) {
      eligible.push(catId);
    }
  }

  return eligible;
}

// ----------------------
// Round 1: block + question flow
// ----------------------
function setR1QuestionPresented(roomCode, question) {
  const room = rooms[roomCode];
  const endsAt = room?.r1?.questionEndsAt ?? null;

  io.to(roomCode).emit("server:r1_question_presented", {
    roomCode,
    questionId: question.id,
    prompt: question.prompt,
    answers: question.answers,

    // NEW: countdown deadline for the question
    endsAt,
  });
}

function clearR1QuestionTimer(room) {
  if (room.r1.fastest?.questionTimer) {
    clearTimeout(room.r1.fastest.questionTimer);
    room.r1.fastest.questionTimer = null;
  }
  // NEW: clear question deadline
  room.r1.questionEndsAt = null;
}

function startR1Block(roomCode, categoryId, blockIndex) {
  const room = rooms[roomCode];
  if (!room) return;

  const picked = pickNUnusedQuestions(room, categoryId, QUESTIONS_PER_BLOCK);
  if (!picked) {
    room.state = "ERROR";
    broadcastState(roomCode);
    io.to(roomCode).emit("server:error", {
      code: "CONTENT_NOT_ENOUGH_QUESTIONS",
    });
    return;
  }

  room.r1.blockIndex = blockIndex;
  room.r1.currentCategoryId = categoryId;
  room.r1.questionsQueue = picked;
  room.r1.currentQuestion = null;

  // NEW: clear deadlines when a block begins
  room.r1.pickEndsAt = null;
  room.r1.questionEndsAt = null;

  if (categoryId !== "general") {
    room.r1.usedCategoryIds.add(categoryId);
  }

  // Kick off first question
  startR1NextQuestion(roomCode);
}

function startR1CategoryPick(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.state = "ROUND_1_CATEGORY_PICK";
  room.roundId = 1;

  const chooserId = getLastPlaceChooser(room);
  const eligible = getEligibleCategoryOptions(room);
  const options = shuffleCopy(eligible).slice(0, CATEGORY_PICK_OPTIONS);

  room.r1.chooserPlayerId = chooserId;
  room.r1.pickOptions = options;

  // NEW: countdown deadline (epoch ms)
  room.r1.pickEndsAt = Date.now() + CATEGORY_PICK_TIMEOUT_MS;
  room.r1.questionEndsAt = null;

  broadcastState(roomCode);

  io.to(roomCode).emit("server:r1_category_pick", {
    roomCode,
    chooserPlayerId: chooserId,
    chooserDisplayName: chooserId
      ? room.players?.[chooserId]?.displayName || null
      : null,
    options: options.map((id) => ({
      id,
      name: CONTENT.categories.find((c) => c.id === id)?.name || id,
    })),
    timeoutMs: CATEGORY_PICK_TIMEOUT_MS,

    // NEW: deadline for countdown UI
    endsAt: room.r1.pickEndsAt,
  });

  // Auto-pick after timeout
  if (room.r1.pickTimer) clearTimeout(room.r1.pickTimer);
  room.r1.pickTimer = setTimeout(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;
    if (stillRoom.state !== "ROUND_1_CATEGORY_PICK") return;

    // clear deadline when pick window closes
    stillRoom.r1.pickEndsAt = null;

    const fallback = options[0] || eligible[0];
    if (!fallback) {
      stillRoom.state = "ERROR";
      broadcastState(roomCode);
      io.to(roomCode).emit("server:error", { code: "NO_ELIGIBLE_CATEGORIES" });
      return;
    }

    console.log(`Category pick timeout; auto-picking ${fallback}`);
    startR1Block(roomCode, fallback, stillRoom.r1.blockIndex + 1);
  }, CATEGORY_PICK_TIMEOUT_MS);
}

function startR1NextQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // Clear any previous question timer + deadline
  clearR1QuestionTimer(room);

  const next = room.r1.questionsQueue.shift();
  if (!next) {
    // Block complete -> either pick next category or round end
    if (room.r1.blockIndex >= R1_BLOCKS_TOTAL) {
      room.state = "ROUND_1_COMPLETE";

      // clear deadlines on round end
      room.r1.pickEndsAt = null;
      room.r1.questionEndsAt = null;

      broadcastState(roomCode);
      io.to(roomCode).emit("server:r1_round_complete", { roomCode });
      return;
    }

    // Start category pick for blocks 2–4
    startR1CategoryPick(roomCode);
    return;
  }

  // Setup question (everyone can answer immediately)
  room.r1.currentQuestion = next;

  // NEW: question countdown deadline (epoch ms)
  room.r1.questionEndsAt = Date.now() + next.timeLimitMs;

  room.r1.fastest = {
    winnerPlayerId: null,
    winnerChoice: null,
    lockedOutPlayerIds: new Set(),
    answeredPlayerIds: new Set(),
    questionTimer: null,
  };

  // clear pick deadline if we were previously in category pick
  room.r1.pickEndsAt = null;

  room.state = "ROUND_1_QUESTION_OPEN";
  room.roundId = 1;

  broadcastState(roomCode);
  broadcastR1FastestState(roomCode);
  setR1QuestionPresented(roomCode, next);

  // Server-authoritative question timer (if nobody wins in time)
  room.r1.fastest.questionTimer = setTimeout(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;

    if (stillRoom.state !== "ROUND_1_QUESTION_OPEN") return;

    const q = stillRoom.r1.currentQuestion;
    const fastest = stillRoom.r1.fastest;
    if (!q || !fastest) return;

    // If a winner happened right before timer fired, ignore
    if (fastest.winnerPlayerId) return;

    // clear deadline when question closes
    stillRoom.r1.questionEndsAt = null;

    // Apply timeout penalty to players who never attempted an answer
    for (const pid of Object.keys(stillRoom.players)) {
      const p = stillRoom.players[pid];
      if (!p) continue;

      const attempted = fastest.answeredPlayerIds.has(pid);
      if (!attempted) {
        p.score = (p.score ?? 0) + SCORE_TIMEOUT;
      }
    }

    io.to(roomCode).emit("server:r1_answer_timeout", {
      roomCode,
      questionId: q.id,
      correctChoice: q.correct,
      scoreDeltaIfNoAttempt: SCORE_TIMEOUT,
    });

    broadcastPlayerList(roomCode);
    broadcastR1FastestState(roomCode); // endsAt will now be null

    // Move on
    setTimeout(() => startR1NextQuestion(roomCode), 900);
  }, next.timeLimitMs);
}

// Re-send round context to a specific socket (for rejoin)
function sendR1SnapshotToSocket(roomCode, room, socket) {
  if (room.roundId !== 1) return;

  socket.emit("server:state_changed", {
    roomCode,
    state: room.state,
    roundId: room.roundId,
    r1: {
      blockIndex: room.r1.blockIndex,
      currentCategoryId: room.r1.currentCategoryId,
      chooserPlayerId: room.r1.chooserPlayerId ?? null,
      pickOptions: room.r1.pickOptions ?? null,

      // NEW: deadlines
      pickEndsAt: room.r1.pickEndsAt ?? null,
      questionEndsAt: room.r1.questionEndsAt ?? null,
    },
  });

  // If a question exists, send it
  if (room.r1.currentQuestion) {
    socket.emit("server:r1_question_presented", {
      roomCode,
      questionId: room.r1.currentQuestion.id,
      prompt: room.r1.currentQuestion.prompt,
      answers: room.r1.currentQuestion.answers,

      // NEW: countdown
      endsAt: room.r1.questionEndsAt ?? null,
    });
  }

  // If question open, send fastest-state snapshot
  if (room.state === "ROUND_1_QUESTION_OPEN") {
    socket.emit("server:r1_fastest_state", {
      roomCode,
      questionId: room.r1.currentQuestion ? room.r1.currentQuestion.id : null,
      isOpen: true,
      winner:
        room.r1.fastest?.winnerPlayerId &&
        room.players[room.r1.fastest.winnerPlayerId]
          ? {
              playerId: room.r1.fastest.winnerPlayerId,
              displayName:
                room.players[room.r1.fastest.winnerPlayerId].displayName,
              choice: room.r1.fastest.winnerChoice ?? null,
            }
          : null,
      lockedOutPlayerIds: room.r1.fastest
        ? Array.from(room.r1.fastest.lockedOutPlayerIds)
        : [],
      answeredPlayerIds: room.r1.fastest
        ? Array.from(room.r1.fastest.answeredPlayerIds)
        : [],

      // NEW: countdown
      endsAt: room.r1.questionEndsAt ?? null,
    });
  }

  // If category pick, send options
  if (room.state === "ROUND_1_CATEGORY_PICK") {
    socket.emit("server:r1_category_pick", {
      roomCode,
      chooserPlayerId: room.r1.chooserPlayerId,
      chooserDisplayName: room.r1.chooserPlayerId
        ? room.players?.[room.r1.chooserPlayerId]?.displayName || null
        : null,
      options: (room.r1.pickOptions || []).map((id) => ({
        id,
        name: CONTENT.categories.find((c) => c.id === id)?.name || id,
      })),
      timeoutMs: CATEGORY_PICK_TIMEOUT_MS,

      // NEW: countdown
      endsAt: room.r1.pickEndsAt ?? null,
    });
  }
}

// ----------------------
// Offline pruning
// ----------------------
function schedulePruneIfStillOffline(roomCode, playerToken) {
  const room = rooms[roomCode];
  if (!room) return;

  const oldPlayerId = room.playerTokens[playerToken];
  if (!oldPlayerId) return;

  const player = room.players[oldPlayerId];
  if (!player) return;

  if (player.pruneTimer) clearTimeout(player.pruneTimer);

  player.pruneTimer = setTimeout(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;

    const pid = stillRoom.playerTokens[playerToken];
    if (!pid) return;

    const p = stillRoom.players[pid];
    if (!p) return;

    if (p.isConnected) return;

    const age = Date.now() - (p.lastSeen || 0);
    if (age < PLAYER_REJOIN_GRACE_MS) return;

    console.log(`Pruning offline player ${p.displayName} from ${roomCode}`);

    delete stillRoom.players[pid];
    delete stillRoom.playerTokens[playerToken];
    broadcastPlayerList(roomCode);
  }, PLAYER_REJOIN_GRACE_MS + 250);
}

// ----------------------
// Socket.IO events
// ----------------------
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Host creates a room
  socket.on("host:create_room", ({ maxPlayers } = {}, ack) => {
    try {
      const roomCode = createUniqueRoomCode();

      rooms[roomCode] = {
        roomCode,
        hostSocketId: socket.id,
        maxPlayers: Number.isFinite(maxPlayers) ? maxPlayers : 6,
        players: {}, // playerId -> player data
        playerTokens: {}, // token -> current playerId
        usedQuestionIds: new Set(),
        state: "LOBBY",
        roundId: 0,
        gameStatus: "lobby", // "lobby" | "in_progress" | "finished"
        options: { ...DEFAULT_ROOM_OPTIONS },
        kickedTokens: new Set(), // tokens blocked from joining/rejoining
        r1: {
          blockIndex: 0, // 1..4
          usedCategoryIds: new Set(), // excludes general
          currentCategoryId: null,
          questionsQueue: [],
          currentQuestion: null,

          // fastest finger state
          fastest: null,

          chooserPlayerId: null,
          pickOptions: null,
          pickTimer: null,

          // NEW: countdown deadlines (epoch ms)
          pickEndsAt: null,
          questionEndsAt: null,
        },
      };

      socket.join(roomCode);

      const payload = { roomCode, maxPlayers: rooms[roomCode].maxPlayers };
      if (typeof ack === "function") ack({ ok: true, ...payload });

      socket.emit("server:room_created", payload);
      broadcastState(roomCode);
      broadcastPlayerList(roomCode);
      broadcastOptions(roomCode);

      console.log(`Room created: ${roomCode} by host ${socket.id}`);
    } catch (err) {
      console.error(err);
      if (typeof ack === "function")
        ack({ ok: false, error: "CREATE_ROOM_FAILED" });
      socket.emit("server:error", { code: "CREATE_ROOM_FAILED" });
    }
  });

  socket.on("host:update_options", ({ roomCode, options } = {}, ack) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    const room = rooms[code];

    if (!room) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "ROOM_NOT_FOUND" });
      return;
    }
    if (room.hostSocketId !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, reason: "NOT_HOST" });
      return;
    }
    if (room.gameStatus !== "lobby") {
      if (typeof ack === "function")
        ack({ ok: false, reason: "OPTIONS_LOCKED" });
      return;
    }

    room.options = sanitizeOptions(room, options);

    broadcastOptions(code);
    broadcastState(code); // so host UI has one unified stream if desired

    if (typeof ack === "function") ack({ ok: true, options: room.options });
  });

  socket.on("host:kick_player", ({ roomCode, playerId } = {}, ack) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    const room = rooms[code];

    if (!room) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "ROOM_NOT_FOUND" });
      return;
    }
    if (room.hostSocketId !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, reason: "NOT_HOST" });
      return;
    }
    if (room.gameStatus !== "lobby") {
      if (typeof ack === "function")
        ack({ ok: false, reason: "OPTIONS_LOCKED" });
      return;
    }

    const pid = String(playerId || "").trim();
    const p = room.players[pid];

    if (!p) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "PLAYER_NOT_FOUND" });
      return;
    }

    // Block future rejoin attempts from that device (token-based)
    if (p.playerToken) {
      room.kickedTokens.add(p.playerToken);
      delete room.playerTokens[p.playerToken];
    }

    // Tell the phone it was kicked (if still connected)
    io.to(pid).emit("server:player_kicked", {
      roomCode: code,
      reason: "KICKED_BY_HOST",
    });

    // Remove from room
    delete room.players[pid];

    broadcastPlayerList(code);
    broadcastState(code);

    if (typeof ack === "function") ack({ ok: true });
  });

  // Phone joins a room (first time)
  socket.on("phone:join_room", ({ roomCode, displayName } = {}, ack) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    const name = String(displayName || "").trim();

    if (!rooms[code]) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "ROOM_NOT_FOUND" });
      return;
    }

    const room = rooms[code];

    if (getPlayerList(room).length >= room.maxPlayers) {
      if (typeof ack === "function") ack({ ok: false, reason: "ROOM_FULL" });
      return;
    }

    if (!name) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "NAME_REQUIRED" });
      return;
    }

    const playerId = socket.id;
    const playerToken = makeToken();

    room.players[playerId] = {
      playerId,
      displayName: name,
      score: 0,
      playerToken,
      isConnected: true,
      lastSeen: Date.now(),
      pruneTimer: null,
      avatarId: pickAvatar(room),
    };
    room.playerTokens[playerToken] = playerId;

    socket.join(code);

    if (typeof ack === "function") {
      ack({
        ok: true,
        roomCode: code,
        playerId,
        playerToken,
        displayName: name,
        avatarId: room.players[playerId].avatarId,
        state: room.state,
        roundId: room.roundId,
      });
    }

    // Send options snapshot to THIS phone immediately
    socket.emit("server:options_updated", {
      roomCode: code,
      gameStatus: room.gameStatus,
      options: room.options,
      availableMiddleGames: getAvailableMiddleGamesForRoom(room),
    });

    broadcastPlayerList(code);
    broadcastState(code);

    console.log(`Player joined ${code}: ${name} (${playerId})`);
  });

  // Phone rejoin (after refresh) using token
  socket.on("phone:rejoin_room", ({ roomCode, playerToken } = {}, ack) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    const token = String(playerToken || "").trim();
    const room = rooms[code];

    if (room.kickedTokens && room.kickedTokens.has(token)) {
      if (typeof ack === "function") ack({ ok: false, reason: "KICKED" });
      return;
    }

    if (!room) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "ROOM_NOT_FOUND" });
      return;
    }

    const oldPlayerId = room.playerTokens[token];
    if (!token || !oldPlayerId) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "TOKEN_INVALID" });
      return;
    }

    const existing = room.players[oldPlayerId];
    if (!existing) {
      delete room.playerTokens[token];
      if (typeof ack === "function")
        ack({ ok: false, reason: "PLAYER_MISSING" });
      return;
    }

    const newPlayerId = socket.id;

    delete room.players[oldPlayerId];
    room.players[newPlayerId] = {
      ...existing,
      playerId: newPlayerId,
      isConnected: true,
      lastSeen: Date.now(),
    };

    room.playerTokens[token] = newPlayerId;

    if (room.players[newPlayerId].pruneTimer) {
      clearTimeout(room.players[newPlayerId].pruneTimer);
      room.players[newPlayerId].pruneTimer = null;
    }

    socket.join(code);

    if (typeof ack === "function") {
      ack({
        ok: true,
        roomCode: code,
        playerId: newPlayerId,
        playerToken: token,
        displayName: room.players[newPlayerId].displayName,
        avatarId: room.players[newPlayerId].avatarId,
        state: room.state,
        roundId: room.roundId,
        players: getPlayerList(room),
      });
    }

    // Send snapshot to this socket
    sendR1SnapshotToSocket(code, room, socket);

    broadcastPlayerList(code);
    broadcastState(code);

    console.log(
      `Player rejoined ${code}: ${room.players[newPlayerId].displayName} (${newPlayerId})`
    );
  });

  // Host starts game
  socket.on("host:start_game", ({ roomCode } = {}, ack) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    const room = rooms[code];

    if (room.gameStatus !== "lobby") {
      if (typeof ack === "function")
        ack({ ok: false, reason: "GAME_ALREADY_STARTED" });
      return;
    }

    // Lock in options by flipping status
    room.gameStatus = "in_progress";
    broadcastOptions(code);

    if (!room) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "ROOM_NOT_FOUND" });
      return;
    }

    if (room.hostSocketId !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, reason: "NOT_HOST" });
      return;
    }

    const playerCount = Object.keys(room.players).length;
    if (playerCount < 1) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "NOT_ENOUGH_PLAYERS" });
      return;
    }

    // Reset run state
    room.usedQuestionIds = new Set();
    room.state = "ROUND_1_INTRO";
    room.roundId = 1;

    // Reset Round 1
    room.r1.blockIndex = 0;
    room.r1.usedCategoryIds = new Set();
    room.r1.currentCategoryId = null;
    room.r1.questionsQueue = [];
    room.r1.currentQuestion = null;

    // Clear deadlines
    room.r1.pickEndsAt = null;
    room.r1.questionEndsAt = null;

    // Clear fastest state
    room.r1.fastest = null;

    room.r1.chooserPlayerId = null;
    room.r1.pickOptions = null;
    if (room.r1.pickTimer) {
      clearTimeout(room.r1.pickTimer);
      room.r1.pickTimer = null;
    }

    broadcastState(code);
    broadcastR1FastestState(code);

    // After 2 seconds, start Block 1 (General)
    setTimeout(() => {
      const stillRoom = rooms[code];
      if (!stillRoom) return;
      if (stillRoom.state !== "ROUND_1_INTRO") return;

      startR1Block(code, "general", 1);
    }, 2000);

    if (typeof ack === "function") ack({ ok: true });
  });

  // Any phone taps A/B/C/D during ROUND_1_QUESTION_OPEN
  socket.on(
    "phone:r1_answer_tap",
    ({ roomCode, playerId, choice } = {}, ack) => {
      const code = String(roomCode || "")
        .trim()
        .toUpperCase();
      const room = rooms[code];
      if (!room) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "ROOM_NOT_FOUND" });
        return;
      }

      const pid = playerId || socket.id;
      const ch = String(choice || "")
        .trim()
        .toUpperCase();

      if (room.state !== "ROUND_1_QUESTION_OPEN") {
        if (typeof ack === "function")
          ack({ ok: false, reason: "QUESTION_NOT_OPEN" });
        return;
      }

      if (!room.players[pid]) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "PLAYER_NOT_IN_ROOM" });
        return;
      }

      if (!["A", "B", "C", "D"].includes(ch)) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "INVALID_CHOICE" });
        return;
      }

      const q = room.r1.currentQuestion;
      const fastest = room.r1.fastest;

      if (!q || !fastest) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "NO_CURRENT_QUESTION" });
        return;
      }

      // Winner already decided -> ignore
      if (fastest.winnerPlayerId) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "ALREADY_HAS_WINNER" });
        return;
      }

      // Locked out -> ignore
      if (fastest.lockedOutPlayerIds.has(pid)) {
        if (typeof ack === "function") ack({ ok: false, reason: "LOCKED_OUT" });
        return;
      }

      // Record attempt (prevents timeout penalty)
      fastest.answeredPlayerIds.add(pid);

      const correct = ch === q.correct;

      if (correct) {
        // First correct wins
        fastest.winnerPlayerId = pid;
        fastest.winnerChoice = ch;

        // Stop timer + clear deadline
        clearR1QuestionTimer(room);

        // Score
        const p = room.players[pid];
        if (p) p.score = (p.score ?? 0) + SCORE_CORRECT;

        io.to(code).emit("server:r1_answer_winner", {
          roomCode: code,
          questionId: q.id,
          winnerPlayerId: pid,
          winnerDisplayName: p ? p.displayName : null,
          chosen: ch,
          correctChoice: q.correct,
          scoreDelta: SCORE_CORRECT,
          newScore: p ? p.score : null,
        });

        broadcastPlayerList(code);
        broadcastR1FastestState(code);

        if (typeof ack === "function") ack({ ok: true, correct: true });

        // Next question
        setTimeout(() => startR1NextQuestion(code), 900);
        return;
      }

      // Wrong -> lock out this player (and apply wrong penalty)
      fastest.lockedOutPlayerIds.add(pid);

      const p = room.players[pid];
      if (p) p.score = (p.score ?? 0) + SCORE_WRONG;

      io.to(code).emit("server:r1_answer_locked_out", {
        roomCode: code,
        questionId: q.id,
        answeringPlayerId: pid,
        answeringDisplayName: p ? p.displayName : null,
        chosen: ch,
        correctChoice: q.correct, // you may hide this on phones later; host can show it
        scoreDelta: SCORE_WRONG,
        newScore: p ? p.score : null,
      });

      broadcastPlayerList(code);
      broadcastR1FastestState(code);

      if (typeof ack === "function") ack({ ok: true, correct: false });
    }
  );

  // Category pick (chooser only)
  socket.on(
    "phone:r1_pick_category",
    ({ roomCode, playerId, categoryId } = {}, ack) => {
      const code = String(roomCode || "")
        .trim()
        .toUpperCase();
      const room = rooms[code];
      if (!room) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "ROOM_NOT_FOUND" });
        return;
      }

      if (room.state !== "ROUND_1_CATEGORY_PICK") {
        if (typeof ack === "function")
          ack({ ok: false, reason: "PICK_NOT_OPEN" });
        return;
      }

      const pid = playerId || socket.id;
      const chooser = room.r1.chooserPlayerId;

      if (!chooser || pid !== chooser) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "NOT_CHOOSER" });
        return;
      }

      const pick = String(categoryId || "").trim();
      const options = room.r1.pickOptions || [];
      if (!options.includes(pick)) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "INVALID_PICK" });
        return;
      }

      if (room.r1.pickTimer) {
        clearTimeout(room.r1.pickTimer);
        room.r1.pickTimer = null;
      }

      // clear pick deadline when chooser picks
      room.r1.pickEndsAt = null;

      if (typeof ack === "function") ack({ ok: true });

      // Start next block
      startR1Block(code, pick, room.r1.blockIndex + 1);
    }
  );

  // Host ends game
  socket.on("host:end_game", ({ roomCode } = {}, ack) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    const room = rooms[code];

    if (!room) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "ROOM_NOT_FOUND" });
      return;
    }
    if (room.hostSocketId !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, reason: "NOT_HOST" });
      return;
    }

    io.to(code).emit("server:error", { code: "ROOM_CLOSED" });

    // Clear timers
    if (room.r1?.pickTimer) clearTimeout(room.r1.pickTimer);
    if (room.r1?.fastest?.questionTimer)
      clearTimeout(room.r1.fastest.questionTimer);

    delete rooms[code];

    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];

      // Host disconnect closes the room (phones boot)
      if (room.hostSocketId === socket.id) {
        console.log(`Host disconnected; closing room ${code}`);
        io.to(code).emit("server:error", { code: "ROOM_CLOSED" });

        if (room.r1?.pickTimer) clearTimeout(room.r1.pickTimer);
        if (room.r1?.fastest?.questionTimer)
          clearTimeout(room.r1.fastest.questionTimer);

        delete rooms[code];
        continue;
      }

      // Phone disconnect: keep record, mark offline, allow rejoin via token
      if (room.players[socket.id]) {
        const player = room.players[socket.id];
        player.isConnected = false;
        player.lastSeen = Date.now();

        if (player.playerToken) {
          schedulePruneIfStillOffline(code, player.playerToken);
        }

        broadcastPlayerList(code);
        console.log(
          `Player disconnected (grace) from ${code}: ${player.displayName} (${socket.id})`
        );
      }
    }

    console.log("Client disconnected:", socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Host:  http://localhost:${PORT}/host`);
  console.log(`Phone: http://localhost:${PORT}/phone`);
});
