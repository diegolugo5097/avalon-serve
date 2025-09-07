// server.js
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const io = new Server({
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Estado en memoria
const rooms = {};

// Helpers
const nextLeader = (roomData) => {
  const ids = Object.keys(roomData.players);
  roomData.leaderIndex = (roomData.leaderIndex + 1) % ids.length;
  return ids[roomData.leaderIndex];
};
const emitRoomState = (room) => {
  const r = rooms[room];
  if (!r) return;
  io.to(room).emit("state", {
    phase: r.phase,
    leaderId: Object.keys(r.players)[r.leaderIndex] || null,
    round: r.round,
    results: r.results, // [{round, winner, reason}]
    goodWins: r.goodWins,
    assassinWins: r.assassinWins,
    team: r.team,
    teamVotes: r.votes,
    missionVotes: r.missionVotes,
    players: Object.values(r.players).map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
    })),
  });
};

io.on("connection", (socket) => {
  // Unirse
  socket.on("joinRoom", ({ name, room, avatar }) => {
    if (!room || !name) return;

    if (!rooms[room]) {
      rooms[room] = {
        players: {},
        leaderIndex: 0,
        phase: "lobby",
        team: [],
        votes: [],
        missionVotes: [],
        roles: {}, // socketId -> "Asesino" | "Bueno"
        assassinCount: 1,
        round: 1,
        maxRounds: 5,
        results: [], // historial de rondas
        goodWins: 0,
        assassinWins: 0,
        gameOver: false,
      };
    }

    rooms[room].players[socket.id] = {
      id: socket.id,
      name,
      avatar: avatar || null,
    };
    socket.join(room);
    emitRoomState(room);
  });

  // Iniciar partida (con cantidad de asesinos configurable)
  socket.on("startGame", ({ room, assassinCount }) => {
    const r = rooms[room];
    if (!r) return;

    const ids = Object.keys(r.players);
    if (ids.length < 2) {
      io.to(room).emit("toast", {
        type: "error",
        msg: "Se requieren al menos 5 jugadores.",
      });
      return;
    }

    // Configurar cantidad de asesinos (1 .. players-1)
    const count = Math.max(1, Math.min(assassinCount || 1, ids.length - 1));
    r.assassinCount = count;

    // Asignar roles: primeros "count" serán Asesinos
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    r.roles = {};
    shuffled.forEach(
      (id, i) => (r.roles[id] = i < count ? "Asesino" : "Bueno")
    );

    r.phase = "teamSelection";
    r.round = 1;
    r.goodWins = 0;
    r.assassinWins = 0;
    r.results = [];
    r.team = [];
    r.votes = [];
    r.missionVotes = [];
    r.gameOver = false;
    r.leaderIndex = 0;

    // Enviar rol privado a cada jugador
    shuffled.forEach((id) => {
      io.to(id).emit("yourRole", r.roles[id]);
    });

    emitRoomState(room);
  });

  // Selección de equipo por el líder (no forzamos tamaño específico)
  socket.on("selectTeam", ({ room, team }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamSelection") return;

    // Solo líder puede confirmar
    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    // Validar cantidad según reglas oficiales
    const sizes = {
      5: [2, 3, 2, 3, 3],
      6: [2, 3, 4, 3, 4],
      7: [2, 3, 3, 4, 4],
      8: [3, 4, 4, 5, 5],
      9: [3, 4, 4, 5, 5],
      10: [3, 4, 4, 5, 5],
    };
    const total = Object.keys(r.players).length;
    const required = sizes[total]?.[r.round - 1] ?? 2;

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
    r.votes = []; // si todavía guardas votos de equipo, límpialos
    r.missionVotes = []; // votos de misión empiezan vacíos
    r.phase = "missionVote";

    io.to(room).emit("state", {
      phase: r.phase,
      leaderId,
      round: r.round,
      results: r.results,
      goodWins: r.goodWins,
      assassinWins: r.assassinWins,
      team: r.team,
      teamVotes: r.votes,
      missionVotes: r.missionVotes,
      players: Object.values(r.players),
    });
  });

  // Votación del equipo (regla: si hay exactamente 1 rechazo, ganan Asesinos la ronda)
  socket.on("voteTeam", ({ room, vote }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamVote") return;
    if (r.votes.find((v) => v.id === socket.id)) return;

    r.votes.push({ id: socket.id, vote }); // "Sí" | "No"

    emitRoomState(room);

    // Cuando todos ya votaron el equipo
    if (r.votes.length === Object.keys(r.players).length) {
      const noVotes = r.votes.filter((v) => v.vote === "No").length;
      const yesVotes = r.votes.length - noVotes;

      // Regla especial
      if (noVotes === 1) {
        // Ronda para Asesinos por "un solo rechazo"
        r.assassinWins++;
        r.results.push({
          round: r.round,
          winner: "Asesinos",
          reason: "rechazo único en votación de equipo",
        });
        r.round++;
        r.phase = "teamSelection";
        r.team = [];
        r.votes = [];
        r.missionVotes = [];
        nextLeader(r);

        // ¿fin?
        if (r.assassinWins >= 3 || r.round > r.maxRounds) r.gameOver = true;
        if (r.goodWins >= 3) r.gameOver = true;

        io.to(room).emit("roundResolved", r.results[r.results.length - 1]);
        emitRoomState(room);
        return;
      }

      // Si mayoría aprueba, pasamos a votación de misión
      if (yesVotes > noVotes) {
        r.phase = "missionVote";
        r.missionVotes = [];
        emitRoomState(room);
      } else {
        // Rechazado (pero no por la regla especial): cambia líder y se sigue en la misma ronda
        r.phase = "teamSelection";
        r.team = [];
        r.votes = [];
        nextLeader(r);
        emitRoomState(room);
      }
    }
  });

  // Votación de misión (si hay al menos un Fracaso => gana Asesinos la ronda; si no, gana Buenos)
  socket.on("voteMission", ({ room, vote }) => {
    const r = rooms[room];
    if (!r || r.phase !== "missionVote") return;
    if (!r.team.includes(socket.id)) return; // solo votan los del equipo

    // Evitar voto duplicado
    if (r.missionVotes.find((v) => v.playerId === socket.id)) return;

    r.missionVotes.push({ playerId: socket.id, vote });

    // Broadcast del progreso
    const leaderId = Object.keys(r.players)[r.leaderIndex];
    io.to(room).emit("state", {
      phase: r.phase,
      leaderId,
      round: r.round,
      results: r.results,
      goodWins: r.goodWins,
      assassinWins: r.assassinWins,
      team: r.team,
      teamVotes: r.votes,
      missionVotes: r.missionVotes,
      players: Object.values(r.players),
    });

    // Cuando todos los del equipo votaron -> resolver automáticamente
    if (r.missionVotes.length === r.team.length) {
      const fail = r.missionVotes.some((v) => v.vote === "Fracaso");
      const winner = fail ? "Asesinos" : "Buenos";

      r.results.push({ round: r.round, winner });
      if (winner === "Buenos") r.goodWins++;
      else r.assassinWins++;

      // ¿Fin de partida?
      const finished = r.goodWins >= 3 || r.assassinWins >= 3 || r.round >= 5;
      if (finished) {
        r.phase = "gameOver";
        io.to(room).emit("state", {
          phase: r.phase,
          leaderId,
          round: r.round,
          results: r.results,
          goodWins: r.goodWins,
          assassinWins: r.assassinWins,
          team: r.team,
          teamVotes: r.votes,
          missionVotes: r.missionVotes,
          players: Object.values(r.players),
        });
        return;
      }

      // Siguiente ronda
      r.round++;
      r.phase = "teamSelection";
      r.leaderIndex = (r.leaderIndex + 1) % Object.keys(r.players).length;
      r.team = [];
      r.votes = [];
      r.missionVotes = [];

      io.to(room).emit("state", {
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
      });
    }
  });

  socket.on("draftTeam", ({ room, team }) => {
    const r = rooms[room];
    if (!r || r.phase !== "teamSelection") return;
    // Solo líder
    const leaderId = Object.keys(r.players)[r.leaderIndex];
    if (socket.id !== leaderId) return;

    r.team = Array.isArray(team) ? team.filter((id) => r.players[id]) : [];
    // No se cambia la fase; solo se refleja el borrador a todos
    io.to(room).emit("state", {
      phase: r.phase,
      leaderId,
      round: r.round,
      results: r.results,
      goodWins: r.goodWins,
      assassinWins: r.assassinWins,
      team: r.team,
      teamVotes: r.votes,
      missionVotes: r.missionVotes,
      players: Object.values(r.players),
    });
  });

  // Salida
  socket.on("disconnect", () => {
    for (const room of Object.keys(rooms)) {
      const r = rooms[room];
      if (!r.players[socket.id]) continue;
      delete r.players[socket.id];
      // Si se quedó sin jugadores, limpialo
      if (Object.keys(r.players).length === 0) {
        delete rooms[room];
      } else {
        // Ajustar líder si es necesario
        r.leaderIndex = 0;
        emitRoomState(room);
      }
    }
  });
});

io.listen(PORT);
console.log("Socket.io listo en", PORT);
