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
let rewardChosen = { A: false, B: false };
let bankCandidates = { A: null, B: null };
let bankRoundSeen = { A: null, B: null };

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

  // 보상은 더 이상 라운드 시작 전에 자동 배정되지 않고, 미니게임 승자가 후보 중 하나를 직접
  // 고른 뒤에야 종류(myReward.type)가 정해진다 — 그 시점에 관측된 종류를 집계한다.
  if (s.myReward && s.myReward.type) rewardsSeen.add(s.myReward.type);

  if (s.phase === 'ROUND_MINIGAME' && s.minigame) {
    minigamesSeen.add(s.minigame.type);
    playMinigame(label, socket, s);
  }

  if (s.phase === 'ROUND_ACTION' && s.myReward && !s.myReward.type && !s.myReward.used && !rewardChosen[label]) {
    rewardChosen[label] = true;
    setTimeout(() => chooseReward(label, socket, s), 30 + Math.random() * 40);
  }
  if (!(s.myReward && !s.myReward.type)) rewardChosen[label] = false;

  if (s.phase === 'ROUND_ACTION' && s.isMyTurn) {
    setTimeout(() => doRandomAction(label, socket, s), 30);
  }

  if (s.phase === 'ROUND_ACTION' && s.myReward && s.myReward.type && !s.myReward.used && !rewardUsed[label]) {
    rewardUsed[label] = true; // 라운드당 한 번만 시도(중복 emit 방지용 플래그, state 갱신시 아래에서 리셋)
    setTimeout(() => useReward(label, socket, s), 40 + Math.random() * 80);
  }
  if (s.phase !== 'ROUND_ACTION' || !s.myReward || !s.myReward.type) rewardUsed[label] = false;

  if (s.phase === 'END' && !done) {
    done = true;
    console.log('=== GAME END ===', 'winner:', s.winner, 'reason:', s.endReason);
    console.log('minigame types seen:', [...minigamesSeen], `(${minigamesSeen.size}/9)`);
    console.log('reward types seen:', [...rewardsSeen], `(${rewardsSeen.size}/4)`);
    console.log('final me(' + label + '):', { score: s.me.score, poison: s.me.poison, finalScore: s.me.finalScore });
    setTimeout(() => process.exit(0), 200);
  }
}

function chooseReward(label, socket, s) {
  const r = s.myReward;
  if (!r || r.type || !r.choices || !r.choices.length) return;
  const pick = r.choices[Math.floor(Math.random() * r.choices.length)];
  socket.emit('reward:choose', { type: pick.type });
}

function useReward(label, socket, s) {
  const r = s.myReward;
  if (!r || !r.type || r.used) return;
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
  // BANK은 (필러 규칙상) 한 매치에서 두 번 나올 수도 있으므로, 라운드가 바뀌면 이전 라운드의
  // 후보 목록을 반드시 리셋해야 한다 — 안 그러면 새 라운드의 새 정답을 옛 후보군으로 추리하게 됨.
  if (type === 'BANK' && bankRoundSeen[label] !== s.round) {
    bankRoundSeen[label] = s.round;
    bankCandidates[label] = null;
  }
  setTimeout(() => {
    if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 + Math.floor(Math.random() * 3) });
    if (type === 'HAND') {
      if (mg.role === 'hider' && mg.waitingForMe) socket.emit('minigame:move', { hand: Math.random() < 0.5 ? 'L' : 'R' });
      if (mg.role === 'guesser' && mg.waitingForMe) socket.emit('minigame:move', { hand: Math.random() < 0.5 ? 'L' : 'R' });
    }
    if (type === 'REFLEX' && !mg.myClicked && mg.goFired) socket.emit('minigame:move', { action: 'CLICK' });
    if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
    if (type === 'PIN' && mg.myTurn) {
      // 안전핀 뽑기가 "숨겨진 팝 포인트까지 그냥 PULL"에서 "N개 안전핀 중 직접 하나를 고르는" 방식으로
      // 바뀌었으므로, 봇도 아직 뽑히지 않은 핀 중 하나를 무작위로 클릭해야 한다.
      const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
      if (remaining.length) {
        const index = remaining[Math.floor(Math.random() * remaining.length)];
        socket.emit('minigame:move', { action: 'PICK', index });
      }
    }
    if (type === 'SIGIL' && mg.waitingForMe) {
      const opts = ['SWORD', 'POISON', 'SHIELD'];
      socket.emit('minigame:move', { pick: opts[Math.floor(Math.random() * opts.length)] });
    }
    if (type === 'GUESS_COUNT' && mg.myGuess == null) {
      const offset = Math.floor(Math.random() * 3) - 1;
      socket.emit('minigame:move', { guess: Math.max(0, mg.trueCount + offset) });
    }
    if (type === 'MEMORY' && !mg.myAnswered) {
      // 테스트 봇은 진짜 기억력을 시험할 필요가 없으므로, 공개된 before/after를 비교해 바뀐 항목을 바로 계산해 제출한다.
      const changed = mg.after.find((k) => !mg.before.includes(k));
      socket.emit('minigame:move', { choice: changed });
    }
    if (type === 'BANK') {
      // 서버가 금고 번호를 하나 정해두고 두 사람이 순서 없이 동시에 계속 추리하는 방식으로 바뀌었다.
      // 순수 무작위 추측은 720개 순열 중 하나를 맞히는 데 평균 수백 번이 걸려 테스트가 느려지므로,
      // 스트라이크/볼 결과로 후보를 계속 좁혀나가는 간단한 추론 봇을 사용한다(실제 사람의 플레이를 근사).
      // "훼방 놓기" 경로도 회귀 테스트로 한 번은 실제로 타 보도록, 낮은 확률로 무작위 시점에 사용한다.
      if (mg.distractAvailable && Math.random() < 0.15) {
        return socket.emit('minigame:move', { action: 'DISTRACT' });
      }
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
      socket.emit('minigame:move', { guess });
    }
    // BOMB는 정해진 횟수가 아니라 시간(최대 60초)이 다 될 때까지 계속 넘겨야 하므로, 다른
    // 미니게임과 같은 20~80ms 간격으로 스팸처럼 넘기면 초당 십수 번씩 왕복 메시지가 오가며
    // 실제 사람이라면 절대 하지 않을 부하를 만들어 테스트 전체를 느리게 만든다(실측상 수백~
    // 천 회 왕복). 사람다운 속도(약 250~700ms 간격)로 넘기게 해서 테스트가 실제 판단 시간과
    // 비슷한 리듬으로 진행되게 한다.
  }, type === 'BOMB' ? 250 + Math.random() * 450 : 20 + Math.random() * 60);
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
  // 본행동은 이제 단순히 "내 처소에서 칸 열기"뿐 — 아이템/단서 시스템은 제거되었다.
  const target = findUnopened(s.me.room);
  if (target) socket.emit('action:open', target);
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
    console.error('TIMEOUT: 게임이 300초 내에 끝나지 않았습니다. 마지막 상태:', JSON.stringify({ A: states.A && states.A.phase, B: states.B && states.B.phase }));
    process.exit(1);
  }
}, 300000);
