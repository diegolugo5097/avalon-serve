const { Server } = require("socket.io");
const PORT = process.env.PORT || 3001;

const io = new Server({
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const rooms = {};

// Tamaño de equipo por ronda y número de jugadores
const missionTeamSizes = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

io.on("connection", (socket) => {
  console.log(`Jugador conectado: ${socket.id}`);

  // Unirse a sala
  socket.on("joinRoom", ({ name, room, avatar }) => {
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
        teamVotes: [],
        missionVotes: [],
        roles: {},
        gameOver: false,
      };
    }

    rooms[room].players[socket.id] = {
      id: socket.id,
      name,
      avatar: avatar || null,
    };

    socket.join(room);
    io.to(room).emit("state", buildState(room));
  });

  // Iniciar juego
  socket.on("startGame", ({ room, assassinCount }) => {
    const r = rooms[room];
    if (!r) return;

    const playerIds = Object.keys(r.players);
    const shuffled = [...playerIds].sort(() => Math.random() - 0.5);

    const assassins = shuffled.slice(0, assassinCount);
    r.roles = {};
    playerIds.forEach((id) => {
      r.roles[id] = assassins.includes(id) ? "Asesino" : "Bueno";
      io.to(id).emit("yourRole", r.roles[id]); // Enviamos el rol a cada jugador
    });

    r.phase = "teamSelection";
    r.round = 1;
    r.team = [];
    r.teamVotes = [];
    r.missionVotes = [];
    r.results = [];
    r.goodWins = 0;
    r.assassinWins = 0;

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

  // Confirmar equipo → iniciar votación para aprobar o rechazar
  socket.on("selectTeam", ({ room, team }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamSelection") return;

    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    const totalPlayers = Object.keys(r.players).length;
    const required = missionTeamSizes[totalPlayers]?.[r.round - 1] || 2;

    const cleanTeam = Array.isArray(team)
      ? team.filter((id) => r.players[id])
      : [];

    if (cleanTeam.length !== required) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: `Debes elegir exactamente ${required} jugadores.`,
      });
      return;
    }

    r.team = cleanTeam;
    r.teamVotes = [];
    r.phase = "teamVote";

    // Notificar votación de equipo
    io.to(room).emit("teamVoteStart", { team: r.team });

    io.to(room).emit("state", buildState(room));
  });

  // Votación de equipo
  socket.on("voteTeam", ({ room, vote }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamVote") return;

    if (r.teamVotes.find((v) => v.playerId === socket.id)) return;

    r.teamVotes.push({ playerId: socket.id, vote });

    if (r.teamVotes.length === Object.keys(r.players).length) {
      const approvals = r.teamVotes.filter((v) => v.vote === "Aprobar").length;
      const rejections = r.teamVotes.length - approvals;

      if (approvals > rejections) {
        // Equipo aprobado → pasa a votación de misión
        r.phase = "missionVote";
        r.missionVotes = [];
      } else {
        // Equipo rechazado → pasa líder, misma ronda
        r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
        r.team = [];
        r.teamVotes = [];
        r.phase = "teamSelection";
      }
    }

    io.to(room).emit("state", buildState(room));
  });

  // Votación misión
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

      // Pasar a siguiente ronda
      r.round++;
      r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
      r.team = [];
      r.teamVotes = [];
      r.missionVotes = [];
      r.phase = "teamSelection";

      io.to(room).emit("state", buildState(room));
    }
  });

  // Desconexión de jugador
  socket.on("disconnect", () => {
    for (const room in rooms) {
      const r = rooms[room];
      if (r.players[socket.id]) {
        delete r.players[socket.id];

        if (Object.keys(r.players).length === 0) {
          delete rooms[room];
        } else {
          io.to(room).emit("state", buildState(room));
        }
      }
    }
  });
});

// Construir estado actualizado
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
    teamVotes: r.teamVotes,
    missionVotes: r.missionVotes,
    players: Object.values(r.players),
  };
}

io.listen(PORT);
console.log(`Servidor corriendo en puerto ${PORT}`);
