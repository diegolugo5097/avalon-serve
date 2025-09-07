// server.js
const { Server } = require("socket.io");
const cors = require("cors");

// Puerto de Render o local
const PORT = process.env.PORT || 3001;

// Inicializar servidor de Socket.io con CORS
const io = new Server({
  cors: {
    origin: "*", // Permite cualquier frontend, o cambia a tu dominio de Netlify
    methods: ["GET", "POST"],
  },
});

// Estado de las salas
const rooms = {};

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // Unirse a una sala
  socket.on("joinRoom", ({ name, room }) => {
    if (!room || !name) {
      console.log("Error: nombre o sala no definido", name, room);
      return;
    }

    // Crear sala si no existe
    if (!rooms[room]) {
      rooms[room] = {
        players: {},
        leaderIndex: 0,
        phase: "lobby",
        team: [],
        results: [],
        votes: [],
        missionVotes: [],
        roles: {},
        goodWins: 0,
        evilWins: 0,
        gameOver: false,
      };
    }

    rooms[room].players[socket.id] = { name, id: socket.id };
    socket.join(room);

    io.to(room).emit("updatePlayers", Object.values(rooms[room].players));
    console.log(`Jugador ${name} unido a sala ${room}`);
  });

  // Iniciar juego
  socket.on("startGame", ({ room }) => {
    const roomData = rooms[room];
    if (!roomData) return;

    const playerIds = Object.keys(roomData.players);
    if (playerIds.length === 0) return;

    // Asignar roles
    const shuffled = playerIds.sort(() => Math.random() - 0.5);
    const evilCount = Math.floor(playerIds.length / 3);
    shuffled.forEach((id, i) => {
      roomData.roles[id] = i < evilCount ? "Malo" : "Bueno";
    });

    roomData.phase = "teamSelection";

    io.to(room).emit("gameStarted", {
      phase: roomData.phase,
      leaderId: playerIds[roomData.leaderIndex],
      roles: roomData.roles,
    });
  });

  // Selección de equipo
  socket.on("selectTeam", ({ room, team }) => {
    const roomData = rooms[room];
    if (!roomData || roomData.phase !== "teamSelection") return;

    roomData.team = team;
    roomData.phase = "teamVote";
    roomData.votes = [];

    io.to(room).emit("teamSelected", { team, phase: "teamVote" });
  });

  // Votación del equipo
  socket.on("voteTeam", ({ room, playerId, vote }) => {
    const roomData = rooms[room];
    if (!roomData) return;

    if (!roomData.votes.find((v) => v.playerId === playerId)) {
      roomData.votes.push({ playerId, vote });
      io.to(room).emit("updateTeamVotes", roomData.votes);

      // Cuando todos votan
      if (roomData.votes.length === Object.keys(roomData.players).length) {
        const yesVotes = roomData.votes.filter((v) => v.vote === "Sí").length;
        if (yesVotes > Object.keys(roomData.players).length / 2) {
          roomData.phase = "missionVote";
          roomData.missionVotes = [];
          io.to(room).emit("teamVoteResult", {
            success: true,
            phase: "missionVote",
          });
        } else {
          roomData.phase = "teamSelection";
          roomData.leaderIndex =
            (roomData.leaderIndex + 1) % Object.keys(roomData.players).length;
          io.to(room).emit("teamVoteResult", {
            success: false,
            phase: "teamSelection",
            leaderId: Object.keys(roomData.players)[roomData.leaderIndex],
          });
        }
      }
    }
  });

  // Votación de misión
  socket.on("voteMission", ({ room, playerId, vote }) => {
    const roomData = rooms[room];
    if (!roomData) return;

    if (
      !roomData.missionVotes.find((v) => v.playerId === playerId) &&
      roomData.team.includes(playerId)
    ) {
      roomData.missionVotes.push({ playerId, vote });
      io.to(room).emit("updateMissionVotes", roomData.missionVotes);

      // Cuando todos votan en misión
      if (roomData.missionVotes.length === roomData.team.length) {
        const fails = roomData.missionVotes.filter(
          (v) => v.vote === "Fracaso"
        ).length;
        const success = fails === 0;

        roomData.results.push({ round: roomData.results.length + 1, success });
        if (success) roomData.goodWins++;
        else roomData.evilWins++;

        const gameOver = roomData.goodWins >= 3 || roomData.evilWins >= 3;
        roomData.gameOver = gameOver;

        io.to(room).emit("missionResult", {
          results: roomData.results,
          goodWins: roomData.goodWins,
          evilWins: roomData.evilWins,
          gameOver,
        });

        if (!gameOver) {
          roomData.phase = "teamSelection";
          roomData.leaderIndex =
            (roomData.leaderIndex + 1) % Object.keys(roomData.players).length;
          roomData.team = [];
          roomData.votes = [];
          roomData.missionVotes = [];
          io.to(room).emit("nextRound", {
            phase: "teamSelection",
            leaderId: Object.keys(roomData.players)[roomData.leaderIndex],
          });
        }
      }
    }
  });

  // Desconexión
  socket.on("disconnect", () => {
    for (const room in rooms) {
      if (rooms[room].players[socket.id]) {
        delete rooms[room].players[socket.id];
        io.to(room).emit("updatePlayers", Object.values(rooms[room].players));
        console.log(`Jugador ${socket.id} desconectado de sala ${room}`);
      }
    }
  });
});

// Iniciar servidor
io.listen(PORT);
console.log(`Servidor Socket.io corriendo en puerto ${PORT}`);
