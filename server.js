// server.js
const { Server } = require("socket.io");
const PORT = process.env.PORT || 3001;

const io = new Server({
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const rooms = {};

// Tabla oficial (incluye 4 jugadores)
const missionTeamSizes = {
  4: [2, 2, 2, 3, 3],
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

function generateCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin confusos
  let code = "";
  for (let i = 0; i < len; i++)
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function ensureRoom(room) {
  if (!rooms[room]) {
    rooms[room] = {
      players: {},
      leaderIndex: 0,
      phase: "lobby",
      round: 1,
      results: [],
      goodWins: 0,
      assassinWins: 0,
      team: [],
      votes: [],
      missionVotes: [],
      roles: {}, // roles por socket.id
      maxPlayers: 4,
      gameOver: false,
      cleanupTimeoutId: null, // ventana de gracia si sala queda vacía
      config: {
        assassinCount: null, // preferencia al crear sala
      },
    };
  } else if (rooms[room].cleanupTimeoutId) {
    clearTimeout(rooms[room].cleanupTimeoutId);
    rooms[room].cleanupTimeoutId = null;
  }
}

function replaceIdEverywhere(r, oldId, newId) {
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
}

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // ✅ Crear sala con código
  socket.on("createRoom", ({ name, avatar, maxPlayers, assassinCount }) => {
    if (!name) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "Escribe un nombre",
      });
      return;
    }
    // Generar código único
    let code;
    do {
      code = generateCode(6);
    } while (rooms[code]);

    ensureRoom(code);
    const r = rooms[code];

    // Ajustar configuración inicial de la sala
    const mp = Number(maxPlayers || 4);
    r.maxPlayers = Math.min(Math.max(mp, 4), 10); // entre 4 y 10
    const ac = Number(assassinCount || 1);
    r.config.assassinCount = Math.max(1, Math.min(ac, r.maxPlayers - 1));
    r.phase = "lobby";
    r.round = 1;
    r.results = [];
    r.goodWins = 0;
    r.assassinWins = 0;
    r.team = [];
    r.votes = [];
    r.missionVotes = [];
    r.roles = {};
    r.gameOver = false;

    // Añadir creador a la sala
    r.players[socket.id] = { id: socket.id, name, avatar: avatar || null };
    socket.join(code);

    // Responder al creador con el código
    io.to(socket.id).emit("roomCreated", {
      roomCode: code,
      maxPlayers: r.maxPlayers,
      assassinCount: r.config.assassinCount,
    });
    // Enviar estado
    io.to(code).emit("state", buildState(code));
  });

  // ✅ Unirse/reconectar a una sala por código (o por nombre legacy)
  socket.on("joinRoom", ({ name, room, roomCode, avatar, prevId }) => {
    const resolvedRoom = (roomCode || room || "").toUpperCase();
    if (!resolvedRoom) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "Ingresa un código de sala",
      });
      return;
    }
    ensureRoom(resolvedRoom);
    const r = rooms[resolvedRoom];

    // Sala llena
    if (r.maxPlayers && Object.keys(r.players).length >= r.maxPlayers) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "La sala ya está llena",
      });
      return;
    }

    // Reasignación por prevId (reconexión)
    if (prevId && r.players[prevId]) {
      replaceIdEverywhere(r, prevId, socket.id);
      const old = r.players[prevId];
      delete r.players[prevId];
      r.players[socket.id] = {
        ...old,
        id: socket.id,
        name: name || old.name,
        avatar: avatar || old.avatar || null,
      };
    } else {
      // Alta normal
      r.players[socket.id] = { id: socket.id, name, avatar: avatar || null };
    }

    socket.join(resolvedRoom);

    // Si ya tenía rol, reenviar sólo a este socket
    if (r.roles[socket.id]) {
      io.to(socket.id).emit("yourRole", r.roles[socket.id]);
    }

    io.to(resolvedRoom).emit("state", buildState(resolvedRoom));
  });

  // Iniciar partida (usa config de la sala salvo que se envíe override)
  socket.on("startGame", ({ room, roomCode, assassinCount, maxPlayers }) => {
    const resolvedRoom = (roomCode || room || "").toUpperCase();
    const r = rooms[resolvedRoom];
    if (!r) return;

    // Permitir ajustar antes de iniciar (si llegan overrides)
    if (maxPlayers) {
      const mp = Number(maxPlayers);
      r.maxPlayers = Math.min(Math.max(mp, 4), 10);
    }
    const effectiveAssassins = Number(
      assassinCount ??
        r.config.assassinCount ??
        Math.floor(Object.keys(r.players).length / 3)
    );

    const ids = Object.keys(r.players);
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    const evilCount = Math.min(
      Math.max(1, effectiveAssassins),
      Math.max(1, ids.length - 1)
    );

    r.roles = {};
    shuffled.forEach((id, i) => {
      r.roles[id] = i < evilCount ? "Asesino" : "Bueno";
      io.to(id).emit("yourRole", r.roles[id]); // privado
    });

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

    io.to(resolvedRoom).emit("state", buildState(resolvedRoom));
  });

  // Borrador de equipo
  socket.on("draftTeam", ({ room, roomCode, team }) => {
    const resolvedRoom = (roomCode || room || "").toUpperCase();
    const r = rooms[resolvedRoom];
    if (!r || r.phase !== "teamSelection") return;
    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    r.team = Array.isArray(team) ? team.filter((id) => r.players[id]) : [];
    io.to(resolvedRoom).emit("state", buildState(resolvedRoom));
  });

  // Confirmar equipo ⇒ pasa a votación de equipo
  socket.on("selectTeam", ({ room, roomCode, team }) => {
    const resolvedRoom = (roomCode || room || "").toUpperCase();
    const r = rooms[resolvedRoom];
    if (!r || r.phase !== "teamSelection") return;
    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    const total = r.maxPlayers || Object.keys(r.players).length;
    const required = missionTeamSizes[total]?.[r.round - 1] ?? 2;

    const clean = Array.isArray(team) ? team.filter((id) => r.players[id]) : [];
    if (clean.length !== required) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: `Debes elegir exactamente ${required} jugadores.`,
      });
      return;
    }

    r.team = clean;
    r.phase = "teamVote";
    r.votes = [];
    io.to(resolvedRoom).emit("teamVoteStart");
    io.to(resolvedRoom).emit("state", buildState(resolvedRoom));
  });

  // Voto de equipo
  socket.on("voteTeam", ({ room, roomCode, vote }) => {
    const resolvedRoom = (roomCode || room || "").toUpperCase();
    const r = rooms[resolvedRoom];
    if (!r || r.phase !== "teamVote") return;
    if (r.votes.find((v) => v.playerId === socket.id)) return;

    r.votes.push({ playerId: socket.id, vote });
    io.to(resolvedRoom).emit("state", buildState(resolvedRoom));

    if (r.votes.length === Object.keys(r.players).length) {
      const yes = r.votes.filter((v) => v.vote === "Aprobar").length;
      const majority = yes > Object.keys(r.players).length / 2;

      if (majority) {
        r.phase = "missionVote";
        r.missionVotes = [];
      } else {
        r.phase = "teamSelection";
        r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
        r.team = [];
      }
      io.to(resolvedRoom).emit("state", buildState(resolvedRoom));
    }
  });

  // Voto de misión
  socket.on("voteMission", ({ room, roomCode, vote }) => {
    const resolvedRoom = (roomCode || room || "").toUpperCase();
    const r = rooms[resolvedRoom];
    if (!r || r.phase !== "missionVote") return;
    if (!r.team.includes(socket.id)) return;
    if (r.missionVotes.find((v) => v.playerId === socket.id)) return;

    r.missionVotes.push({ playerId: socket.id, vote });
    io.to(resolvedRoom).emit("state", buildState(resolvedRoom));

    if (r.missionVotes.length === r.team.length) {
      const fail = r.missionVotes.some((v) => v.vote === "Fracaso");
      const winner = fail ? "Asesinos" : "Buenos";
      r.results.push({ round: r.round, winner });
      if (winner === "Buenos") r.goodWins++;
      else r.assassinWins++;

      if (r.goodWins >= 3 || r.assassinWins >= 3 || r.round >= 5) {
        r.phase = "gameOver";
        r.gameOver = true;
        io.to(resolvedRoom).emit("state", buildState(resolvedRoom));
        return;
      }

      r.round++;
      r.phase = "teamSelection";
      r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
      r.team = [];
      r.votes = [];
      r.missionVotes = [];
      io.to(resolvedRoom).emit("state", buildState(resolvedRoom));
    }
  });

  // Desconexión (limpieza si la sala queda vacía)
  socket.on("disconnect", () => {
    for (const room in rooms) {
      const r = rooms[room];
      if (r.players[socket.id]) {
        delete r.players[socket.id];
        r.team = r.team.filter((id) => id !== socket.id);
        r.votes = r.votes.filter((v) => v.playerId !== socket.id);
        r.missionVotes = r.missionVotes.filter((v) => v.playerId !== socket.id);

        if (Object.keys(r.players).length === 0) {
          if (r.cleanupTimeoutId) clearTimeout(r.cleanupTimeoutId);
          r.cleanupTimeoutId = setTimeout(() => {
            delete rooms[room];
            console.log("Sala eliminada por inactividad:", room);
          }, 15000);
        } else {
          io.to(room).emit("state", buildState(room));
        }
      }
    }
  });
});

function buildState(room) {
  const r = rooms[room];
  const payload = {
    phase: r.phase,
    leaderId: Object.keys(r.players)[r.leaderIndex],
    round: r.round,
    results: r.results,
    goodWins: r.goodWins,
    assassinWins: r.assassinWins,
    team: r.team,
    teamVotes: r.votes,
    missionVotes: r.missionVotes,
    players: Object.values(r.players),
    maxPlayers: r.maxPlayers,
    // Nota: no exponemos config ni roles salvo al final
  };
  // Revela roles sólo al finalizar la partida (para el modal final del front)
  if (r.phase === "gameOver") {
    payload.roles = r.roles;
  }
  return payload;
}

io.listen(PORT);
console.log(`Servidor corriendo en puerto ${PORT}`);
