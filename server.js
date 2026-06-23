const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const WORD_LIST = [
  'apple', 'guitar', 'elephant', 'coffee', 'mountain', 'bicycle',
  'umbrella', 'diamond', 'volcano', 'library', 'submarine', 'rainbow',
  'cactus', 'penguin', 'lighthouse', 'astronaut', 'tornado', 'jellyfish',
  'lantern', 'compass', 'hammock', 'parachute', 'telescope', 'waterfall'
];

// rooms[code] = { host, players: [{id, name, eliminated}], started, word, impostorIds, impostorCount, votingActive, votes, guessedIds, gameOver }
const rooms = {};

function maxImpostors(playerCount) {
  return Math.max(1, Math.floor(playerCount / 2) - 1) || 1;
}

// users[usernameLowercase] = { salt, hash, displayName }
const users = {};

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makeCode() {
  let code;
  do { code = String(Math.floor(10000 + Math.random() * 90000)); }
  while (rooms[code]);
  return code;
}

io.on('connection', (socket) => {

  socket.on('signup', ({ username, password }) => {
    username = (username || '').trim();
    password = password || '';
    if (!username || !password) return socket.emit('signup_error', 'Username and password required.');
    if (users[username]) return socket.emit('signup_error', 'Username already taken.');
    const salt = crypto.randomBytes(16).toString('hex');
    users[username] = { salt, hash: hashPassword(password, salt) };
    socket.emit('signup_success', { username });
  });

  socket.on('login', ({ username, password }) => {
    username = (username || '').trim();
    password = password || '';
    const user = users[username];
    if (!user || hashPassword(password, user.salt) !== user.hash) {
      return socket.emit('login_error', 'Invalid username or password.');
    }
    socket.emit('login_success', { username });
  });

  socket.on('create_room', ({ name }) => {
    const code = makeCode();
    rooms[code] = { host: socket.id, players: [{ id: socket.id, name }], started: false, word: null, impostorIds: [], impostorCount: 1 };
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;
    socket.emit('room_created', { code });
    io.to(code).emit('lobby_update', lobbyState(code));
  });

  socket.on('join_room', ({ name, code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found.');
    if (room.started) return socket.emit('error', 'Game already started.');
    if (room.players.find(p => p.name === name)) return socket.emit('error', 'Name already taken in this room.');
    room.players.push({ id: socket.id, name });
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;
    socket.emit('room_joined', { code });
    io.to(code).emit('lobby_update', lobbyState(code));
  });

  socket.on('set_impostor_count', ({ count }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.host !== socket.id || room.started) return;
    const max = maxImpostors(room.players.length);
    count = Math.min(max, Math.max(1, Math.floor(count) || 1));
    room.impostorCount = count;
    io.to(code).emit('lobby_update', lobbyState(code));
  });

  socket.on('start_game', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 3) return socket.emit('error', 'Need at least 3 players to start.');
    room.started = true;
    room.word = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];

    const count = Math.min(room.impostorCount || 1, maxImpostors(room.players.length));
    const shuffled = [...room.players].sort(() => Math.random() - 0.5);
    room.impostorIds = shuffled.slice(0, count).map(p => p.id);

    room.players.forEach(p => { p.eliminated = false; });
    room.votingActive = false;
    room.votes = {};
    room.guessedIds = [];
    room.gameOver = false;

    room.players.forEach(p => {
      const isImpostor = room.impostorIds.includes(p.id);
      io.to(p.id).emit('game_started', {
        word: isImpostor ? null : room.word,
        isImpostor,
        fellowImpostors: isImpostor ? room.impostorIds.filter(id => id !== p.id).map(id => room.players.find(pl => pl.id === id)?.name) : []
      });
    });
  });

  socket.on('call_vote', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.started || room.gameOver || room.votingActive) return;
    const caller = room.players.find(p => p.id === socket.id);
    if (!caller || caller.eliminated) return;
    room.votingActive = true;
    room.votes = {};
    const alive = room.players.filter(p => !p.eliminated);
    io.to(code).emit('voting_started', { players: alive.map(p => ({ id: p.id, name: p.name })) });
  });

  socket.on('cast_vote', ({ target }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.votingActive) return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || voter.eliminated || room.votes[socket.id]) return;
    room.votes[socket.id] = target;

    const alive = room.players.filter(p => !p.eliminated);
    if (Object.keys(room.votes).length < alive.length) return;

    // Tally votes
    const tally = {};
    Object.values(room.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
    let winner = 'skip';
    let topCount = tally['skip'] || 0;
    let tied = false;
    for (const [t, count] of Object.entries(tally)) {
      if (t === 'skip') continue;
      if (count > topCount) { winner = t; topCount = count; tied = false; }
      else if (count === topCount) { tied = true; }
    }

    room.votingActive = false;

    if (winner === 'skip' || tied) {
      io.to(code).emit('vote_result', { skipped: true });
      return;
    }

    const ejected = room.players.find(p => p.id === winner);
    ejected.eliminated = true;
    const wasImpostor = room.impostorIds.includes(ejected.id);
    io.to(code).emit('vote_result', { skipped: false, ejectedName: ejected.name, wasImpostor });

    const aliveImpostorsLeft = room.impostorIds.filter(id => !room.players.find(p => p.id === id).eliminated).length;
    if (aliveImpostorsLeft === 0) {
      room.gameOver = true;
      io.to(code).emit('game_over', { winner: 'civilians', reason: 'All impostors were voted out.' });
      return;
    }

    const aliveCiviliansLeft = room.players.filter(p => !p.eliminated && !room.impostorIds.includes(p.id)).length;
    if (aliveCiviliansLeft === 0) {
      room.gameOver = true;
      io.to(code).emit('game_over', { winner: 'impostor', reason: 'All civilians have been eliminated.' });
    }
  });

  socket.on('submit_guess', ({ guess }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.started || room.gameOver) return;
    if (!room.impostorIds.includes(socket.id) || room.guessedIds.includes(socket.id)) return;
    room.guessedIds.push(socket.id);
    const correct = (guess || '').trim().toLowerCase() === room.word.toLowerCase();
    socket.emit('guess_result', { correct });
    if (correct) {
      room.gameOver = true;
      io.to(code).emit('game_over', { winner: 'impostor', reason: 'An impostor guessed the word.' });
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[code];
      return;
    }
    if (room.host === socket.id) room.host = room.players[0].id;
    if (!room.started) io.to(code).emit('lobby_update', lobbyState(code));
    else io.to(code).emit('player_left', { name: socket.data.name });
  });
});

function lobbyState(code) {
  const room = rooms[code];
  const max = maxImpostors(room.players.length);
  if (room.impostorCount > max) room.impostorCount = max;
  return {
    players: room.players.map(p => p.name),
    host: room.players.find(p => p.id === room.host)?.name,
    impostorCount: room.impostorCount,
    maxImpostors: max
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Impostor server running on port ${PORT}`));
