const { Server } = require("socket.io");
const PORT = process.env.PORT || 3001;

const io = new Server({
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const rooms = {};

// Tabla oficial de jugadores requeridos por misión
const missionTeamSizes = {
  4: [2, 2, 2, 3, 3], // 👈 Soporte agregado para 4 jugadores
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
        votes: [],
        missionVotes: [],
        roles: {},
        maxPlayers: 4,
        gameOver: false,
      };
    }

    // Registrar o actualizar jugador
    rooms[room].players[socket.id] = {
      id: socket.id,
      name,
      avatar: avatar || null,
    };

    socket.join(room);

    // Si ya se asignaron roles, reenviamos su rol
    const role = rooms[room].roles[socket.id];
    if (role) {
      io.to(socket.id).emit("yourRole", role);

      // Si es asesino, reenvía la lista de asesinos
      if (role === "Asesino") {
        const assassinIds = Object.keys(rooms[room].roles).filter(
          (id) => rooms[room].roles[id] === "Asesino"
        );
        io.to(socket.id).emit("assassinList", assassinIds);
      }
    }

    io.to(room).emit("state", buildState(room));
  });

  // Iniciar juego
  socket.on("startGame", ({ room, assassinCount, maxPlayers }) => {
    const r = rooms[room];
    if (!r) return;

    r.maxPlayers = maxPlayers || Object.keys(r.players).length;

    // Asignar roles
    const playerIds = Object.keys(r.players);
    const shuffled = [...playerIds].sort(() => Math.random() - 0.5);

    const evilCount = assassinCount || Math.floor(playerIds.length / 3);
    const assassinIds = shuffled.slice(0, evilCount); // <- todos los asesinos

    shuffled.forEach((id, i) => {
      const role = i < evilCount ? "Asesino" : "Bueno";
      r.roles[id] = role;

      // Enviar rol individual
      io.to(id).emit("yourRole", role);

      // Si es asesino, enviarle en privado la lista de asesinos
      if (role === "Asesino") {
        io.to(id).emit("assassinList", assassinIds);
      }
    });

    r.phase = "teamSelection";
    r.leaderIndex = 0;
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

  // Confirmar equipo
  socket.on("selectTeam", ({ room, team }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamSelection") return;

    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    const totalPlayers = r.maxPlayers || Object.keys(r.players).length;
    const required = missionTeamSizes[totalPlayers]?.[r.round - 1];

    if (!required) {
      io.to(socket.id).emit("toast", {
        type: "error",
        msg: "No se pudo determinar la cantidad de jugadores requerida para esta misión.",
      });
      return;
    }

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
    r.phase = "teamVote";
    r.votes = [];
    io.to(room).emit("state", buildState(room));
  });

  // Votación de equipo
  socket.on("voteTeam", ({ room, vote }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamVote") return;

    if (r.votes.find((v) => v.playerId === socket.id)) return;

    r.votes.push({ playerId: socket.id, vote });
    io.to(room).emit("state", buildState(room));

    if (r.votes.length === Object.keys(r.players).length) {
      const yesVotes = r.votes.filter((v) => v.vote === "Aprobar").length;
      const majority = yesVotes > Object.keys(r.players).length / 2;

      if (majority) {
        r.phase = "missionVote";
        r.missionVotes = [];
      } else {
        r.phase = "teamSelection";
        r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
      }

      io.to(room).emit("state", buildState(room));
    }
  });

  // Votación de misión
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
    teamVotes: r.votes,
    missionVotes: r.missionVotes,
    players: Object.values(r.players),
    maxPlayers: r.maxPlayers,
    roles: r.roles, // 👈 Agregar esto
  };
}

io.listen(PORT);
console.log(`Servidor corriendo en puerto ${PORT}`);
