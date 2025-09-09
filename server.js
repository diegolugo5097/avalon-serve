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
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin confusos: I, L, O, 0, 1
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
      results: [], // [{round, winner, successVotes, failVotes}]
      goodWins: 0,
      assassinWins: 0,
      team: [], // socketIds
      votes: [], // [{playerId, vote}]
      missionVotes: [], // [{playerId, vote}]
      roles: {}, // { socketId: "Asesino" | "Bueno" }
      maxPlayers: 5, // configurado al crear
      assassinCount: 2, // configurado al crear
      gameOver: false,
      cleanupTimeoutId: null,
      creatorId: null, // socket.id del creador
    };
  } else if (rooms[roomCode].cleanupTimeoutId) {
    clearTimeout(rooms[roomCode].cleanupTimeoutId);
    rooms[roomCode].cleanupTimeoutId = null;
  }
}

function replaceIdEverywhere(r, oldId, newId) {
  if (oldId === newId) return;

  // Mover rol
  if (r.roles[oldId]) {
    r.roles[newId] = r.roles[oldId];
    delete r.roles[oldId];
  }

  // Equipo
  r.team = r.team.map((id) => (id === oldId ? newId : id));

  // Votos de equipo
  r.votes = r.votes.map((v) =>
    v.playerId === oldId ? { ...v, playerId: newId } : v
  );

  // Votos de misión
  r.missionVotes = r.missionVotes.map((v) =>
    v.playerId === oldId ? { ...v, playerId: newId } : v
  );

  // Creador
  if (r.creatorId === oldId) r.creatorId = newId;
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
    // Revelamos roles sólo al final de la partida
    roles: r.phase === "gameOver" ? r.roles : undefined,
  };
}

/** Helpers */
function clampAssassins(totalPlayers, requested) {
  const maxAllowed = Math.max(1, totalPlayers - 1);
  const base =
    typeof requested === "number" ? requested : Math.floor(totalPlayers / 3);
  return Math.min(Math.max(1, base), maxAllowed);
}

/** Socket.IO */
io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  /** Crear sala: crea el room, mete al creador y emite roomCreated */
  socket.on("createRoom", ({ name, avatar, maxPlayers, assassinCount }) => {
    // Generar un código único
    let roomCode;
    do {
      roomCode = generateRoomCode();
    } while (rooms[roomCode]);

    ensureRoom(roomCode);
    const r = rooms[roomCode];

    // Sanitizar configuraciones
    const mp = Number(maxPlayers) || 5;
    r.maxPlayers = Math.min(Math.max(mp, 4), 10);
    r.assassinCount = clampAssassins(r.maxPlayers, Number(assassinCount));

    // Registrar creador y unir al room
    r.creatorId = socket.id;
    r.players[socket.id] = {
      id: socket.id,
      name: name || "?",
      avatar: avatar || null,
    };
    socket.join(roomCode);

    // Responder sólo al creador
    io.to(socket.id).emit("roomCreated", {
      roomCode,
      maxPlayers: r.maxPlayers,
      assassinCount: r.assassinCount,
    });

    // Compartir estado del lobby a la sala
    io.to(roomCode).emit("state", buildState(roomCode));
  });

  /** Unirse / Reconexion */
  socket.on("joinRoom", ({ name, roomCode, avatar, prevId }) => {
    const code = (roomCode || "").toUpperCase();
    if (!code) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "Código de sala inválido.",
      });
      return;
    }
    if (!rooms[code]) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "La sala no existe o expiró.",
      });
      return;
    }

    ensureRoom(code);
    const r = rooms[code];

    // Sala llena
    if (Object.keys(r.players).length >= r.maxPlayers && !r.players[prevId]) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "La sala ya está llena.",
      });
      return;
    }

    // Reasignación por reconexión
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
      // Alta normal
      r.players[socket.id] = {
        id: socket.id,
        name: name || "?",
        avatar: avatar || null,
      };
    }

    socket.join(code);

    // Si ya tenía rol (reconexión en medio de la partida), reenviarlo
    if (r.roles[socket.id]) {
      io.to(socket.id).emit("yourRole", r.roles[socket.id]);
    }

    io.to(code).emit("state", buildState(code));
  });

  /** Iniciar partida: sólo el creador */
  socket.on("startGame", ({ roomCode, assassinCount, maxPlayers }) => {
    const code = (roomCode || "").toUpperCase();
    const r = rooms[code];
    if (!r) return;

    if (socket.id !== r.creatorId) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "Solo quien creó la sala puede iniciar la partida.",
      });
      return;
    }

    // Validar que haya exactamente maxPlayers jugadores presentes
    const currentPlayers = Object.keys(r.players).length;
    if (currentPlayers !== r.maxPlayers) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: `Se requieren exactamente ${r.maxPlayers} jugadores para iniciar (hay ${currentPlayers}).`,
      });
      return;
    }

    // Permitir ajustar configuración si se envía (del creador)
    if (typeof maxPlayers === "number") {
      r.maxPlayers = Math.min(Math.max(Math.floor(maxPlayers), 4), 10);
    }
    r.assassinCount = clampAssassins(r.maxPlayers, Number(assassinCount));

    // Asignar roles
    const ids = Object.keys(r.players);
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    const evilCount = Math.min(r.assassinCount, ids.length - 1);

    r.roles = {};
    shuffled.forEach((id, i) => {
      r.roles[id] = i < evilCount ? "Asesino" : "Bueno";
      io.to(id).emit("yourRole", r.roles[id]);
    });

    // Reset de estado de juego
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

  /** Borrador de equipo por el líder */
  socket.on("draftTeam", ({ roomCode, team }) => {
    const code = (roomCode || "").toUpperCase();
    const r = rooms[code];
    if (!r || r.phase !== "teamSelection") return;

    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    r.team = Array.isArray(team) ? team.filter((id) => r.players[id]) : [];
    io.to(code).emit("state", buildState(code));
  });

  /** Confirmar equipo -> pasa a votación de equipo */
  socket.on("selectTeam", ({ roomCode, team }) => {
    const code = (roomCode || "").toUpperCase();
    const r = rooms[code];
    if (!r || r.phase !== "teamSelection") return;

    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    const total = r.maxPlayers; // usamos el total configurado para la sala
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
    io.to(code).emit("teamVoteStart");
    io.to(code).emit("state", buildState(code));
  });

  /** Voto de equipo */
  socket.on("voteTeam", ({ roomCode, vote }) => {
    const code = (roomCode || "").toUpperCase();
    const r = rooms[code];
    if (!r || r.phase !== "teamVote") return;

    // Evitar voto duplicado
    if (r.votes.find((v) => v.playerId === socket.id)) return;

    r.votes.push({
      playerId: socket.id,
      vote: vote === "Aprobar" ? "Aprobar" : "Rechazar",
    });
    io.to(code).emit("state", buildState(code));

    // Cuando votan todos los presentes
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
      io.to(code).emit("state", buildState(code));
    }
  });

  /** Voto de misión */
  socket.on("voteMission", ({ roomCode, vote }) => {
    const code = (roomCode || "").toUpperCase();
    const r = rooms[code];
    if (!r || r.phase !== "missionVote") return;

    // Sólo miembros del equipo pueden votar
    if (!r.team.includes(socket.id)) return;

    // Evitar voto duplicado
    if (r.missionVotes.find((v) => v.playerId === socket.id)) return;

    const norm = vote === "Fracaso" ? "Fracaso" : "Éxito";
    r.missionVotes.push({ playerId: socket.id, vote: norm });
    io.to(code).emit("state", buildState(code));

    // Cuando vota todo el equipo
    if (r.missionVotes.length === r.team.length) {
      const successVotes = r.missionVotes.filter(
        (v) => v.vote === "Éxito"
      ).length;
      const failVotes = r.missionVotes.filter(
        (v) => v.vote === "Fracaso"
      ).length;
      const fail = failVotes > 0;
      const winner = fail ? "Asesinos" : "Buenos";

      // Guardar resultado con conteos
      r.results.push({ round: r.round, winner, successVotes, failVotes });

      // Notificar resultado de misión con conteos (para el modal del front)
      io.to(code).emit("missionResult", {
        round: r.round,
        winner,
        successVotes,
        failVotes,
      });

      // Actualizar marcador global
      if (winner === "Buenos") r.goodWins++;
      else r.assassinWins++;

      // ¿Fin de partida?
      if (r.goodWins >= 3 || r.assassinWins >= 3 || r.round >= 5) {
        r.phase = "gameOver";
        io.to(code).emit("state", buildState(code));
        return;
      }

      // Siguiente ronda
      r.round++;
      r.phase = "teamSelection";
      r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
      r.team = [];
      r.votes = [];
      r.missionVotes = [];
      io.to(code).emit("state", buildState(code));
    }
  });

  /** Desconexión (con ventana de gracia si la sala queda vacía) */
  socket.on("disconnect", () => {
    for (const code in rooms) {
      const r = rooms[code];
      if (!r.players[socket.id]) continue;

      // Eliminar de jugadores y limpiar referencias
      delete r.players[socket.id];
      r.team = r.team.filter((id) => id !== socket.id);
      r.votes = r.votes.filter((v) => v.playerId !== socket.id);
      r.missionVotes = r.missionVotes.filter((v) => v.playerId !== socket.id);

      // Ajustar leaderIndex si quedó fuera de rango
      const size = Object.keys(r.players).length;
      if (size > 0 && r.leaderIndex >= size) {
        r.leaderIndex = r.leaderIndex % size;
      }

      if (size === 0) {
        // Programar limpieza de sala si nadie reconecta pronto
        if (r.cleanupTimeoutId) clearTimeout(r.cleanupTimeoutId);
        r.cleanupTimeoutId = setTimeout(() => {
          delete rooms[code];
          console.log("Sala eliminada por inactividad:", code);
        }, 15000);
      } else {
        io.to(code).emit("state", buildState(code));
      }
    }
  });
});

io.listen(PORT);
console.log(`Servidor corriendo en puerto ${PORT}`);
