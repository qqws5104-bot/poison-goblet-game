// 자동 스모크 테스트: 두 개의 소켓 클라이언트로 셋업 + 여러 라운드를 진행시켜
// 서버 로직이 예외 없이 동작하는지, 5종 미니게임이 모두 정상 진행되는지 확인한다.
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
let states = { A: null, B: null };
let done = false;

function connectPlayer(label) {
  const socket = io(URL, { reconnection: false, forceNew: true });
  socket.on('connect_error', (e) => console.error(label, 'connect_error', e.message));
  socket.on('state', (s) => { states[label] = s; onState(label, socket, s); });
  socket.on('log', ({ msg }) => console.log('[LOG]', msg));
  socket.on('error', ({ message }) => console.log('[ERR]', label, message));
  socket.on('clueResult', ({ text }) => console.log('[CLUE]', label, text));
  return socket;
}

let setupSent = { A: false, B: false };
let roundsSeen = new Set();
let actionsThisTurn = { A: 0, B: 0 };

let lastRoundLogged = { A: 0, B: 0 };
function onState(label, socket, s) {
  if (s.round && s.round !== lastRoundLogged[label] && s.round % 10 === 0) {
    lastRoundLogged[label] = s.round;
    console.log(`[STATUS r${s.round}] ${label}(${s.me.name}): poison=${s.me.poison} antidote=${s.me.antidote} score=${s.me.score}`);
  }
  if (s.phase === 'SETUP' && !setupSent[label]) {
    setupSent[label] = true;
    const cells = label === 'A' ? [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 2 }] : [{ row: 5, col: 5 }, { row: 4, col: 4 }, { row: 3, col: 3 }];
    setTimeout(() => socket.emit('setup:confirm', { cells }), 50 + Math.random() * 100);
  }

  if (s.phase === 'ROUND_MINIGAME' && s.minigame) {
    roundsSeen.add(s.minigame.type);
    playMinigame(label, socket, s);
  }

  if (s.phase === 'ROUND_ACTION' && s.isMyTurn) {
    setTimeout(() => doRandomAction(label, socket, s), 30);
  }

  if (s.phase === 'END' && !done) {
    done = true;
    console.log('=== GAME END ===', 'winner:', s.winner, 'reason:', s.endReason);
    console.log('minigame types seen:', [...roundsSeen]);
    console.log('final me(' + label + '):', s.me);
    setTimeout(() => process.exit(0), 200);
  }
}

function playMinigame(label, socket, s) {
  const mg = s.minigame.public;
  const type = s.minigame.type;
  setTimeout(() => {
    if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 + Math.floor(Math.random() * 3) });
    if (type === 'HAND') {
      if (mg.role === 'hider' && mg.waitingForMe) socket.emit('minigame:move', { hand: Math.random() < 0.5 ? 'L' : 'R' });
      if (mg.role === 'guesser' && mg.waitingForMe) socket.emit('minigame:move', { hand: Math.random() < 0.5 ? 'L' : 'R' });
    }
    if (type === 'CARD') {
      if (mg.role === 'presenter' && mg.waitingForMe) socket.emit('minigame:move', { declared: 1 + Math.floor(Math.random() * 5) });
      if (mg.role === 'guesser' && mg.waitingForMe) socket.emit('minigame:move', { guess: Math.random() < 0.5 ? 'TRUE' : 'LIE' });
    }
    if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
    if (type === 'PIN' && mg.myTurn) socket.emit('minigame:move', { action: 'PULL' });
  }, 20 + Math.random() * 60);
}

function doRandomAction(label, socket, s) {
  actionsThisTurn[label]++;
  const r = Math.random();
  if (r < 0.08 && s.me.items.length < s.config.INVENTORY_CAP) {
    const keys = Object.keys(s.itemNames);
    const k = keys[Math.floor(Math.random() * keys.length)];
    return socket.emit('action:item_get', { itemType: k });
  }
  if (r < 0.08 + 0.17) {
    const cats = Object.keys(s.clueCatNames);
    const cat = cats[Math.floor(Math.random() * cats.length)];
    return socket.emit('action:clue', { category: cat });
  }
  if (s.me.items.length > 0 && r < 0.08 + 0.17 + 0.05) {
    const item = s.me.items[0];
    if (item === 'SPOON') {
      const target = findUnopened(s.me.room);
      if (target) return socket.emit('action:item_use', { itemType: 'SPOON', target });
    } else if (item === 'NOSE') {
      return socket.emit('action:item_use', { itemType: 'NOSE', target: { axis: 'row', index: Math.floor(Math.random() * 6) } });
    } else {
      return socket.emit('action:item_use', { itemType: item });
    }
  }
  const target = findUnopened(s.me.room);
  if (target) return socket.emit('action:open', target);
  // fallback: everything opened, just get an item
  socket.emit('action:item_get', { itemType: 'WARD' });
}

function findUnopened(room) {
  const candidates = [];
  for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened) candidates.push({ row: r, col: c });
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

const a = connectPlayer('A');
setTimeout(() => connectPlayer('B'), 100);

setTimeout(() => {
  if (!done) {
    console.error('TIMEOUT: 게임이 180초 내에 끝나지 않았습니다. 마지막 상태:', JSON.stringify({ A: states.A && states.A.phase, B: states.B && states.B.phase }));
    process.exit(1);
  }
}, 180000);
