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

function showScreen(id, context) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');

  if (id === 'screen-name') {
    mode = context;
    document.getElementById('name-heading').textContent = context === 'start' ? 'Start a Game' : 'Join a Game';
    const codeInput = document.getElementById('input-code');
    codeInput.style.display = context === 'join' ? 'block' : 'none';
    document.getElementById('input-name').value = '';
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

// Socket events

socket.on('room_created', ({ code }) => {
  document.getElementById('lobby-code').textContent = code;
  showScreen('screen-lobby');
  document.getElementById('btn-start').style.display = 'block';
  document.getElementById('lobby-host-note').textContent = 'You are the host. Share the code above.';
});

socket.on('room_joined', ({ code }) => {
  document.getElementById('lobby-code').textContent = code;
  showScreen('screen-lobby');
  document.getElementById('btn-start').style.display = 'none';
  document.getElementById('lobby-host-note').textContent = 'Waiting for the host to start...';
});

socket.on('lobby_update', ({ players, host }) => {
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
});

socket.on('game_started', ({ word, isImpostor }) => {
  showScreen('screen-game');
  if (isImpostor) {
    document.getElementById('game-role-title').textContent = 'You are the IMPOSTOR';
    document.getElementById('game-word-box').textContent = '???';
    document.getElementById('game-hint').textContent = 'You have no word. Listen carefully and blend in. Try to guess the word before you get voted out!';
  } else {
    document.getElementById('game-role-title').textContent = 'You are a CIVILIAN';
    document.getElementById('game-word-box').textContent = word.toUpperCase();
    document.getElementById('game-hint').textContent = 'This is your secret word. Discuss without giving it away — find the impostor!';
  }
});

socket.on('player_left', ({ name }) => {
  const hint = document.getElementById('game-hint');
  hint.textContent += `\n${name} has left the game.`;
});

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
