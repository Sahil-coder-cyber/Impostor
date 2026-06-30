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

const WORD_HINTS = {
  apple:      ['fruit','red','tree','juice','sweet','pie','orchard','seed'],
  guitar:     ['music','strings','instrument','strum','band','rock','tune','chord'],
  elephant:   ['animal','trunk','large','grey','tusk','safari','heavy','memory'],
  coffee:     ['drink','hot','beans','caffeine','morning','mug','bitter','espresso'],
  mountain:   ['tall','peak','climb','snow','rocky','hiking','altitude','summit'],
  bicycle:    ['wheels','pedal','ride','chain','bike','cycle','transport','handlebar'],
  umbrella:   ['rain','shelter','cover','weather','open','handle','fold','protection'],
  diamond:    ['gem','sparkle','shiny','ring','hard','carbon','precious','clear'],
  volcano:    ['lava','erupt','fire','molten','rock','island','hot','magma'],
  library:    ['books','read','quiet','shelves','study','knowledge','borrow','catalog'],
  submarine:  ['underwater','vessel','ocean','deep','torpedo','dive','naval','crew'],
  rainbow:    ['colors','arch','rain','sky','spectrum','light','prism','bright'],
  cactus:     ['desert','spiky','dry','plant','sand','green','water','thorns'],
  penguin:    ['bird','cold','ice','waddle','flippers','tuxedo','arctic','swim'],
  lighthouse: ['beacon','coast','light','tower','sailor','warning','sea','shore'],
  astronaut:  ['space','rocket','suit','moon','orbit','nasa','float','stars'],
  tornado:    ['wind','spin','storm','funnel','weather','twist','destroy','fast'],
  jellyfish:  ['ocean','sting','tentacles','transparent','float','sea','gel','swim'],
  lantern:    ['light','glow','flame','dark','carry','candle','warm','night'],
  compass:    ['direction','north','navigate','needle','map','point','travel','magnetic'],
  hammock:    ['swing','relax','rest','hang','outdoor','nap','trees','rope'],
  parachute:  ['fall','sky','jump','float','silk','slow','plane','air'],
  telescope:  ['stars','see','far','lens','sky','zoom','observe','moon'],
  waterfall:  ['water','fall','crash','river','mist','cliff','nature','splash']
};

const BOT_NAMES = ['Aria','Blake','Casey','Dana','Eli','Fern','Gray','Haze','Indra','Juno','Kael','Luma'];

const AVATAR_COLORS = ['#c51111','#132ed1','#117f2d','#ed54ba','#ef7d0d','#f5f557','#3f474e','#d6e0f0','#6b2fbb','#71491e','#38fedc','#50ef39'];
function randomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

// rooms[code] = { host, players, started, word, impostorIds, impostorCount, votingActive, votes, guessAttempts, gameOver, clueOrder, clueIndex, clues, cluePhaseActive, clueTimeout, waitingForNextRound, isSolo, difficulty }
const rooms = {};

// stats[name] = { gamesPlayed, wins, impostorGames, impostorWins, civilianGames, civilianWins }
const stats = {};

function emptyStats() {
  return { gamesPlayed: 0, wins: 0, impostorGames: 0, impostorWins: 0, civilianGames: 0, civilianWins: 0 };
}

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
    .filter(([, room]) => !room.gameOver && !room.isSolo)
    .map(([code, room]) => ({
      code,
      playerCount: room.players.filter(p => !p.isBot).length,
      started: room.started
    }));
}

function broadcastRoomsList() {
  io.to('lobby_browser').emit('rooms_list', publicRoomsList());
}

// ---- Stats / game end ----

function recordGameResult(room, winner) {
  room.players.forEach(p => {
    if (p.isBot) return;
    if (!stats[p.name]) stats[p.name] = emptyStats();
    const s = stats[p.name];
    const wasImpostor = room.impostorIds.includes(p.id);
    s.gamesPlayed++;
    if (wasImpostor) {
      s.impostorGames++;
      if (winner === 'impostor') { s.wins++; s.impostorWins++; }
    } else {
      s.civilianGames++;
      if (winner === 'civilians') { s.wins++; s.civilianWins++; }
    }
    io.to(p.id).emit('stats_update', s);
  });
}

function endGame(code, winner, reason) {
  const room = rooms[code];
  if (!room) return;
  room.gameOver = true;
  io.to(code).emit('game_over', { winner, reason });
  recordGameResult(room, winner);
  broadcastRoomsList();
}

// ---- Bot logic ----

function getBotClue(botId, room) {
  const used = new Set(room.clues.map(c => (c.word || '').toLowerCase()).filter(Boolean));
  const pick = (arr) => {
    const avail = arr.filter(w => !used.has(w.toLowerCase()));
    const pool = avail.length ? avail : arr;
    return pool[Math.floor(Math.random() * pool.length)];
  };

  const hints = (WORD_HINTS[room.word] || []).slice();
  const diff = room.difficulty || 'medium';
  const isImpostor = room.impostorIds.includes(botId);

  if (isImpostor) {
    if (diff !== 'easy') {
      const randWord = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
      const randHints = WORD_HINTS[randWord] || ['interesting'];
      return pick(randHints);
    }
    const generic = ['thing','stuff','item','object','common','typical','nice','basic'];
    return pick(generic);
  }

  if (!hints.length) return 'related';
  if (diff === 'hard')   return pick(hints.slice(0, Math.min(3, hints.length)));
  if (diff === 'medium') return pick(hints);
  if (Math.random() < 0.45) {
    const generic = ['nice','special','interesting','important','valuable','unique'];
    return pick(generic);
  }
  return pick([hints[hints.length - 1]]);
}

function getBotVoteTarget(botId, room) {
  const diff = room.difficulty || 'medium';
  const alive = room.players.filter(p => !p.eliminated && p.id !== botId);
  const isImpostor = room.impostorIds.includes(botId);

  if (isImpostor) {
    const civilians = alive.filter(p => !room.impostorIds.includes(p.id));
    return civilians.length ? civilians[Math.floor(Math.random() * civilians.length)].id : 'skip';
  }

  const accuracy = diff === 'hard' ? 0.80 : diff === 'medium' ? 0.55 : 0.30;
  if (Math.random() < accuracy) {
    const hints = (WORD_HINTS[room.word] || []).map(h => h.toLowerCase());
    const suspects = room.clues.filter(c =>
      alive.find(p => p.id === c.id) && !hints.includes((c.word || '').toLowerCase())
    );
    if (suspects.length) {
      return suspects[Math.floor(Math.random() * suspects.length)].id;
    }
  }
  return alive.length ? alive[Math.floor(Math.random() * alive.length)].id : 'skip';
}

// ---- Vote finalization ----

function checkVoteComplete(code) {
  const room = rooms[code];
  if (!room || !room.votingActive) return;
  const alive = room.players.filter(p => !p.eliminated);
  if (Object.keys(room.votes).length < alive.length) return;
  finalizeVotes(code);
}

function finalizeVotes(code) {
  const room = rooms[code];
  if (!room) return;
  room.votingActive = false;

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

  const impostorsRemainingNow = () => room.impostorIds.filter(id => {
    const p = room.players.find(pl => pl.id === id);
    return p && !p.eliminated;
  }).length;

  if (winner === 'skip' || tied) {
    room.waitingForNextRound = true;
    io.to(code).emit('vote_result', { skipped: true, impostorsRemaining: impostorsRemainingNow() });
    return;
  }

  const ejected = room.players.find(p => p.id === winner);
  ejected.eliminated = true;
  const wasImpostor = room.impostorIds.includes(ejected.id);
  const remaining = impostorsRemainingNow();
  io.to(code).emit('vote_result', {
    skipped: false, ejectedName: ejected.name, ejectedColor: ejected.color, wasImpostor, impostorsRemaining: remaining
  });

  if (remaining === 0) {
    endGame(code, 'civilians', 'All impostors were voted out.');
    return;
  }

  const aliveCiviliansLeft = room.players.filter(p => !p.eliminated && !room.impostorIds.includes(p.id)).length;
  if (aliveCiviliansLeft === 0) {
    endGame(code, 'impostor', 'All civilians have been eliminated.');
    return;
  }

  room.waitingForNextRound = true;
}

// ---- Clue phase ----

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

  io.to(code).emit('clue_turn', { playerId, name: player.name, seconds: player.isBot ? 4 : CLUE_SECONDS });
  clearTimeout(room.clueTimeout);

  if (player.isBot) {
    const delay = 2000 + Math.random() * 2000;
    room.clueTimeout = setTimeout(() => {
      if (!room.cluePhaseActive || room.clueOrder[room.clueIndex] !== playerId) return;
      const word = getBotClue(playerId, room);
      room.clues.push({ id: playerId, name: player.name, word });
      io.to(code).emit('clue_submitted', { name: player.name, word });
      room.clueIndex++;
      advanceClueTurn(code);
    }, delay);
  } else {
    room.clueTimeout = setTimeout(() => {
      room.clues.push({ id: playerId, name: player.name, word: null });
      io.to(code).emit('clue_submitted', { name: player.name, word: null });
      room.clueIndex++;
      advanceClueTurn(code);
    }, CLUE_SECONDS * 1000);
  }
}

// ---- Socket handlers ----

io.on('connection', (socket) => {

  socket.on('join_lobby_browser', () => {
    socket.join('lobby_browser');
    socket.emit('rooms_list', publicRoomsList());
  });

  socket.on('get_stats', ({ name }) => {
    socket.emit('stats_update', stats[name] || emptyStats());
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

  socket.on('create_room', ({ name, color }) => {
    const code = makeCode();
    rooms[code] = {
      host: socket.id,
      players: [{ id: socket.id, name, color: color || randomColor() }],
      started: false, word: null, impostorIds: [], impostorCount: 1
    };
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;
    socket.emit('room_created', { code });
    io.to(code).emit('lobby_update', lobbyState(code));
    broadcastRoomsList();
  });

  socket.on('join_room', ({ name, code, color }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found.');
    if (room.started) return socket.emit('error', 'Game already started.');
    if (room.players.find(p => p.name === name)) return socket.emit('error', 'Name already taken in this room.');
    room.players.push({ id: socket.id, name, color: color || randomColor() });
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
    room.guessAttempts = {};
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

  socket.on('play_again', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.gameOver) return;
    if (!room.isSolo && room.host !== socket.id) return;

    room.word = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
    const count = Math.min(room.impostorCount || 1, maxImpostors(room.players.length));
    const shuffled = [...room.players].sort(() => Math.random() - 0.5);
    room.impostorIds = shuffled.slice(0, count).map(p => p.id);

    room.players.forEach(p => { p.eliminated = false; });
    room.votingActive = false;
    room.votes = {};
    room.guessAttempts = {};
    room.gameOver = false;
    room.waitingForNextRound = false;

    room.players.forEach(p => {
      if (p.isBot) return;
      const isImpostor = room.impostorIds.includes(p.id);
      io.to(p.id).emit('game_started', {
        word: isImpostor ? null : room.word,
        isImpostor,
        fellowImpostors: isImpostor ? room.impostorIds.filter(id => id !== p.id).map(id => room.players.find(pl => pl.id === id)?.name) : [],
        players: room.players.map(pl => ({ id: pl.id, name: pl.name }))
      });
    });

    startCluePhase(code);
    if (!room.isSolo) broadcastRoomsList();
  });

  // ---- Single player ----

  socket.on('start_solo', ({ name, color, difficulty, botCount, impostorCount }) => {
    difficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
    botCount = Math.min(9, Math.max(2, Math.floor(botCount) || 4));
    const playerName = (name || 'You').trim().slice(0, 16) || 'You';

    const shuffledBotNames = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, botCount);
    const players = [{ id: socket.id, name: playerName, color: color || randomColor(), isBot: false }];
    shuffledBotNames.forEach((bName, i) => {
      players.push({ id: `bot_${i}_${Date.now()}`, name: bName, color: randomColor(), isBot: true, eliminated: false });
    });

    const maxImp = maxImpostors(players.length);
    const impCount = Math.min(Math.max(1, Math.floor(impostorCount) || 1), maxImp);
    const word = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];

    const shuffledForImpostors = [...players].sort(() => Math.random() - 0.5);
    const impostorIds = shuffledForImpostors.slice(0, impCount).map(p => p.id);

    const code = makeCode();
    rooms[code] = {
      host: socket.id, players, started: true, gameOver: false,
      word, impostorIds, impostorCount: impCount,
      votingActive: false, votes: {}, guessAttempts: {},
      clueOrder: [], clueIndex: 0, clues: [], cluePhaseActive: false,
      waitingForNextRound: false, isSolo: true, difficulty
    };

    socket.join(code);
    socket.data.room = code;
    socket.data.name = playerName;

    const isImpostor = impostorIds.includes(socket.id);
    const fellowImpostors = isImpostor
      ? impostorIds.filter(id => id !== socket.id).map(id => players.find(p => p.id === id)?.name).filter(Boolean)
      : [];

    socket.emit('game_started', {
      word: isImpostor ? null : word,
      isImpostor,
      fellowImpostors,
      players: players.map(p => ({ id: p.id, name: p.name }))
    });

    startCluePhase(code);
  });

  // ---- Clue submission ----

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

  // ---- Voting ----

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

    if (room.isSolo) {
      alive.filter(p => p.isBot).forEach(bot => {
        const delay = 1500 + Math.random() * 2500;
        setTimeout(() => {
          if (!room.votingActive || room.votes[bot.id]) return;
          room.votes[bot.id] = getBotVoteTarget(bot.id, room);
          checkVoteComplete(code);
        }, delay);
      });
    }
  });

  socket.on('cast_vote', ({ target }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.votingActive) return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || voter.eliminated || room.votes[socket.id]) return;
    room.votes[socket.id] = target;
    checkVoteComplete(code);
  });

  socket.on('start_next_round', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.waitingForNextRound) return;
    room.waitingForNextRound = false;
    startCluePhase(code);
  });

  const MAX_GUESSES = 3;

  socket.on('submit_guess', ({ guess }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.started || room.gameOver) return;
    if (!room.impostorIds.includes(socket.id)) return;
    room.guessAttempts = room.guessAttempts || {};
    const attempts = room.guessAttempts[socket.id] || 0;
    if (attempts >= MAX_GUESSES) return;
    room.guessAttempts[socket.id] = attempts + 1;
    const attemptsLeft = MAX_GUESSES - room.guessAttempts[socket.id];
    const correct = (guess || '').trim().toLowerCase() === room.word.toLowerCase();
    socket.emit('guess_result', { correct, attemptsLeft });
    if (correct) {
      endGame(code, 'impostor', 'An impostor guessed the word.');
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

  socket.on('leave_room', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (room.isSolo) {
      clearTimeout(room.clueTimeout);
      delete rooms[code];
      socket.leave(code);
      delete socket.data.room;
      return;
    }

    const wasCurrentClueTurn = room.cluePhaseActive && room.clueOrder[room.clueIndex] === socket.id;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(code);
    delete socket.data.room;

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

  socket.on('disconnect', () => {
    if (socket.data.spectating) return;
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (room.isSolo) {
      clearTimeout(room.clueTimeout);
      delete rooms[code];
      return;
    }

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
    players: room.players.map(p => ({ name: p.name, color: p.color, isHost: p.id === room.host })),
    host: room.players.find(p => p.id === room.host)?.name,
    impostorCount: room.impostorCount,
    maxImpostors: max
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Impostor server running on port ${PORT}`));
