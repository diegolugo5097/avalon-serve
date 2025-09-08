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
      cleanupTimeoutId: null, // ventana de gracia
    };
  } else if (rooms[room].cleanupTimeoutId) {
    clearTimeout(rooms[room].cleanupTimeoutId);
    rooms[room].cleanupTimeoutId = null;
  }
}

function replaceIdEverywhere(r, oldId, newId) {
  // Mover rol
  if (r.roles[oldId]) {
    r.roles[newId] = r.roles[oldId];
    delete r.roles[oldId];
  }
  // Reemplazar en equipo
  r.team = r.team.map((id) => (id === oldId ? newId : id));
  // Reemplazar en votos de equipo
  r.votes = r.votes.map((v) =>
    v.playerId === oldId ? { ...v, playerId: newId } : v
  );
  // Reemplazar en votos de misión
  r.missionVotes = r.missionVotes.map((v) =>
    v.playerId === oldId ? { ...v, playerId: newId } : v
  );
}

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // Unirse/reconectar
  socket.on("joinRoom", ({ name, room, avatar, prevId }) => {
    ensureRoom(room);
    const r = rooms[room];

    // Sala llena
    if (r.maxPlayers && Object.keys(r.players).length >= r.maxPlayers) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "La sala ya está llena",
      });
      return;
    }

    if (prevId && r.players[prevId]) {
      // Reasignación completa al nuevo socket.id
      replaceIdEverywhere(r, prevId, socket.id);
      const old = r.players[prevId];
      delete r.players[prevId];
      r.players[socket.id] = {
        ...old,
        id: socket.id,
        name,
        avatar: avatar || old.avatar || null,
      };
    } else {
      // Alta normal
      r.players[socket.id] = { id: socket.id, name, avatar: avatar || null };
    }

    socket.join(room);

    // Si ya tenía rol, reenviar
    if (r.roles[socket.id]) {
      io.to(socket.id).emit("yourRole", r.roles[socket.id]);
    }

    io.to(room).emit("state", buildState(room));
  });

  // Iniciar partida
  socket.on("startGame", ({ room, assassinCount, maxPlayers }) => {
    const r = rooms[room];
    if (!r) return;

    r.maxPlayers = maxPlayers || Object.keys(r.players).length;

    const ids = Object.keys(r.players);
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    const evilCount = Math.min(
      assassinCount ?? Math.floor(ids.length / 3),
      ids.length - 1
    );

    r.roles = {};
    shuffled.forEach((id, i) => {
      r.roles[id] = i < evilCount ? "Asesino" : "Bueno";
      io.to(id).emit("yourRole", r.roles[id]);
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

    io.to(room).emit("state", buildState(room));
  });

  // Borrador de equipo
  socket.on("draftTeam", ({ room, team }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamSelection") return;
    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    r.team = Array.isArray(team) ? team.filter((id) => r.players[id]) : [];
    io.to(room).emit("state", buildState(room));
  });

  // Confirmar equipo ⇒ pasa a votación de equipo
  socket.on("selectTeam", ({ room, team }) => {
    const r = rooms[room];
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
    io.to(room).emit("teamVoteStart");
    io.to(room).emit("state", buildState(room));
  });

  // Voto de equipo
  socket.on("voteTeam", ({ room, vote }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamVote") return;
    if (r.votes.find((v) => v.playerId === socket.id)) return;

    r.votes.push({ playerId: socket.id, vote });
    io.to(room).emit("state", buildState(room));

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
      io.to(room).emit("state", buildState(room));
    }
  });

  // Voto de misión
  socket.on("voteMission", ({ room, vote }) => {
    const r = rooms[room];
    if (!r || r.phase !== "missionVote") return;
    if (!r.team.includes(socket.id)) return;
    if (r.missionVotes.find((v) => v.playerId === socket.id)) return;

    r.missionVotes.push({ playerId: socket.id, vote });
    io.to(room).emit("state", buildState(room));

    if (r.missionVotes.length === r.team.length) {
      const fail = r.missionVotes.some((v) => v.vote === "Fracaso");
      const winner = fail ? "Asesinos" : "Buenos";
      r.results.push({ round: r.round, winner });
      if (winner === "Buenos") r.goodWins++;
      else r.assassinWins++;

      if (r.goodWins >= 3 || r.assassinWins >= 3 || r.round >= 5) {
        r.phase = "gameOver";
        io.to(room).emit("state", buildState(room));
        return;
      }

      r.round++;
      r.phase = "teamSelection";
      r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
      r.team = [];
      r.votes = [];
      r.missionVotes = [];
      io.to(room).emit("state", buildState(room));
    }
  });

  // Desconexión (con ventana de gracia)
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
          }, 15000); // ⏳ 15s para reconectar tras refresh
        } else {
          io.to(room).emit("state", buildState(room));
        }
      }
    }
  });
});

function buildState(room) {
  const r = rooms[room];
  return {
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
  };
}

io.listen(PORT);
console.log(`Servidor corriendo en puerto ${PORT}`);
