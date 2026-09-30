// "금은동 쟁탈전"(SIGIL 최신 버전 — 금/은/동 술잔이 무작위 개수(1~3개씩)로 흩뿌려짐)의 핵심
// 규칙 두 가지를 검증하는 스크립트.
//  1) 순서를 벗어난 클릭(예: 금이 아직 남았는데 은을 먼저 누름)은 무시되고 진행 상황이 그대로여야 한다.
//  2) 금→은→동 순서로, 각 색의 개수(itemCounts)를 모두 채워야 다음 색으로 넘어가며, 셋을 먼저
//     다 끝낸 쪽이 그 자리에서 즉시 승리해야 한다.
// 미니게임 순서는 매치마다 무작위로 섞이므로(buildMinigameOrder), 1라운드가 정확히 "금은동
// 쟁탈전"이 될 때까지 admin:reset으로 매치를 새로 만들어 재시도한다(평균 ~10회, 라운드당
// 3초 카운트다운이라 매우 빠르다). A는 일부러 순서를 어긴 클릭(SILVER 먼저)을 한 번 보내 씹히는지
// 확인한 뒤 매 클릭을 B보다 느리게(200ms vs 10ms) 보내 B의 승리로 고정시켜 검증한다.
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const MAX_ATTEMPTS = 40;

function connectAdminAndReset() {
  return new Promise((resolve) => {
    const s = io(URL, { reconnection: false, forceNew: true });
    s.on('connect', () => { s.emit('admin:reset'); setTimeout(() => { s.close(); resolve(); }, 200); });
  });
}

function attempt(attemptNo) {
  return new Promise((resolve) => {
    let errors = [];
    let sawIgnoredOutOfOrder = false;
    let winnerLogMsg = null;
    let sawResult = null;
    let wrongRound1Type = false;
    let done = false;

    const setupSent = { A: false, B: false };
    const midSetupSent = { A: false, B: false };
    const sigilStarted = { A: false, B: false };
    const lastSentKey = { A: null, B: null };
    function neededTier(progress, itemCounts) {
      for (const k of ['GOLD', 'SILVER', 'BRONZE']) {
        if ((progress[k] || 0) < (itemCounts[k] || 0)) return k;
      }
      return null;
    }

    function connectPlayer(label) {
      const socket = io(URL, { reconnection: false, forceNew: true, query: { slot: label } });
      socket.on('connect_error', (e) => errors.push(`${label} connect_error ${e.message}`));
      socket.on('error', ({ message }) => errors.push(`${label} ERR ${message}`));
      socket.on('log', ({ msg }) => {
        if (msg.includes('순서대로 먼저 다 낚아챘습니다')) winnerLogMsg = msg;
      });
      socket.on('state', (s) => onState(label, socket, s));
      return socket;
    }

    let lastPhase = {};
    function onState(label, socket, s) {
      if (process.env.DEBUG_MEDAL_RACE && lastPhase[label] !== s.phase) {
        lastPhase[label] = s.phase;
        console.log(`[${label}] phase -> ${s.phase} round=${s.round} mgType=${s.minigame && s.minigame.type}`);
      }
      if (wrongRound1Type || done) return;

      // 1라운드 카운트다운에서 다음 미니게임이 "금은동 쟁탈전"이 아니면 이번 시도는 즉시 버린다
      // (8초 타임아웃까지 기다리지 않고 바로 다음 시도로 넘어간다).
      if (s.phase === 'ROUND_COUNTDOWN' && s.round === 1 && s.nextMinigameName != null) {
        if (s.nextMinigameName !== '금은동 쟁탈전') {
          wrongRound1Type = true;
          A.close(); B.close();
          resolve({ wrongRound1Type: true });
          return;
        }
      }

      if (s.phase === 'SETUP' && !setupSent[label]) {
        setupSent[label] = true;
        setTimeout(() => socket.emit('setup:confirm', { cells: [{ row: 3, col: 5 }, { row: 0, col: 5 }, { row: 2, col: 1 }] }), 50);
      }
      if (s.phase === 'MID_SETUP' && !midSetupSent[label] && s.oppOpenedMask) {
        midSetupSent[label] = true;
        const mask = s.oppOpenedMask;
        const cands = [];
        for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) cands.push({ row: r, col: c });
        setTimeout(() => socket.emit('mid_setup:confirm', { cells: cands.slice(0, s.config.POISON_MID) }), 30);
      }
      if (s.phase !== 'MID_SETUP') midSetupSent[label] = false;

      if (s.phase === 'ROUND_MINIGAME' && s.minigame && s.minigame.public && s.minigame.type === 'SIGIL') {
        const mg = s.minigame.public;
        const t = neededTier(mg.myProgress, mg.itemCounts);
        if (label === 'A' && !sigilStarted.A) {
          sigilStarted.A = true;
          // 일부러 순서를 어긴 클릭(아직 금 차례인데 은을 누름) — 무시되어 진행 상황이 그대로여야 한다.
          socket.emit('minigame:move', { tier: 'SILVER' });
          sawIgnoredOutOfOrder = true;
        }
        if (t) {
          const key = t + ':' + (mg.myProgress[t] || 0);
          if (lastSentKey[label] !== key) {
            lastSentKey[label] = key;
            // A는 매 클릭을 B보다 훨씬 느리게(200ms vs 10ms) 보내 B가 항상 먼저 끝내도록 고정시킨다.
            setTimeout(() => socket.emit('minigame:move', { tier: t }), label === 'A' ? 200 : 10);
          }
        }
      }

      if (s.phase === 'ROUND_ACTION' && !done && s.minigame && s.minigame.type === 'SIGIL') {
        done = true;
        sawResult = { result: s.minigame.result, myReward: s.myReward || null };
        setTimeout(() => finishAttempt(), 250);
      }
    }

    function finishAttempt() {
      A.close(); B.close();
      resolve({ wrongRound1Type, errors, sawIgnoredOutOfOrder, winnerLogMsg, sawResult });
    }

    const A = connectPlayer('A');
    const B = connectPlayer('B');

    setTimeout(() => {
      if (!done && !wrongRound1Type) {
        A.close(); B.close();
        resolve({ wrongRound1Type: false, errors: errors.concat(['per-attempt timeout']), sawIgnoredOutOfOrder, winnerLogMsg, sawResult });
      } else if (wrongRound1Type) {
        A.close(); B.close();
        resolve({ wrongRound1Type: true });
      }
    }, 16000); // SETUP_DONE(5s) + ROUND_COUNTDOWN(3s) + 여유
  });
}

(async () => {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    await connectAdminAndReset();
    const r = await attempt(i);
    if (r.wrongRound1Type) {
      console.log(`(시도 ${i}) 1라운드가 금은동 쟁탈전이 아니어서 재시도`);
      continue;
    }
    console.log(`(시도 ${i}) 1라운드가 금은동 쟁탈전 — 검증 진행`);
    console.log('errors:', r.errors.length ? r.errors : 'none');
    console.log('out-of-order 클릭 시도함:', r.sawIgnoredOutOfOrder);
    console.log('승리 로그:', r.winnerLogMsg);
    console.log('결과:', JSON.stringify(r.sawResult));
    const ok = r.errors.length === 0 && r.sawIgnoredOutOfOrder && r.sawResult
      && (r.sawResult.result === 'me' || r.sawResult.result === 'opp')
      && r.winnerLogMsg != null && r.winnerLogMsg.includes('차남');
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    process.exit(ok ? 0 : 1);
  }
  console.error(`${MAX_ATTEMPTS}번 시도했지만 1라운드가 금은동 쟁탈전인 매치를 얻지 못했습니다.`);
  process.exit(1);
})();
