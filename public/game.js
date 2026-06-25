const socket = io();
let mode = 'start'; // 'start' or 'join'
let myName = '';

// Guest name, CrazyGames-style: "Guest" + random digits, persisted per browser
function getGuestName() {
  let guest = localStorage.getItem('guestName');
  if (!guest) {
    guest = 'Guest' + Math.floor(1000000 + Math.random() * 9000000);
    localStorage.setItem('guestName', guest);
  }
  return guest;
}
document.getElementById('guest-name').textContent = getGuestName();
socket.emit('join_lobby_browser');

document.getElementById('qr-code').src =
  `https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${encodeURIComponent(window.location.origin)}`;

function showScreen(id, context) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById('game-browser').style.display = id === 'screen-landing' ? 'flex' : 'none';

  if (id === 'screen-name') {
    mode = context;
    document.getElementById('name-heading').textContent = context === 'start' ? 'Start a Game' : 'Join a Game';
    const codeInput = document.getElementById('input-code');
    codeInput.style.display = context === 'join' ? 'block' : 'none';
    document.getElementById('input-name').value = getGuestName();
    codeInput.value = '';
    document.getElementById('err-name').textContent = '';
  }

  if (id === 'screen-signup') {
    document.getElementById('input-signup-username').value = '';
    document.getElementById('input-signup-password').value = '';
    document.getElementById('err-signup').textContent = '';
  }

  if (id === 'screen-login') {
    document.getElementById('input-login-username').value = '';
    document.getElementById('input-login-password').value = '';
    document.getElementById('err-login').textContent = '';
  }
}

function doSignup() {
  const username = document.getElementById('input-signup-username').value.trim();
  const password = document.getElementById('input-signup-password').value;
  const err = document.getElementById('err-signup');
  if (!username || !password) { err.textContent = 'Enter a username and password.'; return; }
  err.textContent = '';
  socket.emit('signup', { username, password });
}

function doLogin() {
  const username = document.getElementById('input-login-username').value.trim();
  const password = document.getElementById('input-login-password').value;
  const err = document.getElementById('err-login');
  if (!username || !password) { err.textContent = 'Enter a username and password.'; return; }
  err.textContent = '';
  socket.emit('login', { username, password });
}

function nameGo() {
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-code').value.trim();
  const err = document.getElementById('err-name');

  if (!name) { err.textContent = 'Enter your name.'; return; }
  if (mode === 'join' && !/^\d{5}$/.test(code)) { err.textContent = 'Enter a valid 5-digit code.'; return; }

  myName = name;
  err.textContent = '';

  if (mode === 'start') {
    socket.emit('create_room', { name });
  } else {
    socket.emit('join_room', { name, code });
  }
}

function startGame() {
  socket.emit('start_game');
}

// Enter key support
document.getElementById('input-name').addEventListener('keydown', e => { if (e.key === 'Enter') nameGo(); });
document.getElementById('input-code').addEventListener('keydown', e => { if (e.key === 'Enter') nameGo(); });
document.getElementById('input-signup-username').addEventListener('keydown', e => { if (e.key === 'Enter') doSignup(); });
document.getElementById('input-signup-password').addEventListener('keydown', e => { if (e.key === 'Enter') doSignup(); });
document.getElementById('input-login-username').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('input-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('input-guess').addEventListener('keydown', e => { if (e.key === 'Enter') submitGuess(); });

// Socket events

socket.on('room_created', ({ code }) => {
  document.getElementById('lobby-code').textContent = code;
  showScreen('screen-lobby');
  document.getElementById('btn-start').style.display = 'block';
  document.getElementById('lobby-host-note').textContent = 'You are the host. Share the code above.';
  document.getElementById('qr-corner').style.display = 'flex';
});

socket.on('room_joined', ({ code }) => {
  document.getElementById('lobby-code').textContent = code;
  showScreen('screen-lobby');
  document.getElementById('btn-start').style.display = 'none';
  document.getElementById('lobby-host-note').textContent = 'Waiting for the host to start...';
  document.getElementById('qr-corner').style.display = 'flex';
});

let currentMaxImpostors = 1;

socket.on('lobby_update', ({ players, host, impostorCount, maxImpostors }) => {
  const ul = document.getElementById('lobby-players');
  ul.innerHTML = '';
  players.forEach(name => {
    const li = document.createElement('li');
    if (name === host) li.innerHTML = `<span class="crown">&#9733;</span> ${name} <em style="color:#aaa;font-size:0.8em">(host)</em>`;
    else li.textContent = name;
    ul.appendChild(li);
  });
  // Update start button visibility (host may change on disconnect)
  const isHost = host === myName;
  document.getElementById('btn-start').style.display = isHost ? 'block' : 'none';
  if (!isHost) document.getElementById('lobby-host-note').textContent = 'Waiting for the host to start...';
  else document.getElementById('lobby-host-note').textContent = 'You are the host. Share the code above.';

  currentMaxImpostors = maxImpostors;
  document.getElementById('impostor-count-value').textContent = impostorCount;
  document.getElementById('impostor-control-host').style.display = isHost ? 'flex' : 'none';
  document.getElementById('impostor-count-readonly').style.display = isHost ? 'none' : 'block';
  document.getElementById('impostor-count-readonly').textContent = `Impostors: ${impostorCount}`;
});

function changeImpostorCount(delta) {
  const current = parseInt(document.getElementById('impostor-count-value').textContent, 10);
  const next = Math.min(currentMaxImpostors, Math.max(1, current + delta));
  socket.emit('set_impostor_count', { count: next });
}

socket.on('game_started', ({ word, isImpostor, fellowImpostors, players }) => {
  showScreen('screen-game');
  const guessArea = document.getElementById('guess-area');
  document.getElementById('input-guess').value = '';
  document.getElementById('guess-status').textContent = '';

  if (isImpostor) {
    document.getElementById('game-role-title').textContent = 'You are the IMPOSTOR';
    document.getElementById('game-word-box').textContent = '???';
    document.getElementById('game-hint').textContent = fellowImpostors && fellowImpostors.length
      ? `You have no word. Your fellow impostor(s): ${fellowImpostors.join(', ')}. Try to guess the word before you get voted out!`
      : 'You have no word. Listen carefully and blend in. Try to guess the word before you get voted out!';
    guessArea.style.display = 'flex';
  } else {
    document.getElementById('game-role-title').textContent = 'You are a CIVILIAN';
    document.getElementById('game-word-box').textContent = word.toUpperCase();
    document.getElementById('game-hint').textContent = 'This is your secret word. Discuss without giving it away — find the impostor!';
    guessArea.style.display = 'none';
  }

  setupChat(players, isImpostor && fellowImpostors && fellowImpostors.length > 0);

  resetClueUI();
});

// ---- Clue round ----

let clueTimerInterval = null;

function resetClueUI() {
  document.getElementById('clue-list').innerHTML = '';
  document.getElementById('clue-turn-label').textContent = '';
  document.getElementById('clue-timer').textContent = '';
  document.getElementById('clue-input-row').style.display = 'none';
  document.getElementById('btn-call-vote').style.display = 'none';
  clearInterval(clueTimerInterval);
}

socket.on('clue_turn', ({ playerId, name, seconds }) => {
  if (isSpectating) {
    document.getElementById('spectate-turn-label').textContent = `${name}'s turn...`;
    clearInterval(clueTimerInterval);
    let timeLeft = seconds;
    document.getElementById('spectate-timer').textContent = timeLeft + 's';
    clueTimerInterval = setInterval(() => {
      timeLeft--;
      document.getElementById('spectate-timer').textContent = Math.max(timeLeft, 0) + 's';
      if (timeLeft <= 0) clearInterval(clueTimerInterval);
    }, 1000);
    return;
  }
  if (document.getElementById('screen-result').classList.contains('active') && !lastVoteWasGameOver) {
    resetClueUI();
    showScreen('screen-game');
  }
  const isMyTurn = playerId === socket.id;
  document.getElementById('clue-turn-label').textContent = isMyTurn
    ? 'Your turn — type a word related to the secret word!'
    : `${name}'s turn...`;
  document.getElementById('clue-input-row').style.display = isMyTurn ? 'flex' : 'none';
  document.getElementById('input-clue').value = '';

  clearInterval(clueTimerInterval);
  let timeLeft = seconds;
  document.getElementById('clue-timer').textContent = timeLeft + 's';
  clueTimerInterval = setInterval(() => {
    timeLeft--;
    document.getElementById('clue-timer').textContent = Math.max(timeLeft, 0) + 's';
    if (timeLeft <= 0) clearInterval(clueTimerInterval);
  }, 1000);
});

function submitClue() {
  const word = document.getElementById('input-clue').value.trim();
  if (!word) return;
  socket.emit('submit_clue', { word });
  document.getElementById('clue-input-row').style.display = 'none';
}

document.getElementById('input-clue').addEventListener('keydown', e => { if (e.key === 'Enter') submitClue(); });

socket.on('clue_submitted', ({ name, word }) => {
  const li = document.createElement('li');
  li.textContent = word ? `${name}: ${word}` : `${name}: (no answer)`;
  document.getElementById(isSpectating ? 'spectate-clue-list' : 'clue-list').appendChild(li);
});

socket.on('clue_phase_complete', () => {
  clearInterval(clueTimerInterval);
  if (isSpectating) {
    document.getElementById('spectate-turn-label').textContent = 'Clue round done — voting may begin.';
    document.getElementById('spectate-timer').textContent = '';
    return;
  }
  document.getElementById('clue-turn-label').textContent = 'Clue round finished — discuss, then call a vote!';
  document.getElementById('clue-timer').textContent = '';
  document.getElementById('clue-input-row').style.display = 'none';
  document.getElementById('btn-call-vote').style.display = 'block';
});

// ---- Chat ----

let chatTab = 'all';
let chatLogs = { all: [] };
let roomPlayers = [];

function setupChat(players, hasImpostorChat) {
  roomPlayers = (players || []).filter(p => p.id !== socket.id);
  chatLogs = { all: [] };
  chatTab = 'all';

  document.getElementById('chat-messages').innerHTML = '';
  document.querySelectorAll('.chat-tab').forEach(b => {
    if (b.dataset.tab !== 'all' && b.dataset.tab !== 'impostor') b.remove();
  });
  document.querySelectorAll('.chat-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'all'));

  const impostorTab = document.getElementById('chat-tab-impostor');
  if (hasImpostorChat) {
    impostorTab.style.display = 'inline-block';
    chatLogs.impostor = [];
  } else {
    impostorTab.style.display = 'none';
  }

  const dmSelect = document.getElementById('dm-target-select');
  dmSelect.innerHTML = '<option value="">Start a private chat...</option>';
  roomPlayers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    dmSelect.appendChild(opt);
  });

  document.getElementById('chat-panel').style.display = 'flex';
}

function hideChat() {
  document.getElementById('chat-panel').style.display = 'none';
}

function toggleChatMinimize() {
  const panel = document.getElementById('chat-panel');
  const btn = panel.querySelector('.chat-minimize-btn');
  const minimized = panel.classList.toggle('minimized');
  btn.innerHTML = minimized ? '&#43;' : '&#8722;';
}

function switchChatTab(tab) {
  chatTab = tab;
  document.querySelectorAll('.chat-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  renderChatMessages();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderChatMessages() {
  const box = document.getElementById('chat-messages');
  box.innerHTML = '';
  (chatLogs[chatTab] || []).forEach(m => {
    const div = document.createElement('div');
    div.className = 'chat-msg' + (m.fromId === socket.id ? ' mine' : '');
    div.innerHTML = `<span class="chat-from">${escapeHtml(m.from)}:</span> ${escapeHtml(m.text)}`;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  let scope = 'all', target;
  if (chatTab === 'impostor') scope = 'impostor';
  else if (chatTab.startsWith('dm:')) { scope = 'dm'; target = chatTab.slice(3); }
  socket.emit('chat_message', { scope, target, text });
  input.value = '';
}

document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });

function openDmFromSelect() {
  const sel = document.getElementById('dm-target-select');
  const id = sel.value;
  if (!id) return;
  sel.value = '';
  openDmTab(id, roomPlayers.find(p => p.id === id)?.name || 'Player');
}

function openDmTab(id, name) {
  const key = 'dm:' + id;
  if (!chatLogs[key]) {
    chatLogs[key] = [];
    const btn = document.createElement('button');
    btn.className = 'chat-tab';
    btn.dataset.tab = key;
    btn.textContent = name;
    btn.onclick = () => switchChatTab(key);
    document.getElementById('chat-tabs').appendChild(btn);
  }
  switchChatTab(key);
}

socket.on('chat_message', (msg) => {
  let key = 'all';
  if (msg.scope === 'impostor') key = 'impostor';
  else if (msg.scope === 'dm') key = 'dm:' + msg.withId;

  if (msg.scope === 'dm' && !chatLogs[key]) {
    const name = roomPlayers.find(p => p.id === msg.withId)?.name || 'Player';
    openDmTab(msg.withId, name);
  }

  if (!chatLogs[key]) chatLogs[key] = [];
  chatLogs[key].push(msg);
  if (chatTab === key) renderChatMessages();
});

socket.on('chat_blocked', ({ reason }) => {
  const err = document.getElementById('chat-error');
  err.textContent = reason;
  setTimeout(() => { err.textContent = ''; }, 3000);
});

function callVote() {
  socket.emit('call_vote');
}

function castVote(target) {
  socket.emit('cast_vote', { target });
  document.getElementById('vote-status').textContent = 'Vote submitted. Waiting for others...';
  document.querySelectorAll('.vote-target, .skip-btn').forEach(btn => btn.disabled = true);
}

function submitGuess() {
  const guess = document.getElementById('input-guess').value.trim();
  if (!guess) return;
  socket.emit('submit_guess', { guess });
}

let lastVoteWasGameOver = false;

socket.on('voting_started', ({ players }) => {
  if (isSpectating) {
    document.getElementById('spectate-turn-label').textContent = 'Voting in progress...';
    document.getElementById('spectate-timer').textContent = '';
    return;
  }
  showScreen('screen-vote');
  document.getElementById('vote-status').textContent = '';
  const ul = document.getElementById('vote-players');
  ul.innerHTML = '';
  players.forEach(p => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'vote-target';
    btn.textContent = p.name;
    btn.onclick = () => castVote(p.id);
    li.appendChild(btn);
    ul.appendChild(li);
  });
});

socket.on('vote_result', ({ skipped, ejectedName, wasImpostor }) => {
  if (isSpectating) {
    if (skipped) {
      document.getElementById('spectate-status').textContent = 'Vote skipped — next clue round starting...';
    } else {
      document.getElementById('spectate-status').textContent = wasImpostor
        ? `${ejectedName} was voted out — they WERE the impostor!`
        : `${ejectedName} was voted out — NOT the impostor. Game continues.`;
    }
    return;
  }
  lastVoteWasGameOver = false;
  showScreen('screen-result');
  if (skipped) {
    document.getElementById('result-title').textContent = 'Vote Skipped';
    document.getElementById('result-detail').textContent = 'No one was voted out. Back to discussion.';
  } else {
    document.getElementById('result-title').textContent = `${ejectedName} was voted out`;
    document.getElementById('result-detail').textContent = wasImpostor
      ? `${ejectedName} was the IMPOSTOR!`
      : `${ejectedName} was NOT the impostor.`;
  }
  document.getElementById('btn-result-continue').textContent = 'Continue';
});

socket.on('guess_result', ({ correct }) => {
  document.getElementById('guess-status').textContent = correct ? 'Correct!' : 'Wrong guess. You cannot guess again.';
});

socket.on('game_over', ({ winner, reason }) => {
  if (isSpectating) {
    const status = document.getElementById('spectate-status');
    status.textContent = (winner === 'civilians' ? 'Civilians Win! ' : 'Impostor Wins! ') + reason;
    status.style.color = winner === 'civilians' ? '#34d399' : '#f21717';
    return;
  }
  lastVoteWasGameOver = true;
  showScreen('screen-result');
  document.getElementById('result-title').textContent = winner === 'civilians' ? 'Civilians Win!' : 'Impostor Wins!';
  document.getElementById('result-detail').textContent = reason;
  document.getElementById('btn-result-continue').textContent = 'Back to Home';
});

function continueAfterVote() {
  if (lastVoteWasGameOver) {
    showScreen('screen-landing');
    hideChat();
    document.getElementById('qr-corner').style.display = 'none';
  } else {
    resetClueUI();
    showScreen('screen-game');
    socket.emit('start_next_round');
  }
}

socket.on('player_left', ({ name }) => {
  const hint = document.getElementById('game-hint');
  hint.textContent += `\n${name} has left the game.`;
});

// ---- Single player ----

let soloDifficulty = 'easy';
let soloPlayers = 5;
let soloImpostors = 1;

function setDifficulty(diff) {
  soloDifficulty = diff;
  ['easy', 'medium', 'hard'].forEach(d => {
    document.getElementById('diff-' + d).classList.toggle('active', d === diff);
  });
}

function changeSoloSetting(type, delta) {
  if (type === 'players') {
    soloPlayers = Math.min(10, Math.max(3, soloPlayers + delta));
    document.getElementById('solo-player-count').textContent = soloPlayers;
    const maxImp = Math.max(1, Math.floor(soloPlayers / 2) - 1) || 1;
    soloImpostors = Math.min(soloImpostors, maxImp);
    document.getElementById('solo-impostor-count').textContent = soloImpostors;
  } else {
    const maxImp = Math.max(1, Math.floor(soloPlayers / 2) - 1) || 1;
    soloImpostors = Math.min(maxImp, Math.max(1, soloImpostors + delta));
    document.getElementById('solo-impostor-count').textContent = soloImpostors;
  }
}

function startSolo() {
  socket.emit('start_solo', {
    name: getGuestName(),
    difficulty: soloDifficulty,
    botCount: soloPlayers - 1,
    impostorCount: soloImpostors
  });
}

// ---- Game browser ----

socket.on('rooms_list', (roomsList) => {
  renderGameBrowser(roomsList);
});

function renderGameBrowser(list) {
  const el = document.getElementById('game-browser-list');
  el.innerHTML = '';
  if (!list || !list.length) {
    el.innerHTML = '<p class="game-browser-empty">No active games.</p>';
    return;
  }
  list.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-entry ' + (r.started ? 'in-game' : 'lobby');
    const code = document.createElement('span');
    code.className = 'room-entry-code';
    code.textContent = 'Room ' + r.code;
    const info = document.createElement('span');
    info.className = 'room-entry-info';
    info.textContent = `${r.playerCount} player${r.playerCount !== 1 ? 's' : ''} · ${r.started ? 'In progress' : 'Waiting to start'}`;
    const btn = document.createElement('button');
    if (!r.started) {
      btn.className = 'room-entry-btn join-btn';
      btn.textContent = 'Join';
      btn.onclick = () => quickJoin(r.code);
    } else {
      btn.className = 'room-entry-btn spectate-btn';
      btn.textContent = 'Spectate';
      btn.onclick = () => spectateRoom(r.code);
    }
    div.appendChild(code);
    div.appendChild(info);
    div.appendChild(btn);
    el.appendChild(div);
  });
}

function quickJoin(code) {
  showScreen('screen-name', 'join');
  document.getElementById('input-code').value = code;
}

// ---- Spectate ----

let isSpectating = false;

function spectateRoom(code) {
  socket.emit('spectate_room', { code });
}

socket.on('spectate_started', ({ word, impostors, clues }) => {
  isSpectating = true;
  showScreen('screen-spectate');
  document.getElementById('spectate-word').textContent = word.toUpperCase();
  document.getElementById('spectate-impostors').textContent = `Impostors: ${impostors.join(', ')}`;
  document.getElementById('spectate-status').textContent = '';
  document.getElementById('spectate-status').style.color = '#b9aed1';
  document.getElementById('spectate-turn-label').textContent = '';
  document.getElementById('spectate-timer').textContent = '';
  const cl = document.getElementById('spectate-clue-list');
  cl.innerHTML = '';
  (clues || []).forEach(c => {
    const li = document.createElement('li');
    li.textContent = c.word ? `${c.name}: ${c.word}` : `${c.name}: (no answer)`;
    cl.appendChild(li);
  });
});

socket.on('spectate_error', (msg) => {
  const err = document.getElementById('game-browser-error');
  err.textContent = msg;
  setTimeout(() => { err.textContent = ''; }, 3000);
});

function stopSpectating() {
  isSpectating = false;
  socket.emit('leave_spectate');
  clearInterval(clueTimerInterval);
  showScreen('screen-landing');
}

function leaveGame() {
  socket.emit('leave_room');
  hideChat();
  clearInterval(clueTimerInterval);
  document.getElementById('qr-corner').style.display = 'none';
  showScreen('screen-landing');
}

socket.on('signup_success', ({ username }) => {
  localStorage.setItem('guestName', username);
  document.getElementById('guest-name').textContent = username;
  showScreen('screen-landing');
});

socket.on('signup_error', (msg) => {
  document.getElementById('err-signup').textContent = msg;
});

socket.on('login_success', ({ username }) => {
  localStorage.setItem('guestName', username);
  document.getElementById('guest-name').textContent = username;
  showScreen('screen-landing');
});

socket.on('login_error', (msg) => {
  document.getElementById('err-login').textContent = msg;
});

socket.on('error', (msg) => {
  const nameErr = document.getElementById('err-name');
  const lobbyErr = document.getElementById('err-lobby');
  if (document.getElementById('screen-name').classList.contains('active')) nameErr.textContent = msg;
  else lobbyErr.textContent = msg;
});
