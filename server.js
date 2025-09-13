// server.js
const { Server } = require("socket.io");
const PORT = process.env.PORT || 3001;

const io = new Server({
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const rooms = {};

/** Tabla oficial de tamaño de equipo por número de jugadores totales */
const missionTeamSizes = {
  4: [2, 2, 2, 3, 3],
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

function generateRoomCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin confusos
  let code = "";
  for (let i = 0; i < len; i++)
    code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function ensureRoom(roomCode) {
  if (!rooms[roomCode]) {
    rooms[roomCode] = {
      players: {}, // { socketId: {id, name, avatar} }
      leaderIndex: 0,
      phase: "lobby",
      round: 1,
      results: [],
      goodWins: 0,
      assassinWins: 0,
      team: [],
      votes: [],
      missionVotes: [],
      roles: {},
      maxPlayers: 5,
      assassinCount: 2,
      gameOver: false,
      cleanupTimeoutId: null,
      creatorId: null,
      // 🔹 Configuración modo líder
      leaderMode: false,
      leaderIdRole: null,
    };
  } else if (rooms[roomCode].cleanupTimeoutId) {
    clearTimeout(rooms[roomCode].cleanupTimeoutId);
    rooms[roomCode].cleanupTimeoutId = null;
  }
}

function replaceIdEverywhere(r, oldId, newId) {
  if (oldId === newId) return;

  if (r.roles[oldId]) {
    r.roles[newId] = r.roles[oldId];
    delete r.roles[oldId];
  }

  r.team = r.team.map((id) => (id === oldId ? newId : id));

  r.votes = r.votes.map((v) =>
    v.playerId === oldId ? { ...v, playerId: newId } : v
  );

  r.missionVotes = r.missionVotes.map((v) =>
    v.playerId === oldId ? { ...v, playerId: newId } : v
  );

  if (r.creatorId === oldId) r.creatorId = newId;
  if (r.leaderIdRole === oldId) r.leaderIdRole = newId;
}

function buildState(roomCode) {
  const r = rooms[roomCode];
  return {
    phase: r.phase,
    leaderId: Object.keys(r.players)[r.leaderIndex] || null,
    round: r.round,
    results: r.results,
    goodWins: r.goodWins,
    assassinWins: r.assassinWins,
    team: r.team,
    teamVotes: r.votes,
    missionVotes: r.missionVotes,
    players: Object.values(r.players),
    maxPlayers: r.maxPlayers,
    leaderMode: r.leaderMode,
    leaderIdRole: r.leaderMode ? r.leaderIdRole : null,
    roles: r.phase === "gameOver" ? r.roles : undefined,
  };
}

function clampAssassins(totalPlayers, requested) {
  const maxAllowed = Math.max(1, totalPlayers - 1);
  const base =
    typeof requested === "number" ? requested : Math.floor(totalPlayers / 3);
  return Math.min(Math.max(1, base), maxAllowed);
}

/** Socket.IO */
io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  /** Crear sala */
  socket.on(
    "createRoom",
    ({ name, avatar, maxPlayers, assassinCount, leaderMode }) => {
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (rooms[roomCode]);

      ensureRoom(roomCode);
      const r = rooms[roomCode];

      const mp = Number(maxPlayers) || 5;
      r.maxPlayers = Math.min(Math.max(mp, 4), 10);
      r.assassinCount = clampAssassins(r.maxPlayers, Number(assassinCount));
      r.leaderMode = !!leaderMode; // 🔹 activar o no el modo líder

      r.creatorId = socket.id;
      r.players[socket.id] = {
        id: socket.id,
        name: name || "?",
        avatar: avatar || null,
      };
      socket.join(roomCode);

      io.to(socket.id).emit("roomCreated", {
        roomCode,
        maxPlayers: r.maxPlayers,
        assassinCount: r.assassinCount,
        leaderMode: r.leaderMode,
      });

      io.to(roomCode).emit("state", buildState(roomCode));
    }
  );

  /** Unirse */
  socket.on("joinRoom", ({ name, roomCode, avatar, prevId }) => {
    const code = (roomCode || "").toUpperCase();
    if (!code || !rooms[code]) {
      io.to(socket.id).emit("toast", { type: "error", msg: "Sala inválida." });
      return;
    }
    ensureRoom(code);
    const r = rooms[code];

    if (Object.keys(r.players).length >= r.maxPlayers && !r.players[prevId]) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "La sala ya está llena.",
      });
      return;
    }

    if (prevId && r.players[prevId]) {
      replaceIdEverywhere(r, prevId, socket.id);
      const old = r.players[prevId];
      delete r.players[prevId];
      r.players[socket.id] = {
        ...old,
        id: socket.id,
        name: name || old.name || "?",
        avatar: avatar || old.avatar || null,
      };
    } else {
      r.players[socket.id] = {
        id: socket.id,
        name: name || "?",
        avatar: avatar || null,
      };
    }

    socket.join(code);

    if (r.roles[socket.id])
      io.to(socket.id).emit("yourRole", r.roles[socket.id]);

    io.to(code).emit("state", buildState(code));
  });

  /** Iniciar partida */
  socket.on("startGame", ({ roomCode, assassinCount, maxPlayers }) => {
    const code = (roomCode || "").toUpperCase();
    const r = rooms[code];
    if (!r) return;

    if (socket.id !== r.creatorId) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "Solo el creador puede iniciar.",
      });
      return;
    }

    const currentPlayers = Object.keys(r.players).length;
    if (currentPlayers !== r.maxPlayers) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: `Se requieren ${r.maxPlayers} jugadores (hay ${currentPlayers}).`,
      });
      return;
    }

    if (typeof maxPlayers === "number") {
      r.maxPlayers = Math.min(Math.max(Math.floor(maxPlayers), 4), 10);
    }
    r.assassinCount = clampAssassins(r.maxPlayers, Number(assassinCount));

    const ids = Object.keys(r.players);
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    const evilCount = Math.min(r.assassinCount, ids.length - 1);

    r.roles = {};
    shuffled.forEach((id, i) => {
      r.roles[id] = i < evilCount ? "Asesino" : "Bueno";
      io.to(id).emit("yourRole", r.roles[id]);
    });

    // 🔹 Asignar líder si el modo está activo
    if (r.leaderMode) {
      const goodPlayers = shuffled.slice(evilCount);
      const leaderId =
        goodPlayers[Math.floor(Math.random() * goodPlayers.length)];
      r.roles[leaderId] = "Líder";
      r.leaderIdRole = leaderId;
      io.to(leaderId).emit("yourRole", "Líder");

      // Revelar asesinos al líder
      const assassins = shuffled
        .slice(0, evilCount)
        .map((id) => r.players[id].name);
      io.to(leaderId).emit("assassinsRevealed", assassins);
    }

    // Resetear estado
    r.phase = "teamSelection";
    r.leaderIndex = 0;
    r.round = 1;
    r.results = [];
    r.goodWins = 0;
    r.assassinWins = 0;
    r.team = [];
    r.votes = [];
    r.missionVotes = [];
    r.gameOver = false;

    io.to(code).emit("state", buildState(code));
  });

  /** Voto misión */
  socket.on("voteMission", ({ roomCode, vote }) => {
    const code = (roomCode || "").toUpperCase();
    const r = rooms[code];
    if (!r || r.phase !== "missionVote") return;

    if (!r.team.includes(socket.id)) return;
    if (r.missionVotes.find((v) => v.playerId === socket.id)) return;

    const norm = vote === "Fracaso" ? "Fracaso" : "Éxito";
    r.missionVotes.push({ playerId: socket.id, vote: norm });
    io.to(code).emit("state", buildState(code));

    if (r.missionVotes.length === r.team.length) {
      const successVotes = r.missionVotes.filter(
        (v) => v.vote === "Éxito"
      ).length;
      const failVotes = r.missionVotes.filter(
        (v) => v.vote === "Fracaso"
      ).length;
      const fail = failVotes > 0;
      const winner = fail ? "Asesinos" : "Buenos";

      r.results.push({ round: r.round, winner, successVotes, failVotes });
      io.to(code).emit("missionResult", {
        round: r.round,
        winner,
        successVotes,
        failVotes,
      });

      if (winner === "Buenos") r.goodWins++;
      else r.assassinWins++;

      // 🔹 Fin de partida con fase de asesinato del líder
      if (r.goodWins >= 3 || r.assassinWins >= 3 || r.round >= 5) {
        if (r.leaderMode && r.goodWins >= 3) {
          r.phase = "assassination";
          io.to(code).emit("state", buildState(code));
          return;
        } else {
          r.phase = "gameOver";
          io.to(code).emit("state", buildState(code));
          return;
        }
      }

      r.round++;
      r.phase = "teamSelection";
      r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
      r.team = [];
      r.votes = [];
      r.missionVotes = [];
      io.to(code).emit("state", buildState(code));
    }
  });

  /** Asesinato del líder */
  socket.on("assassinateLeader", ({ roomCode, targetId }) => {
    const code = (roomCode || "").toUpperCase();
    const r = rooms[code];
    if (!r || r.phase !== "assassination") return;

    if (targetId === r.leaderIdRole) {
      r.assassinWins++;
    } else {
      r.goodWins++;
    }
    r.phase = "gameOver";
    io.to(code).emit("state", buildState(code));
  });

  /** Desconexión */
  socket.on("disconnect", () => {
    for (const code in rooms) {
      const r = rooms[code];
      if (!r.players[socket.id]) continue;

      delete r.players[socket.id];
      r.team = r.team.filter((id) => id !== socket.id);
      r.votes = r.votes.filter((v) => v.playerId !== socket.id);
      r.missionVotes = r.missionVotes.filter((v) => v.playerId !== socket.id);

      const size = Object.keys(r.players).length;
      if (size > 0 && r.leaderIndex >= size) {
        r.leaderIndex = r.leaderIndex % size;
      }

      if (size === 0) {
        if (r.cleanupTimeoutId) clearTimeout(r.cleanupTimeoutId);
        r.cleanupTimeoutId = setTimeout(() => {
          delete rooms[code];
          console.log("Sala eliminada:", code);
        }, 15000);
      } else {
        io.to(code).emit("state", buildState(code));
      }
    }
  });
});

io.listen(PORT);
console.log(`Servidor corriendo en puerto ${PORT}`);
