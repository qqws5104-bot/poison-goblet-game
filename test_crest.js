// 가문의 문장(고정 9개 총량 + 이미지 조각 은닉 크레스트) 스모크 테스트.
//
// 예전 버전은 문장이 고정된 3x3 블록(row2~4,col2~4)에 있다는 전제로 그 칸만 순서대로 열었지만,
// 지금은 "독 배치 이후 남은 칸 중 완전 무작위" 구조로 바뀌어 그 접근 자체가 성립하지 않는다.
// 대신 두 플레이어 모두 자기 처소를 처음부터 끝까지 결정론적으로(row-major) 스캔해서 열게 하여,
// 실제 플레이라면 우연히 순서대로 열어나가다 문장을 전부 찾아내는 상황을 근사한다. 전반 8라운드
// (16칸) + 후반 7라운드(14칸) = 30/36칸이 열리므로, 1차 문장(전반 24칸 안, 5~6개)은 거의 항상
// 다 열리고 2차 문장(후반 신규 12칸 안, 나머지 3~4개)도 상당수 열린다 — 총량은 9로 고정이지만
// (본인도 모르는) 1차/2차 배치 개수 자체는 여전히 무작위다.
// "문장을 다 모아도 즉시 끝나지 않아야 한다"는 피드백으로 즉시승리 조건은 제거됐으므로, 이제는
// 문장을 완성해도 매치가 계속 15라운드까지 진행되는지, crestTotal이 설계 범위(5~9, 저격당하면
// 9보다 줄 수 있음)를 벗어나지 않는지, 그리고 MID_SETUP 전환이 문제없이 이뤄지는지를 검증한다.
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const ROWS_FIRST_HALF = 4;
let done = false;
let states = { A: null, B: null };

function connectPlayer(label) {
  const socket = io(URL, { reconnection: false, forceNew: true });
  socket.on('connect_error', (e) => console.error(label, 'connect_error', e.message));
  socket.on('state', (s) => { states[label] = s; onState(label, socket, s); });
  socket.on('log', ({ msg }) => console.log('[LOG]', msg));
  socket.on('error', ({ message }) => console.log('[ERR]', label, message));
  return socket;
}

let setupSent = { A: false, B: false };
let midSetupSent = { A: false, B: false };
let bankCandidates = { A: null, B: null };
let bankRoundSeen = { A: null, B: null };
let rewardUsed = { A: false, B: false };
let rewardChosen = { A: false, B: false };
let lastRoundLogged = { A: 0, B: 0 };

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

function onState(label, socket, s) {
  if (s.round && s.round !== lastRoundLogged[label]) {
    lastRoundLogged[label] = s.round;
    console.log(`[STATUS r${s.round}/${s.roundsTotal}] ${label}(${s.me.name}): crestOpened=${s.me.crestOpened} poison=${s.me.poison}`);
  }

  if (s.phase === 'SETUP' && !setupSent[label]) {
    setupSent[label] = true;
    const cells = label === 'A' ? [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 3, col: 0 }] : [{ row: 3, col: 5 }, { row: 0, col: 5 }, { row: 2, col: 1 }];
    setTimeout(() => socket.emit('setup:confirm', { cells }), 50 + Math.random() * 100);
  }

  if (s.phase === 'MID_SETUP' && !midSetupSent[label] && s.oppOpenedMask) {
    midSetupSent[label] = true;
    const candidates = [];
    const mask = s.oppOpenedMask;
    for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) candidates.push({ row: r, col: c });
    const pool = candidates.slice();
    const picked = [];
    const need = (s.config && s.config.POISON_MID) || 2;
    for (let i = 0; i < need && pool.length; i++) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    setTimeout(() => socket.emit('mid_setup:confirm', { cells: picked }), 50 + Math.random() * 100);
  }
  if (s.phase !== 'MID_SETUP') midSetupSent[label] = false;

  if (s.phase === 'ROUND_MINIGAME' && s.minigame) playMinigame(label, socket, s);

  if (s.phase === 'ROUND_ACTION' && s.myReward && !s.myReward.type && !s.myReward.used && !rewardChosen[label]) {
    rewardChosen[label] = true;
    setTimeout(() => chooseReward(label, socket, s), 30 + Math.random() * 40);
  }
  if (!(s.myReward && !s.myReward.type)) rewardChosen[label] = false;

  if (s.phase === 'ROUND_ACTION' && s.myReward && s.myReward.type && !s.myReward.used && !rewardUsed[label]) {
    rewardUsed[label] = true;
    setTimeout(() => useReward(label, socket, s), 40 + Math.random() * 80);
  }
  if (s.phase !== 'ROUND_ACTION' || !s.myReward || !s.myReward.type) rewardUsed[label] = false;

  // doScanAction은 매번 s.me.room을 처음부터 다시 스캔해 "아직 안 연 칸 중 첫 칸"을 고르는
  // 상태 없는(stateless) 함수라, 같은 state로 여러 번 불려도 안전하다(서버가 이미 열린 칸은
  // 그냥 무시함) — 그래서 isMyTurn인 동안은 매 state마다 계속 시도해도 된다. 반대로 "opensRemaining이
  // 바뀔 때만" 시도하던 이전 방식은, 서버가 어떤 이유로든(예: 섬광 정찰 보상을 아직 못 써서) 이번
  // 시도를 조용히 거절하면 opensRemaining이 영원히 안 바뀌어 다시는 재시도하지 않게 되는 함정이
  // 있었다 — 실제로 FLASH_ALL 보상을 고른 직후 이 경합으로 게임이 영구 정지하는 문제를 겪었다.
  if (process.env.DEBUG_CREST && s.phase === 'ROUND_ACTION') {
    console.log('[DEBUG state]', label, 'isMyTurn=', s.isMyTurn, 'opensRemaining=', s.opensRemaining);
  }
  if (s.phase === 'ROUND_ACTION' && s.isMyTurn) {
    setTimeout(() => doScanAction(label, socket, s), 30);
  }

  if (s.phase === 'END' && !done) {
    done = true;
    console.log('=== GAME END ===', 'winner:', s.winner, 'reason:', s.endReason);
    console.log(`final me(${label}): crestOpened=${s.me.crestOpened} crestTotal=${s.me.crestTotal} opp.crestTotal=${s.opp && s.opp.crestTotal}`);
    // 즉시승리는 제거됐으므로, 문장을 완성했더라도 매치는 반드시 15라운드까지 진행돼야 한다 —
    // 종료 사유가 "즉시 왕위 차지" 문구가 아니라 항상 "15라운드 종료..." 계열이어야 정상이다.
    if (!s.endReason || !s.endReason.includes(`${s.roundsTotal}라운드 종료`)) {
      console.error('FAIL: 15라운드를 다 채우지 않고 끝났습니다(즉시승리가 되살아난 것으로 의심).', s.endReason);
      setTimeout(() => process.exit(1), 200);
      return;
    }
    // crestTotal은 중반 재설치까지 거치면 총량이 9로 고정이라 기본 9다. 다만 중반 독 추가 설치가
    // 하필 이미 있던 1차 문장 자리를 "저격"하면 그 조각만큼 crestTotal도 함께 줄어드므로
    // (POISON_MID=2까지 저격 가능), 하한은 그만큼 더 낮게, 상한은 총량 고정에 맞춰 9로 잡는다.
    const totalsOk = [s.me.crestTotal, s.opp && s.opp.crestTotal].every((t) => t == null || (t >= 5 && t <= 9));
    if (!totalsOk) {
      console.error('FAIL: crestTotal이 설계 범위(5~9)를 벗어났습니다.', s.me.crestTotal, s.opp && s.opp.crestTotal);
      setTimeout(() => process.exit(1), 200);
      return;
    }
    console.log('PASS: 문장을 완성해도 즉시승리 없이 15라운드까지 진행됐고, crestTotal 범위도 정상입니다.');
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
  if (r.type === 'PEEK_CELL') {
    const activeRows = (s.me.room[ROWS_FIRST_HALF] && s.me.room[ROWS_FIRST_HALF][0].locked) ? ROWS_FIRST_HALF : 6;
    return socket.emit('reward:use', { row: Math.floor(Math.random() * activeRows), col: Math.floor(Math.random() * 6) });
  }
  if (r.type === 'ROW_COUNT' || r.type === 'COL_COUNT') {
    const cats = Object.keys(s.clueCatNames);
    const cat = cats[Math.floor(Math.random() * cats.length)];
    return socket.emit('reward:use', { targetType: cat });
  }
}

function playMinigame(label, socket, s) {
  const mg = s.minigame.public;
  const type = s.minigame.type;
  if (type === 'BANK' && bankRoundSeen[label] !== s.round) { bankRoundSeen[label] = s.round; bankCandidates[label] = null; }
  setTimeout(() => {
    if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 + Math.floor(Math.random() * 3) });
    if (type === 'HAND') {
      if (mg.role === 'hider' && mg.waitingForMe) socket.emit('minigame:move', { hand: Math.random() < 0.5 ? 'L' : 'R' });
      if (mg.role === 'guesser' && mg.waitingForMe) socket.emit('minigame:move', { hand: Math.random() < 0.5 ? 'L' : 'R' });
    }
    if (type === 'REFLEX' && !mg.myClicked && mg.goFired) socket.emit('minigame:move', { action: 'CLICK' });
    if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
    if (type === 'PIN' && mg.myTurn) {
      const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
      if (remaining.length) socket.emit('minigame:move', { action: 'PICK', index: remaining[Math.floor(Math.random() * remaining.length)] });
    }
    if (type === 'SIGIL' && mg.waitingForMe) socket.emit('minigame:move', { pick: ['SWORD', 'POISON', 'SHIELD'][Math.floor(Math.random() * 3)] });
    if (type === 'GUESS_COUNT' && mg.myGuess == null) socket.emit('minigame:move', { guess: Math.max(0, mg.trueCount + Math.floor(Math.random() * 3) - 1) });
    if (type === 'BANK') {
      if (!bankCandidates[label]) bankCandidates[label] = allPermutations(mg.digits);
      if (mg.myGuesses.length) {
        const last = mg.myGuesses[mg.myGuesses.length - 1];
        bankCandidates[label] = bankCandidates[label].filter((c) => {
          const r = scoreGuessAgainst(last.guess, c);
          return r.strikes === last.strikes && r.balls === last.balls;
        });
      }
      const pool = bankCandidates[label].length ? bankCandidates[label] : allPermutations(mg.digits);
      socket.emit('minigame:move', { guess: pool[Math.floor(Math.random() * pool.length)] });
    }
    if (type === 'CARD_DUEL' && mg.waitingForMe) {
      const shuffled = [1, 2, 3].sort(() => Math.random() - 0.5);
      socket.emit('minigame:move', { arrangement: shuffled });
    }
    if (type === 'PACT' && mg.waitingForMe) socket.emit('minigame:move', { action: Math.random() < 0.5 ? 'SILENT' : 'TALK' });
  }, type === 'BOMB' ? 250 + Math.random() * 450 : 20 + Math.random() * 60);
}

// 자기 처소를 row-major 순서로 처음부터 끝까지 스캔하며 연다 — 문장이 어디 있는지 몰라도
// 결국 다 훑게 되므로, 실제 플레이에서 "우연히 찾는" 상황을 근사한다.
function doScanAction(label, socket, s) {
  const room = s.me.room;
  for (let r = 0; r < room.length; r++) {
    for (let c = 0; c < room[r].length; c++) {
      const cell = room[r][c];
      if (!cell.opened && !cell.locked) {
        if (process.env.DEBUG_CREST) console.log('[DEBUG scan]', label, 'emit open', r, c, 'cellType(hidden normally)=', cell.type, 'opensRemaining=', s.opensRemaining);
        return socket.emit('action:open', { row: r, col: c });
      }
    }
  }
  if (process.env.DEBUG_CREST) console.log('[DEBUG scan]', label, 'NO CANDIDATE FOUND', 'opensRemaining=', s.opensRemaining, 'phase=', s.phase);
}

connectPlayer('A');
setTimeout(() => connectPlayer('B'), 100);

setTimeout(() => {
  if (!done) {
    console.error('TIMEOUT: 게임이 420초 내에 끝나지 않았습니다. 마지막 상태:', JSON.stringify({ A: states.A && states.A.phase, B: states.B && states.B.phase }));
    process.exit(1);
  }
}, 420000);
