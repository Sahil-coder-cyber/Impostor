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

// rooms[code] = { host, players: [{id, name, eliminated}], started, word, impostorIds, impostorCount, votingActive, votes, guessedIds, gameOver, clueOrder, clueIndex, clues, cluePhaseActive, clueTimeout, waitingForNextRound }
const rooms = {};

function maxImpostors(playerCount) {
  return Math.max(1, Math.floor(playerCount / 2) - 1) || 1;
}

const BANNED_WORDS = [
  'fuck', 'shit', 'bitch', 'asshole', 'ass', 'bastard', 'cunt', 'dick',
  'piss', 'slut', 'whore', 'fag', 'faggot', 'nigger', 'nigga', 'retard'
];
const BANNED_REGEX = new RegExp(`\\b(${BANNED_WORDS.join('|')})\\b`, 'i');

function containsProfanity(text) {
  return BANNED_REGEX.test(text);
}

// users[username] = { salt, hash }
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

function publicRoomsList() {
  return Object.entries(rooms)
    .filter(([, room]) => !room.gameOver)
    .map(([code, room]) => ({
      code,
      playerCount: room.players.length,
      started: room.started
    }));
}

function broadcastRoomsList() {
  io.to('lobby_browser').emit('rooms_list', publicRoomsList());
}

const CLUE_SECONDS = 30;

function startCluePhase(code) {
  const room = rooms[code];
  const alive = room.players.filter(p => !p.eliminated);
  const order = [...alive].sort(() => Math.random() - 0.5).map(p => p.id);

  if (order.length && room.impostorIds.includes(order[0])) {
    const swapIndex = order.findIndex(id => !room.impostorIds.includes(id));
    if (swapIndex > 0) [order[0], order[swapIndex]] = [order[swapIndex], order[0]];
  }

  room.clueOrder = order;
  room.clueIndex = 0;
  room.clues = [];
  room.cluePhaseActive = true;
  advanceClueTurn(code);
}

function advanceClueTurn(code) {
  const room = rooms[code];
  if (!room || !room.cluePhaseActive) return;

  if (room.clueIndex >= room.clueOrder.length) {
    room.cluePhaseActive = false;
    io.to(code).emit('clue_phase_complete');
    return;
  }

  const playerId = room.clueOrder[room.clueIndex];
  const player = room.players.find(p => p.id === playerId);
  if (!player || player.eliminated) {
    room.clueIndex++;
    return advanceClueTurn(code);
  }

  io.to(code).emit('clue_turn', { playerId, name: player.name, seconds: CLUE_SECONDS });
  clearTimeout(room.clueTimeout);
  room.clueTimeout = setTimeout(() => {
    room.clues.push({ id: playerId, name: player.name, word: null });
    io.to(code).emit('clue_submitted', { name: player.name, word: null });
    room.clueIndex++;
    advanceClueTurn(code);
  }, CLUE_SECONDS * 1000);
}

io.on('connection', (socket) => {

  socket.on('join_lobby_browser', () => {
    socket.join('lobby_browser');
    socket.emit('rooms_list', publicRoomsList());
  });

  socket.on('spectate_room', ({ code }) => {
    const room = rooms[code];
    if (!room || !room.started || room.gameOver) {
      return socket.emit('spectate_error', 'This game is not available to spectate.');
    }
    socket.join(code);
    socket.data.spectating = code;
    socket.emit('spectate_started', {
      word: room.word,
      impostors: room.impostorIds.map(id => room.players.find(p => p.id === id)?.name).filter(Boolean),
      clues: room.clues || [],
      players: room.players.filter(p => !p.eliminated).map(p => p.name)
    });
  });

  socket.on('leave_spectate', () => {
    const code = socket.data.spectating;
    if (!code) return;
    socket.leave(code);
    delete socket.data.spectating;
  });

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
    broadcastRoomsList();
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
    broadcastRoomsList();
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
        fellowImpostors: isImpostor ? room.impostorIds.filter(id => id !== p.id).map(id => room.players.find(pl => pl.id === id)?.name) : [],
        players: room.players.map(pl => ({ id: pl.id, name: pl.name }))
      });
    });

    startCluePhase(code);
    broadcastRoomsList();
  });

  socket.on('submit_clue', ({ word }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.cluePhaseActive) return;
    const currentId = room.clueOrder[room.clueIndex];
    if (socket.id !== currentId) return;
    clearTimeout(room.clueTimeout);
    word = (word || '').trim().slice(0, 30);
    if (containsProfanity(word)) word = '';
    const player = room.players.find(p => p.id === socket.id);
    room.clues.push({ id: socket.id, name: player.name, word: word || null });
    io.to(code).emit('clue_submitted', { name: player.name, word: word || null });
    room.clueIndex++;
    advanceClueTurn(code);
  });

  socket.on('call_vote', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.started || room.gameOver || room.votingActive || room.cluePhaseActive) return;
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
      room.waitingForNextRound = true;
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
      broadcastRoomsList();
      return;
    }

    const aliveCiviliansLeft = room.players.filter(p => !p.eliminated && !room.impostorIds.includes(p.id)).length;
    if (aliveCiviliansLeft === 0) {
      room.gameOver = true;
      io.to(code).emit('game_over', { winner: 'impostor', reason: 'All civilians have been eliminated.' });
      broadcastRoomsList();
      return;
    }

    room.waitingForNextRound = true;
  });

  socket.on('start_next_round', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.waitingForNextRound) return;
    room.waitingForNextRound = false;
    startCluePhase(code);
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
      broadcastRoomsList();
    }
  });

  socket.on('chat_message', ({ scope, target, text }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.started) return;
    text = (text || '').trim().slice(0, 200);
    if (!text) return;
    const sender = room.players.find(p => p.id === socket.id);
    if (!sender) return;

    if (containsProfanity(text)) {
      socket.emit('chat_blocked', { reason: 'Your message contains inappropriate language and was not sent.' });
      return;
    }

    if (scope === 'all') {
      io.to(code).emit('chat_message', { scope: 'all', from: sender.name, fromId: socket.id, text });
    } else if (scope === 'impostor') {
      if (!room.impostorIds.includes(socket.id) || room.impostorIds.length < 2) return;
      room.impostorIds.forEach(id => io.to(id).emit('chat_message', { scope: 'impostor', from: sender.name, fromId: socket.id, text }));
    } else if (scope === 'dm') {
      const targetPlayer = room.players.find(p => p.id === target);
      if (!targetPlayer || target === socket.id) return;
      io.to(socket.id).emit('chat_message', { scope: 'dm', from: sender.name, fromId: socket.id, withId: target, text });
      io.to(target).emit('chat_message', { scope: 'dm', from: sender.name, fromId: socket.id, withId: socket.id, text });
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.spectating) return;
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const wasCurrentClueTurn = room.cluePhaseActive && room.clueOrder[room.clueIndex] === socket.id;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      clearTimeout(room.clueTimeout);
      delete rooms[code];
      broadcastRoomsList();
      return;
    }
    if (room.host === socket.id) room.host = room.players[0].id;
    if (!room.started) io.to(code).emit('lobby_update', lobbyState(code));
    else io.to(code).emit('player_left', { name: socket.data.name });
    if (wasCurrentClueTurn) {
      clearTimeout(room.clueTimeout);
      room.clueIndex++;
      advanceClueTurn(code);
    }
    broadcastRoomsList();
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