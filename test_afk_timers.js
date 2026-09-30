// "장고 금지" 타이머 검증 — 두 봇 모두 SETUP/MID_SETUP만 확정하고, 그 이후로는 미니게임에서도
// 본행동(칸 열기)에서도 절대 아무것도 누르지 않는다("완전 잠수" 시나리오). 그런데도 서버의
// armDecisionTimer/armActionTimer가 대신 무작위로 진행시켜줘서 15라운드 매치가 끝까지(END) 실제로
// 진행되는지 확인한다. server.js의 CONFIG.DECISION_TIMER_MS/BANK_TIMER_MS/ROUND_ACTION_TIMER_MS는
// 이 테스트 동안만 아주 짧게 줄여둔 상태로 돌린다(테스트 종료 후 원상복구됨).
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
let done = false;
let errors = [];
let sawPopups = { A: [], B: [] };
let sawEnd = null;

function connectPlayer(label) {
  const socket = io(URL, { reconnection: false, forceNew: true, query: { slot: label } });
  socket.on('connect_error', (e) => errors.push(`${label} connect_error ${e.message}`));
  socket.on('error', ({ message }) => errors.push(`${label} ERR ${message}`));
  socket.on('log', ({ msg }) => console.log('[LOG]', msg));
  socket.on('popup', (p) => { sawPopups[label].push(p); console.log(`[POPUP:${label}]`, p.tone, p.text); });
  socket.on('state', (s) => onState(label, socket, s));
  return socket;
}

let setupSent = { A: false, B: false };
let midSetupSent = { A: false, B: false };

function onState(label, socket, s) {
  // 오직 SETUP/MID_SETUP만 확정한다 — 그 외(미니게임/본행동)는 절대 아무것도 누르지 않는다.
  if (s.phase === 'SETUP' && !setupSent[label]) {
    setupSent[label] = true;
    setTimeout(() => socket.emit('setup:confirm', { cells: [{ row: 3, col: 5 }, { row: 0, col: 5 }, { row: 2, col: 1 }] }), 50);
  }
  if (s.phase === 'MID_SETUP' && !midSetupSent[label] && s.oppOpenedMask) {
    midSetupSent[label] = true;
    const mask = s.oppOpenedMask;
    // 최초 SETUP 때 이미 독을 심어둔 3칸(위에서 하드코딩한 좌표)은 후보에서 제외해야 한다 —
    // oppOpenedMask는 "이미 열렸는지"만 알려줄 뿐 "이미 독이 있는지"는 알려주지 않기 때문.
    const alreadyPoisoned = new Set(['3,5', '0,5', '2,1']);
    const cands = [];
    for (let r = 0; r < mask.length; r++) {
      for (let c = 0; c < mask[r].length; c++) {
        if (!mask[r][c] && !alreadyPoisoned.has(`${r},${c}`)) cands.push({ row: r, col: c });
      }
    }
    setTimeout(() => socket.emit('mid_setup:confirm', { cells: cands.slice(0, s.config.POISON_MID) }), 30);
  }
  if (s.phase !== 'MID_SETUP') midSetupSent[label] = false;

  if (s.phase === 'END' && !done) {
    done = true;
    sawEnd = { winner: s.winner, reason: s.endReason };
    console.log('=== GAME END (완전 잠수 시나리오) ===', JSON.stringify(sawEnd));
    setTimeout(() => finish(), 300);
  }
}

function finish() {
  console.log('errors:', errors.length ? errors : 'none');
  console.log('A가 받은 팝업 수:', sawPopups.A.length, '/ B가 받은 팝업 수:', sawPopups.B.length);
  const ok = errors.length === 0 && sawEnd != null && (sawPopups.A.length > 0 || sawPopups.B.length > 0);
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}

(async () => {
  await new Promise((resolve) => {
    const s = io(URL, { reconnection: false, forceNew: true });
    s.on('connect', () => { s.emit('admin:reset'); setTimeout(() => { s.close(); resolve(); }, 300); });
  });
  connectPlayer('A');
  setTimeout(() => connectPlayer('B'), 100);
})();

setTimeout(() => {
  if (!done) {
    console.error('TIMEOUT — 완전 잠수 시나리오가 END까지 못 갔습니다. errors:', errors);
    process.exit(1);
  }
}, 180000);
