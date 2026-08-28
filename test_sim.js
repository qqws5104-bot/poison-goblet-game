// 자동 스모크 테스트: 두 개의 소켓 클라이언트로 셋업 + 10라운드를 진행시켜
// 서버 로직이 예외 없이 동작하는지, 10종 미니게임과 보상 시스템이 모두 정상 동작하는지 확인한다.
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
  socket.on('rewardResult', (payload) => console.log('[REWARD]', label, JSON.stringify(payload)));
  return socket;
}

let setupSent = { A: false, B: false };
let minigamesSeen = new Set();
let rewardsSeen = new Set();
let rewardUsed = { A: false, B: false };
let bankGuessed = { A: new Set(), B: new Set() };
let bankSecretSent = { A: false, B: false };
let bankCandidates = { A: null, B: null };

function allPermutations(n) {
  const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const results = [];
  function permute(current, remaining) {
    if (current.length === n) { results.push(current.slice()); return; }
    for (let i = 0; i < remaining.length; i++) {
      const next = remaining.slice();
      const d = next.splice(i, 1)[0];
      permute([...current, d], next);
    }
  }
  permute([], digits);
  return results;
}
function scoreGuessAgainst(guess, secret) {
  let strikes = 0, balls = 0;
  guess.forEach((d, i) => { if (secret[i] === d) strikes += 1; else if (secret.includes(d)) balls += 1; });
  return { strikes, balls };
}

let lastRoundLogged = { A: 0, B: 0 };
function onState(label, socket, s) {
  if (s.round && s.round !== lastRoundLogged[label]) {
    lastRoundLogged[label] = s.round;
    console.log(`[STATUS r${s.round}/${s.roundsTotal}] ${label}(${s.me.name}): poison=${s.me.poison} antidote=${s.me.antidote} score=${s.me.score}`);
  }
  if (s.phase === 'SETUP' && !setupSent[label]) {
    setupSent[label] = true;
    const cells = label === 'A' ? [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 2 }] : [{ row: 5, col: 5 }, { row: 4, col: 4 }, { row: 3, col: 3 }];
    setTimeout(() => socket.emit('setup:confirm', { cells }), 50 + Math.random() * 100);
  }

  if (s.roundReward) rewardsSeen.add(s.roundReward.type);

  if (s.phase === 'ROUND_MINIGAME' && s.minigame) {
    minigamesSeen.add(s.minigame.type);
    playMinigame(label, socket, s);
  }

  if (s.phase === 'ROUND_ACTION' && s.isMyTurn) {
    setTimeout(() => doRandomAction(label, socket, s), 30);
  }

  if (s.phase === 'ROUND_ACTION' && s.myReward && !s.myReward.used && !rewardUsed[label]) {
    rewardUsed[label] = true; // 라운드당 한 번만 시도(중복 emit 방지용 플래그, state 갱신시 아래에서 리셋)
    setTimeout(() => useReward(label, socket, s), 40 + Math.random() * 80);
  }
  if (s.phase !== 'ROUND_ACTION' || !s.myReward) rewardUsed[label] = false;

  if (s.phase === 'END' && !done) {
    done = true;
    console.log('=== GAME END ===', 'winner:', s.winner, 'reason:', s.endReason);
    console.log('minigame types seen:', [...minigamesSeen], `(${minigamesSeen.size}/10)`);
    console.log('reward types seen:', [...rewardsSeen], `(${rewardsSeen.size}/4)`);
    console.log('final me(' + label + '):', { score: s.me.score, poison: s.me.poison, finalScore: s.me.finalScore });
    setTimeout(() => process.exit(0), 200);
  }
}

function useReward(label, socket, s) {
  const r = s.myReward;
  if (!r || r.used) return;
  if (r.type === 'FLASH_ALL') return socket.emit('reward:use', {});
  if (r.type === 'PEEK_CELL') return socket.emit('reward:use', { row: Math.floor(Math.random() * 6), col: Math.floor(Math.random() * 6) });
  if (r.type === 'ROW_COUNT' || r.type === 'COL_COUNT') {
    const cats = Object.keys(s.clueCatNames);
    const cat = cats[Math.floor(Math.random() * cats.length)];
    return socket.emit('reward:use', { index: Math.floor(Math.random() * 6), targetType: cat });
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
    if (type === 'SIGIL' && mg.waitingForMe) {
      const opts = ['SWORD', 'POISON', 'SHIELD'];
      socket.emit('minigame:move', { pick: opts[Math.floor(Math.random() * opts.length)] });
    }
    if (type === 'GUESS_COUNT' && mg.myGuess == null) {
      const offset = Math.floor(Math.random() * 3) - 1;
      socket.emit('minigame:move', { guess: Math.max(0, mg.trueCount + offset) });
    }
    if (type === 'PARITY' && mg.waitingForMe) {
      socket.emit('minigame:move', { n: 1 + Math.floor(Math.random() * 3) });
    }
    if (type === 'SHOWDOWN' && mg.waitingForMe) {
      socket.emit('minigame:move', { n: 1 + Math.floor(Math.random() * 10) });
    }
    if (type === 'BANK' && !mg.mySecretSet && !bankSecretSent[label]) {
      bankSecretSent[label] = true;
      const secret = randomUniqueDigits(mg.digits, new Set());
      socket.emit('minigame:move', { secret });
    }
    if (type === 'BANK' && mg.mySecretSet && mg.oppSecretSet && mg.myTurn) {
      // 순수 무작위 추측은 720개 순열 중 하나를 맞히는 데 평균 수백 번이 걸려 테스트가 느려지므로,
      // 스트라이크/볼 결과로 후보를 계속 좁혀나가는 간단한 추론 봇을 사용한다(실제 사람의 플레이를 근사).
      if (!bankCandidates[label]) bankCandidates[label] = allPermutations(mg.digits);
      if (mg.myGuesses.length) {
        const last = mg.myGuesses[mg.myGuesses.length - 1];
        bankCandidates[label] = bankCandidates[label].filter((c) => {
          const r = scoreGuessAgainst(last.guess, c);
          return r.strikes === last.strikes && r.balls === last.balls;
        });
      }
      const pool = bankCandidates[label].length ? bankCandidates[label] : allPermutations(mg.digits);
      const guess = pool[Math.floor(Math.random() * pool.length)];
      bankGuessed[label].add(guess.join(''));
      socket.emit('minigame:move', { guess });
    }
  }, 20 + Math.random() * 60);
}

function randomUniqueDigits(n, avoidSet) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const picked = [];
    for (let i = 0; i < n; i++) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    if (!avoidSet.has(picked.join(''))) return picked;
  }
  // 다 소진되었으면 그냥 아무거나(테스트 목적상 무한루프 방지)
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return picked;
}

function doRandomAction(label, socket, s) {
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
