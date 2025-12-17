// server/src/index.js
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
// Final Podium tuning (v0.1)
// ----------------------
const FINAL_INTRO_MS = 1500;
const FINAL_REVEAL_MS = 1200;

// How fast podiums drop while waiting for answers
// (height units per second; height is 0..1)
//
// Updated: slowed so "minimum 30 seconds worth of bar" is possible.
const FINAL_FALL_RATE_PER_SEC = 0.02;

// Minimum survival time from starting height (even if player has 0 points)
const FINAL_MIN_SURVIVE_SEC = 30;

// Penalties/boosts applied on reveal
const FINAL_WRONG_DROP = 0.12; // instant drop for wrong
const FINAL_NOANSWER_DROP = 0.14; // instant drop for no answer
const FINAL_FIRST_CORRECT_BOOST_BASE = 0.1; // base boost for first correct
const FINAL_FIRST_CORRECT_ELASTICITY = 0.18; // extra boost scaled by "how low you are"

// Starting podium heights are derived from scores and clamped
const FINAL_MIN_START_HEIGHT = 0.35;
const FINAL_MAX_START_HEIGHT = 0.85;

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

// Score helper: NEVER allow points to go below 0
function addScoreClamped(player, delta) {
  const next = (player?.score ?? 0) + (delta ?? 0);
  player.score = Math.max(0, next);
}

// Normalize answers into ["A","B","C","D"] strings (or "—")
function normalizeAnswers4(raw) {
  const out = ["—", "—", "—", "—"];
  if (!raw) return out;

  // Object map {A:"",B:"",C:"",D:""} (or lowercase)
  if (typeof raw === "object" && !Array.isArray(raw)) {
    out[0] = raw.A ?? raw.a ?? out[0];
    out[1] = raw.B ?? raw.b ?? out[1];
    out[2] = raw.C ?? raw.c ?? out[2];
    out[3] = raw.D ?? raw.d ?? out[3];
    return out.map((v) =>
      v == null || String(v).trim() === "" ? "—" : String(v)
    );
  }

  // Array of strings ["", "", "", ""]
  if (Array.isArray(raw) && (raw.length === 0 || typeof raw[0] === "string")) {
    for (let i = 0; i < 4; i++) {
      const v = raw[i];
      out[i] = v == null || String(v).trim() === "" ? "—" : String(v);
    }
    return out;
  }

  // Array of objects: [{label:"A", text:"..."}, ...] OR [{text:"..."}, ...]
  if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object") {
    const byLetter = {};
    const unlabeled = [];

    for (const item of raw) {
      const L = String(item?.label || item?.letter || "")
        .trim()
        .toUpperCase();
      const txt = item?.text ?? item?.value ?? item?.answer ?? "";
      if (["A", "B", "C", "D"].includes(L)) byLetter[L] = txt;
      else unlabeled.push(txt);
    }

    if (Object.keys(byLetter).length) {
      out[0] = byLetter.A ?? out[0];
      out[1] = byLetter.B ?? out[1];
      out[2] = byLetter.C ?? out[2];
      out[3] = byLetter.D ?? out[3];
    } else {
      for (let i = 0; i < 4; i++) {
        const v = unlabeled[i];
        if (v != null && String(v).trim() !== "") out[i] = String(v);
      }
    }

    return out.map((v) =>
      v == null || String(v).trim() === "" ? "—" : String(v)
    );
  }

  return out;
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

  // Basic sanity checks for R1 categories only
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

// Final round content (separate file so we don't reuse R1)
function loadFinalQuestionsOrThrow() {
  const fp = path.join(contentRoot, "questions.final_podium.v1.json");
  if (!fs.existsSync(fp)) {
    throw new Error(
      `Missing ${fp}. Create it with an array of {id, categoryId:'final_podium', prompt, answers, correct, timeLimitMs?}`
    );
  }

  const arr = readJson(fp);
  if (!Array.isArray(arr))
    throw new Error(`Expected array in questions.final_podium.v1.json`);

  const questions = [];
  const index = Object.create(null);

  for (const q of arr) {
    if (!q?.id || !q?.prompt || !q?.answers || !q?.correct) {
      throw new Error(`Invalid final question: ${JSON.stringify(q)}`);
    }
    const id = String(q.id);
    if (index[id]) throw new Error(`Duplicate final question id: ${id}`);

    const normalized = {
      id,
      categoryId: "final_podium",
      prompt: String(q.prompt),
      answers: q.answers,
      correct: String(q.correct).toUpperCase(),
      timeLimitMs: Number.isFinite(q.timeLimitMs) ? q.timeLimitMs : 5000,
    };

    index[id] = normalized;
    questions.push(normalized);
  }

  if (questions.length < 10) {
    console.warn(
      `Warning: questions.final_podium has only ${questions.length} questions. You'll want more for testing.`
    );
  }

  return { questions, index };
}

const CONTENT = loadContentOrThrow();
const FINAL_CONTENT = loadFinalQuestionsOrThrow();

console.log(
  `Loaded content: ${
    Object.keys(CONTENT.questionsByCategoryId).length
  } categories with questions.`
);
console.log(`Loaded final podium questions: ${FINAL_CONTENT.questions.length}`);

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

  // Final snapshot (host/phone can choose to use it)
  const finalSnapshot =
    room.roundId === 99
      ? {
          questionId: room.final?.currentQuestion?.id ?? null,
          prompt: room.final?.currentQuestion?.prompt ?? null,
          // DO NOT send correct answer here (phones shouldn't get it early)
          answers: room.final?.currentQuestion?.answers ?? null,
          endsAt: room.final?.questionEndsAt ?? null,
          alivePlayerIds: room.final?.alivePlayerIds ?? [],
          heights: room.final?.heights ?? {},
          answered: room.final?.answered ?? {},
          phase: room.final?.phase ?? null,
        }
      : null;

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

            pickOptions: room.r1.pickOptions ?? null,
            pickOptionsDetailed,

            pickEndsAt: room.r1.pickEndsAt ?? null,
            questionEndsAt: room.r1.questionEndsAt ?? null,
          }
        : null,
    final: finalSnapshot,
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

  return pickRandom(tied).playerId;
}

function getEligibleCategoryOptions(room) {
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
    // Upgrade: always send a predictable 4-answer array to clients
    answers: normalizeAnswers4(question.answers),
    endsAt,
  });
}

function clearR1QuestionTimer(room) {
  if (room.r1.fastest?.questionTimer) {
    clearTimeout(room.r1.fastest.questionTimer);
    room.r1.fastest.questionTimer = null;
  }
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

  room.r1.pickEndsAt = null;
  room.r1.questionEndsAt = null;

  if (categoryId !== "general") {
    room.r1.usedCategoryIds.add(categoryId);
  }

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
    endsAt: room.r1.pickEndsAt,
  });

  if (room.r1.pickTimer) clearTimeout(room.r1.pickTimer);
  room.r1.pickTimer = setTimeout(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;
    if (stillRoom.state !== "ROUND_1_CATEGORY_PICK") return;

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

  clearR1QuestionTimer(room);

  const next = room.r1.questionsQueue.shift();
  if (!next) {
    if (room.r1.blockIndex >= R1_BLOCKS_TOTAL) {
      room.state = "ROUND_1_COMPLETE";

      room.r1.pickEndsAt = null;
      room.r1.questionEndsAt = null;

      broadcastState(roomCode);
      io.to(roomCode).emit("server:r1_round_complete", { roomCode });

      // NEW: transition to Final (since middle rounds = 0 currently)
      setTimeout(() => startFinalIntro(roomCode), 900);
      return;
    }

    startR1CategoryPick(roomCode);
    return;
  }

  room.r1.currentQuestion = next;
  room.r1.questionEndsAt = Date.now() + next.timeLimitMs;

  room.r1.fastest = {
    winnerPlayerId: null,
    winnerChoice: null,
    lockedOutPlayerIds: new Set(),
    answeredPlayerIds: new Set(),
    questionTimer: null,
  };

  room.r1.pickEndsAt = null;

  room.state = "ROUND_1_QUESTION_OPEN";
  room.roundId = 1;

  broadcastState(roomCode);
  broadcastR1FastestState(roomCode);
  setR1QuestionPresented(roomCode, next);

  room.r1.fastest.questionTimer = setTimeout(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;

    if (stillRoom.state !== "ROUND_1_QUESTION_OPEN") return;

    const q = stillRoom.r1.currentQuestion;
    const fastest = stillRoom.r1.fastest;
    if (!q || !fastest) return;

    if (fastest.winnerPlayerId) return;

    stillRoom.r1.questionEndsAt = null;

    for (const pid of Object.keys(stillRoom.players)) {
      const p = stillRoom.players[pid];
      if (!p) continue;

      const attempted = fastest.answeredPlayerIds.has(pid);
      if (!attempted) {
        addScoreClamped(p, SCORE_TIMEOUT);
      }
    }

    io.to(roomCode).emit("server:r1_answer_timeout", {
      roomCode,
      questionId: q.id,
      correctChoice: q.correct,
      scoreDeltaIfNoAttempt: SCORE_TIMEOUT,
    });

    broadcastPlayerList(roomCode);
    broadcastR1FastestState(roomCode);

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
      pickEndsAt: room.r1.pickEndsAt ?? null,
      questionEndsAt: room.r1.questionEndsAt ?? null,
    },
  });

  if (room.r1.currentQuestion) {
    socket.emit("server:r1_question_presented", {
      roomCode,
      questionId: room.r1.currentQuestion.id,
      prompt: room.r1.currentQuestion.prompt,
      answers: normalizeAnswers4(room.r1.currentQuestion.answers),
      endsAt: room.r1.questionEndsAt ?? null,
    });
  }

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
      endsAt: room.r1.questionEndsAt ?? null,
    });
  }

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
      endsAt: room.r1.pickEndsAt ?? null,
    });
  }
}

// ----------------------
// Final Podium helpers
// ----------------------
function buildFinalStartingHeights(room) {
  const ids = Object.keys(room.players);
  const scores = ids.map((id) => room.players[id]?.score ?? 0);

  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 0;

  const range = Math.max(1, max - min);

  // Minimum height that yields at least FINAL_MIN_SURVIVE_SEC of bar
  const minHeightForSurvive = clamp(
    FINAL_FALL_RATE_PER_SEC * FINAL_MIN_SURVIVE_SEC,
    0,
    1
  );

  const heights = {};
  for (const pid of ids) {
    const s = room.players[pid]?.score ?? 0;
    const t = (s - min) / range; // 0..1
    const h =
      FINAL_MIN_START_HEIGHT +
      t * (FINAL_MAX_START_HEIGHT - FINAL_MIN_START_HEIGHT);

    heights[pid] = clamp(Math.max(h, minHeightForSurvive), 0, 1);
  }
  return heights;
}

function countAlive(room) {
  return (room.final?.alivePlayerIds || []).length;
}

function getLowestAliveHeight(room) {
  let low = Infinity;
  for (const pid of room.final.alivePlayerIds) {
    const h = room.final.heights[pid] ?? 0;
    if (h < low) low = h;
  }
  if (!Number.isFinite(low)) low = 0;
  return low;
}

function stopFinalFallLoop(room) {
  if (room.final?.fallInterval) {
    clearInterval(room.final.fallInterval);
    room.final.fallInterval = null;
  }
}

function eliminateIfOnFloor(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.roundId !== 99) return;

  const alive = [];
  for (const pid of room.final.alivePlayerIds) {
    const h = room.final.heights[pid] ?? 0;
    if (h > 0) alive.push(pid);
  }
  room.final.alivePlayerIds = alive;

  if (alive.length <= 1) {
    const winnerId = alive[0] ?? null;
    room.state = "FINAL_COMPLETE";
    room.final.phase = "complete";
    stopFinalFallLoop(room);
    room.final.questionEndsAt = null;

    io.to(roomCode).emit("server:final_complete", {
      roomCode,
      winnerPlayerId: winnerId,
      winnerDisplayName: winnerId
        ? room.players[winnerId]?.displayName ?? null
        : null,
      heights: room.final.heights,
    });

    broadcastState(roomCode);
    broadcastPlayerList(roomCode);
    return true;
  }

  return false;
}

function pickNextFinalQuestion(room) {
  // simple: shuffle once at round start and pop
  const next = room.final.questionsQueue.shift();
  return next || null;
}

function startFinalIntro(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // If you later add middle rounds, this is where you'd branch based on room.options.middleCount etc.
  room.roundId = 99;
  room.state = "FINAL_INTRO";

  room.final = {
    alivePlayerIds: Object.keys(room.players),
    heights: buildFinalStartingHeights(room),
    answered: {}, // pid -> { choice, isCorrect, atMs }
    currentQuestion: null,
    questionEndsAt: null,
    fallInterval: null,
    lastTickAt: null,
    questionsQueue: shuffleCopy(FINAL_CONTENT.questions),
    phase: "intro",
  };

  broadcastState(roomCode);
  broadcastPlayerList(roomCode);

  setTimeout(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;
    if (stillRoom.state !== "FINAL_INTRO") return;
    startFinalNextQuestion(roomCode);
  }, FINAL_INTRO_MS);
}

function startFinalFallLoop(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  stopFinalFallLoop(room);

  room.final.lastTickAt = Date.now();
  room.final.fallInterval = setInterval(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;
    if (stillRoom.state !== "FINAL_QUESTION_OPEN") return;

    const now = Date.now();
    const dtMs = Math.max(0, now - (stillRoom.final.lastTickAt || now));
    stillRoom.final.lastTickAt = now;

    const dtSec = dtMs / 1000;
    const drop = FINAL_FALL_RATE_PER_SEC * dtSec;

    // Drop only players who are alive AND have NOT answered this question
    for (const pid of stillRoom.final.alivePlayerIds) {
      if (stillRoom.final.answered[pid]) continue;
      stillRoom.final.heights[pid] = clamp(
        (stillRoom.final.heights[pid] ?? 0) - drop,
        0,
        1
      );
    }

    // If anyone hits 0 during the fall, eliminate immediately (Buzz-style)
    if (eliminateIfOnFloor(roomCode)) return;
  }, 50);
}

function startFinalNextQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.roundId !== 99) return;

  // Clear previous question state
  room.final.answered = {};
  room.final.currentQuestion = null;
  room.final.questionEndsAt = null;
  stopFinalFallLoop(room);

  // If already have a winner, bail
  if (countAlive(room) <= 1) {
    eliminateIfOnFloor(roomCode);
    return;
  }

  const q = pickNextFinalQuestion(room);
  if (!q) {
    // No more questions: winner = highest podium among alive
    let bestId = null;
    let bestH = -Infinity;
    for (const pid of room.final.alivePlayerIds) {
      const h = room.final.heights[pid] ?? 0;
      if (h > bestH) {
        bestH = h;
        bestId = pid;
      }
    }

    room.state = "FINAL_COMPLETE";
    room.final.phase = "complete";
    io.to(roomCode).emit("server:final_complete", {
      roomCode,
      winnerPlayerId: bestId,
      winnerDisplayName: bestId
        ? room.players[bestId]?.displayName ?? null
        : null,
      heights: room.final.heights,
      reason: "OUT_OF_QUESTIONS",
    });
    broadcastState(roomCode);
    broadcastPlayerList(roomCode);
    return;
  }

  room.final.currentQuestion = q;
  room.final.questionEndsAt = Date.now() + (q.timeLimitMs ?? 5000);
  room.final.phase = "question_open";

  room.state = "FINAL_QUESTION_OPEN";

  // Send question to everyone
  io.to(roomCode).emit("server:final_question_presented", {
    roomCode,
    questionId: q.id,
    prompt: q.prompt,
    // Upgrade: always send a predictable 4-answer array to clients
    answers: normalizeAnswers4(q.answers),
    endsAt: room.final.questionEndsAt,
    alivePlayerIds: room.final.alivePlayerIds,
    heights: room.final.heights,
  });

  broadcastState(roomCode);

  // Start falling
  startFinalFallLoop(roomCode);

  // Reveal when time is up (if not all answered first)
  setTimeout(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;
    if (stillRoom.state !== "FINAL_QUESTION_OPEN") return;
    if (stillRoom.final?.currentQuestion?.id !== q.id) return;

    finalizeFinalQuestion(roomCode, "timeout");
  }, q.timeLimitMs ?? 5000);
}

function finalizeFinalQuestion(roomCode, reason) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.state !== "FINAL_QUESTION_OPEN") return;

  stopFinalFallLoop(room);

  const q = room.final.currentQuestion;
  if (!q) return;

  room.state = "FINAL_REVEAL";
  room.final.phase = "reveal";
  room.final.questionEndsAt = null;

  // Determine correctness for each alive player
  const correctChoice = q.correct;

  // Identify first correct (by earliest atMs among correct answers)
  let firstCorrectPid = null;
  let firstCorrectAt = Infinity;

  for (const pid of room.final.alivePlayerIds) {
    const a = room.final.answered[pid];
    if (!a) continue;
    if (a.choice === correctChoice) {
      if (a.atMs < firstCorrectAt) {
        firstCorrectAt = a.atMs;
        firstCorrectPid = pid;
      }
    }
  }

  // Apply outcomes
  const lowestBefore = getLowestAliveHeight(room);

  const resultsByPlayerId = {};

  for (const pid of room.final.alivePlayerIds) {
    const before = room.final.heights[pid] ?? 0;
    const a = room.final.answered[pid] || null;

    let outcome = "no_answer";
    let delta = 0;

    if (!a) {
      // No answer
      delta = -FINAL_NOANSWER_DROP;
      outcome = "no_answer";
    } else if (a.choice === correctChoice) {
      // Correct
      if (pid === firstCorrectPid) {
        // Elasticity: the lower you are (relative to lowest), the bigger the boost
        const h = before;
        const low = lowestBefore;
        const rel = clamp((low - h) / 0.5, 0, 1);
        const boost =
          FINAL_FIRST_CORRECT_BOOST_BASE + rel * FINAL_FIRST_CORRECT_ELASTICITY;
        delta = boost;
        outcome = "first_correct";
      } else {
        delta = 0;
        outcome = "correct";
      }
    } else {
      // Wrong
      delta = -FINAL_WRONG_DROP;
      outcome = "wrong";
    }

    room.final.heights[pid] = clamp(before + delta, 0, 1);

    resultsByPlayerId[pid] = {
      outcome,
      choice: a?.choice ?? null,
      delta,
      heightBefore: before,
      heightAfter: room.final.heights[pid],
    };
  }

  // Eliminate anyone who hit the floor due to reveal
  eliminateIfOnFloor(roomCode);

  io.to(roomCode).emit("server:final_reveal", {
    roomCode,
    questionId: q.id,
    correctChoice,
    firstCorrectPlayerId: firstCorrectPid,
    firstCorrectDisplayName: firstCorrectPid
      ? room.players[firstCorrectPid]?.displayName ?? null
      : null,
    resultsByPlayerId,
    heights: room.final.heights,
    alivePlayerIds: room.final.alivePlayerIds,
    reason,
  });

  broadcastState(roomCode);
  broadcastPlayerList(roomCode);

  // Next question after reveal pause (unless game ended)
  setTimeout(() => {
    const stillRoom = rooms[roomCode];
    if (!stillRoom) return;
    if (stillRoom.state !== "FINAL_REVEAL") return;

    if (countAlive(stillRoom) <= 1) {
      eliminateIfOnFloor(roomCode);
      return;
    }

    startFinalNextQuestion(roomCode);
  }, FINAL_REVEAL_MS);
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
        players: {},
        playerTokens: {},
        usedQuestionIds: new Set(),
        state: "LOBBY",
        roundId: 0,
        gameStatus: "lobby",
        options: { ...DEFAULT_ROOM_OPTIONS },
        kickedTokens: new Set(),
        r1: {
          blockIndex: 0,
          usedCategoryIds: new Set(),
          currentCategoryId: null,
          questionsQueue: [],
          currentQuestion: null,
          fastest: null,
          chooserPlayerId: null,
          pickOptions: null,
          pickTimer: null,
          pickEndsAt: null,
          questionEndsAt: null,
        },
        final: null,
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
    broadcastState(code);

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

    if (p.playerToken) {
      room.kickedTokens.add(p.playerToken);
      delete room.playerTokens[p.playerToken];
    }

    io.to(pid).emit("server:player_kicked", {
      roomCode: code,
      reason: "KICKED_BY_HOST",
    });

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

    // immediate options snapshot to this phone
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

    if (room?.kickedTokens && room.kickedTokens.has(token)) {
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

    // Send R1 snapshot if in R1
    sendR1SnapshotToSocket(code, room, socket);

    // Send options snapshot to this phone
    socket.emit("server:options_updated", {
      roomCode: code,
      gameStatus: room.gameStatus,
      options: room.options,
      availableMiddleGames: getAvailableMiddleGamesForRoom(room),
    });

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

    if (!room) {
      if (typeof ack === "function")
        ack({ ok: false, reason: "ROOM_NOT_FOUND" });
      return;
    }

    if (room.gameStatus !== "lobby") {
      if (typeof ack === "function")
        ack({ ok: false, reason: "GAME_ALREADY_STARTED" });
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

    room.gameStatus = "in_progress";
    broadcastOptions(code);

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

    room.r1.pickEndsAt = null;
    room.r1.questionEndsAt = null;
    room.r1.fastest = null;

    room.r1.chooserPlayerId = null;
    room.r1.pickOptions = null;
    if (room.r1.pickTimer) {
      clearTimeout(room.r1.pickTimer);
      room.r1.pickTimer = null;
    }

    // Reset Final
    if (room.final?.fallInterval) clearInterval(room.final.fallInterval);
    room.final = null;

    broadcastState(code);
    broadcastR1FastestState(code);

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

      if (fastest.winnerPlayerId) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "ALREADY_HAS_WINNER" });
        return;
      }

      if (fastest.lockedOutPlayerIds.has(pid)) {
        if (typeof ack === "function") ack({ ok: false, reason: "LOCKED_OUT" });
        return;
      }

      fastest.answeredPlayerIds.add(pid);

      const correct = ch === q.correct;

      if (correct) {
        fastest.winnerPlayerId = pid;
        fastest.winnerChoice = ch;

        clearR1QuestionTimer(room);

        const p = room.players[pid];
        if (p) addScoreClamped(p, SCORE_CORRECT);

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

        setTimeout(() => startR1NextQuestion(code), 900);
        return;
      }

      fastest.lockedOutPlayerIds.add(pid);

      const p = room.players[pid];
      if (p) addScoreClamped(p, SCORE_WRONG);

      io.to(code).emit("server:r1_answer_locked_out", {
        roomCode: code,
        questionId: q.id,
        answeringPlayerId: pid,
        answeringDisplayName: p ? p.displayName : null,
        chosen: ch,
        correctChoice: q.correct,
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

      room.r1.pickEndsAt = null;

      if (typeof ack === "function") ack({ ok: true });

      startR1Block(code, pick, room.r1.blockIndex + 1);
    }
  );

  // --------------------
  // FINAL: phone answer tap
  // --------------------
  socket.on(
    "phone:final_answer_tap",
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

      if (room.state !== "FINAL_QUESTION_OPEN") {
        if (typeof ack === "function")
          ack({ ok: false, reason: "QUESTION_NOT_OPEN" });
        return;
      }

      const pid = playerId || socket.id;
      if (!room.players[pid]) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "PLAYER_NOT_IN_ROOM" });
        return;
      }

      if (!room.final?.alivePlayerIds?.includes(pid)) {
        if (typeof ack === "function") ack({ ok: false, reason: "NOT_ALIVE" });
        return;
      }

      const ch = String(choice || "")
        .trim()
        .toUpperCase();
      if (!["A", "B", "C", "D"].includes(ch)) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "INVALID_CHOICE" });
        return;
      }

      // One answer per question
      if (room.final.answered[pid]) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "ALREADY_ANSWERED" });
        return;
      }

      const q = room.final.currentQuestion;
      if (!q) {
        if (typeof ack === "function")
          ack({ ok: false, reason: "NO_CURRENT_QUESTION" });
        return;
      }

      room.final.answered[pid] = {
        choice: ch,
        atMs: Date.now(),
      };

      // Tell the phone it "locked in"
      if (typeof ack === "function") ack({ ok: true });

      // Broadcast a lightweight update (optional)
      io.to(code).emit("server:final_answer_received", {
        roomCode: code,
        playerId: pid,
        displayName: room.players[pid]?.displayName ?? null,
      });

      // If everyone alive answered, reveal immediately
      const alive = room.final.alivePlayerIds;
      let allAnswered = true;
      for (const aPid of alive) {
        if (!room.final.answered[aPid]) {
          allAnswered = false;
          break;
        }
      }
      if (allAnswered) {
        finalizeFinalQuestion(code, "all_answered");
      }
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

    if (room.r1?.pickTimer) clearTimeout(room.r1.pickTimer);
    if (room.r1?.fastest?.questionTimer)
      clearTimeout(room.r1.fastest.questionTimer);

    if (room.final?.fallInterval) clearInterval(room.final.fallInterval);

    delete rooms[code];

    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];

      if (room.hostSocketId === socket.id) {
        console.log(`Host disconnected; closing room ${code}`);
        io.to(code).emit("server:error", { code: "ROOM_CLOSED" });

        if (room.r1?.pickTimer) clearTimeout(room.r1.pickTimer);
        if (room.r1?.fastest?.questionTimer)
          clearTimeout(room.r1.fastest.questionTimer);

        if (room.final?.fallInterval) clearInterval(room.final.fallInterval);

        delete rooms[code];
        continue;
      }

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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Host:  http://localhost:${PORT}/host`);
  console.log(`Phone: http://localhost:${PORT}/phone`);
});
