// server.js
const io = require("socket.io")(process.env.PORT || 3001, {
  cors: {
    origin: "*", // permite cualquier dominio
    methods: ["GET", "POST"],
  },
});

const cors = require("cors");

const rooms = {};

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);
  socket.on("joinRoom", ({ name, room }) => {
    if (!rooms[room])
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

    rooms[room].players[socket.id] = { name, id: socket.id };
    socket.join(room);
    io.to(room).emit("updatePlayers", Object.values(rooms[room].players));
  });

  socket.on("startGame", ({ room }) => {
    const roomData = rooms[room];
    const playerIds = Object.keys(roomData.players);
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

  socket.on("selectTeam", ({ room, team }) => {
    const roomData = rooms[room];
    if (roomData.phase !== "teamSelection") return;

    roomData.team = team;
    roomData.phase = "teamVote";
    roomData.votes = [];
    io.to(room).emit("teamSelected", { team, phase: "teamVote" });
  });

  socket.on("voteTeam", ({ room, playerId, vote }) => {
    const roomData = rooms[room];
    if (!roomData.votes.find((v) => v.playerId === playerId)) {
      roomData.votes.push({ playerId, vote });
      io.to(room).emit("updateTeamVotes", roomData.votes);

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

  socket.on("voteMission", ({ room, playerId, vote }) => {
    const roomData = rooms[room];
    if (
      !roomData.missionVotes.find((v) => v.playerId === playerId) &&
      roomData.team.includes(playerId)
    ) {
      roomData.missionVotes.push({ playerId, vote });
      io.to(room).emit("updateMissionVotes", roomData.missionVotes);

      if (roomData.missionVotes.length === roomData.team.length) {
        const fails = roomData.missionVotes.filter(
          (v) => v.vote === "Fracaso"
        ).length;
        const success = fails === 0;

        roomData.results.push({ round: roomData.results.length + 1, success });
        if (success) roomData.goodWins++;
        else roomData.evilWins++;

        if (roomData.goodWins >= 3 || roomData.evilWins >= 3)
          roomData.gameOver = true;

        io.to(room).emit("missionResult", {
          success,
          results: roomData.results,
          goodWins: roomData.goodWins,
          evilWins: roomData.evilWins,
          gameOver: roomData.gameOver,
        });

        if (!roomData.gameOver) {
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

  socket.on("disconnect", () => {
    for (const room in rooms) {
      if (rooms[room].players[socket.id]) {
        delete rooms[room].players[socket.id];
        io.to(room).emit("updatePlayers", Object.values(rooms[room].players));
      }
    }
  });
});
