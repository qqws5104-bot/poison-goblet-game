// 가문의 문장 즉시 승리 조건만 집중적으로 검증하는 스모크 테스트.
// A는 항상 문장 칸(row2~4,col2~4)만 순서대로 열고, B는 아무 칸이나 무작위로 연다.
// A가 9칸을 다 열기 전에 라운드가 끝나버리지 않도록, 미니게임은 항상 A가 이기도록 유도한다.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
let done = false;

const CREST = [];
for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) CREST.push({ row: r, col: c });
let crestIdx = 0;
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

function connectPlayer(label) {
  const socket = io(URL, { reconnection: false, forceNew: true });
  socket.on('state', (s) => onState(label, socket, s));
  socket.on('log', ({ msg }) => console.log('[LOG]', msg));
  socket.on('error', ({ message }) => console.log('[ERR]', label, message));
  return socket;
}

let setupSent = { A: false, B: false };
let lastOpensRemaining = { A: null, B: null };
function onState(label, socket, s) {
  if (s.phase === 'SETUP' && !setupSent[label]) {
    setupSent[label] = true;
    const cells = label === 'A' ? [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 5, col: 0 }] : [{ row: 5, col: 5 }, { row: 0, col: 5 }, { row: 5, col: 1 }];
    setTimeout(() => socket.emit('setup:confirm', { cells }), 50);
  }
  if (s.phase === 'ROUND_MINIGAME' && s.minigame) {
    playMinigame(label, socket, s);
  }
  // 같은 opensRemaining 값에 대해 중복으로 action:open을 보내면(여러 state 브로드캐스트가
  // 겹쳐 들어올 때) crestIdx가 실제로 열리지 않은 칸까지 건너뛰어버리므로, 값이 "새로 바뀌었을
  // 때"만 한 번 행동한다.
  if (s.phase === 'ROUND_ACTION' && s.isMyTurn && lastOpensRemaining[label] !== s.opensRemaining) {
    lastOpensRemaining[label] = s.opensRemaining;
    setTimeout(() => doAction(label, socket, s), 30);
  }
  if (s.phase !== 'ROUND_ACTION') lastOpensRemaining[label] = null;
  if (label === 'A' && s.me) console.log(`[STATUS] round=${s.round} phase=${s.phase} A.crestOpened=${s.me.crestOpened}`);
  if (s.phase === 'END' && !done) {
    done = true;
    console.log('=== GAME END ===', 'winner:', s.winner, 'reason:', s.endReason, 'me.crestOpened:', s.me.crestOpened);
    setTimeout(() => process.exit(s.endReason && s.endReason.includes('문장') ? 0 : 1), 200);
  }
}

function doAction(label, socket, s) {
  if (label === 'A') {
    if (crestIdx < CREST.length) {
      const target = CREST[crestIdx];
      crestIdx += 1;
      return socket.emit('action:open', target);
    }
    // 문장을 다 열었는데도 아직 안 끝났다면(이상 상황) 아무 칸이나 연다.
  }
  const target = findUnopened(s.me.room);
  if (target) socket.emit('action:open', target);
}
function findUnopened(room) {
  const candidates = [];
  for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened) candidates.push({ row: r, col: c });
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// A가 항상 이기도록: NIM은 A가 항상 유리하게 크게 채우고 최종에 맞춰 넘기게 하기보다,
// 가장 간단한 REFLEX/SIGIL류에서 A가 유리하도록 하드코딩하기는 까다로우므로, 대신
// "미니게임 승패와 무관하게 각자 자기 턴에 자기 처소를 연다"는 본행동 규칙을 활용한다 —
// 즉 미니게임 승자와 무관하게 A는 매 라운드 자기 몫(OPENS_PER_TURN=2)을 문장칸부터 채운다.
// 따라서 미니게임은 그냥 무작위로 대응해도 된다.
let bankRoundSeen = { A: null, B: null };
function playMinigame(label, socket, s) {
  const mg = s.minigame.public;
  const type = s.minigame.type;
  if (type === 'BANK' && bankRoundSeen[label] !== s.round) { bankRoundSeen[label] = s.round; bankCandidates[label] = null; }
  setTimeout(() => {
    if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 });
    if (type === 'HAND') {
      if (mg.role === 'hider' && mg.waitingForMe) socket.emit('minigame:move', { hand: 'L' });
      if (mg.role === 'guesser' && mg.waitingForMe) socket.emit('minigame:move', { hand: 'L' });
    }
    if (type === 'REFLEX' && !mg.myClicked && mg.goFired) socket.emit('minigame:move', { action: 'CLICK' });
    if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
    if (type === 'PIN' && mg.myTurn) {
      const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
      if (remaining.length) socket.emit('minigame:move', { action: 'PICK', index: remaining[0] });
    }
    if (type === 'SIGIL' && mg.waitingForMe) socket.emit('minigame:move', { pick: label === 'A' ? 'SWORD' : 'SHIELD' });
    if (type === 'GUESS_COUNT' && mg.myGuess == null) socket.emit('minigame:move', { guess: mg.trueCount });
    if (type === 'BANK') {
      if (!bankCandidates[label]) bankCandidates[label] = allPermutations(3);
      const myGuesses = mg.myGuesses || [];
      if (myGuesses.length) {
        const last = myGuesses[myGuesses.length - 1];
        bankCandidates[label] = bankCandidates[label].filter((c) => {
          const r = scoreGuessAgainst(last.guess, c);
          return r.strikes === last.strikes && r.balls === last.balls;
        });
      }
      const pool = bankCandidates[label].length ? bankCandidates[label] : allPermutations(3);
      socket.emit('minigame:move', { guess: pool[Math.floor(Math.random() * pool.length)] });
    }
    if (type === 'BLUFF' && mg.waitingForMe) socket.emit('minigame:move', { stake: 2 });
    if (type === 'LIAR_DIE') {
      if (mg.role === 'declarer' && mg.claim == null) socket.emit('minigame:move', { claim: 'HIGH' });
      if (mg.role === 'responder' && mg.waitingForMe) socket.emit('minigame:move', { decision: 'TRUST' });
    }
    if (type === 'GAMBIT' && mg.waitingForMe) socket.emit('minigame:move', { action: 'YIELD' });
  }, type === 'BOMB' ? 300 : 30);
}

connectPlayer('A');
setTimeout(() => connectPlayer('B'), 100);

setTimeout(() => {
  if (!done) { console.error('TIMEOUT'); process.exit(1); }
}, 120000);
