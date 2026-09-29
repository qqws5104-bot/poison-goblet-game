// 승자 힌트(ROW_COUNT/COL_COUNT) 보상에서 "가문의 문장"을 그리핀/사자/드래곤 세트별로
// 골라서 정찰할 수 있게 한 변경(CLUE_CATS = CREST_1/2/3)이 실제로 동작하는지 집중적으로
// 검증하는 스크립트. test_sim.js는 보상 종류를 무작위로 고르기 때문에 ROW_COUNT/COL_COUNT +
// CREST_x 조합을 안정적으로 때리지 못했다(15라운드 동안 한 번도 실제 사용까지 못 감) —
// 이 스크립트는 그 조합을 강제로 고르고 실제로 즉시 사용해서 결과를 확인한다.
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const ROWS_FIRST_HALF = 4;
let states = { A: null, B: null };
let done = false;
let errors = [];
let rowColCrestResults = []; // { kind, targetType, counts }

function connectPlayer(label) {
  const socket = io(URL, { reconnection: false, forceNew: true });
  socket.on('connect_error', (e) => errors.push(`${label} connect_error ${e.message}`));
  socket.on('state', (s) => { states[label] = s; onState(label, socket, s); });
  socket.on('error', ({ message }) => {
    errors.push(`${label} ERR ${message}`);
    const s = states[label];
    if (s && s.phase === 'MID_SETUP') setTimeout(() => onState(label, socket, s), 20);
  });
  socket.on('rewardResult', (payload) => {
    console.log('[REWARD]', label, JSON.stringify(payload));
    if (payload.kind === 'ROW_COUNT' || payload.kind === 'COL_COUNT') rowColCrestResults.push({ label, ...payload });
  });
  return socket;
}

let setupSent = { A: false, B: false };
let midSetupSent = { A: false, B: false };
let rewardChosen = { A: false, B: false };
let rewardUsed = { A: false, B: false };
let crestTargetCycle = 0;

function onState(label, socket, s) {
  if (s.phase === 'SETUP' && !setupSent[label]) {
    setupSent[label] = true;
    const cells = [];
    for (let r = 0; r < ROWS_FIRST_HALF && cells.length < (s.config.POISON_INITIAL || 3); r++) {
      for (let c = 0; c < 6 && cells.length < (s.config.POISON_INITIAL || 3); c++) cells.push({ row: r, col: c });
    }
    setTimeout(() => socket.emit('setup:confirm', { cells }), 30);
  }
  if (s.phase === 'MID_SETUP' && !midSetupSent[label] && s.oppOpenedMask) {
    midSetupSent[label] = true;
    const mask = s.oppOpenedMask;
    const candidates = [];
    for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) candidates.push({ row: r, col: c });
    setTimeout(() => socket.emit('mid_setup:confirm', { cells: candidates.slice(0, s.config.POISON_MID) }), 30);
  }
  if (s.phase !== 'MID_SETUP') midSetupSent[label] = false;

  if (s.phase === 'ROUND_ACTION' && s.isMyTurn && s.opensRemaining > 0) {
    const room = s.me.room;
    const cands = [];
    for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened && !room[r][c].locked) cands.push({ row: r, col: c });
    if (cands.length) setTimeout(() => socket.emit('action:open', cands[Math.floor(Math.random() * cands.length)]), 30);
  }

  if (s.phase === 'ROUND_MINIGAME' && s.minigame && s.minigame.public) {
    const mg = s.minigame.public, type = s.minigame.type;
    setTimeout(() => {
      if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 });
      if (type === 'HAND' && mg.waitingForMe) socket.emit('minigame:move', { hand: 'L' });
      if (type === 'REFLEX' && !mg.myClicked && mg.goFired) socket.emit('minigame:move', { action: 'CLICK' });
      if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
      if (type === 'PIN' && mg.myTurn) {
        const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
        if (remaining.length) socket.emit('minigame:move', { action: 'PICK', index: remaining[0] });
      }
      if (type === 'SIGIL' && mg.waitingForMe) socket.emit('minigame:move', { pick: ['SWORD', 'POISON', 'SHIELD'][Math.floor(Math.random() * 3)] });
      if (type === 'GUESS_COUNT' && mg.myGuess == null) socket.emit('minigame:move', { guess: mg.trueCount });
      if (type === 'CARD_DUEL' && mg.waitingForMe) socket.emit('minigame:move', { arrangement: [1, 2, 3].sort(() => Math.random() - 0.5) });
      if (type === 'PACT' && mg.waitingForMe) socket.emit('minigame:move', { action: 'SILENT' });
      if (type === 'BANK') socket.emit('minigame:move', { guess: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3) });
    }, 30);
  }

  // 보상 후보가 뜨면 ROW_COUNT/COL_COUNT를 최우선으로 강제 선택(있으면), 없으면 아무거나.
  if (s.phase === 'ROUND_ACTION' && s.myReward && !s.myReward.type && !rewardChosen[label]) {
    rewardChosen[label] = true;
    const choices = s.myReward.choices || [];
    const pick = choices.find((c) => c.type === 'ROW_COUNT') || choices.find((c) => c.type === 'COL_COUNT') || choices[0];
    if (pick) setTimeout(() => socket.emit('reward:choose', { type: pick.type }), 20);
  }
  if (!(s.myReward && !s.myReward.type)) rewardChosen[label] = false;

  // ROW_COUNT/COL_COUNT면 CREST_1/2/3을 돌아가며 강제 지정, 그 외 타입은 대충 처리.
  if (s.phase === 'ROUND_ACTION' && s.myReward && s.myReward.type && !s.myReward.used && !rewardUsed[label]) {
    rewardUsed[label] = true;
    const r = s.myReward;
    setTimeout(() => {
      if (r.type === 'FLASH_ALL') return socket.emit('reward:use', {});
      if (r.type === 'PEEK_CELL') {
        const activeRows = (s.me.room[s.config.ROWS_FIRST_HALF] && s.me.room[s.config.ROWS_FIRST_HALF][0].locked) ? s.config.ROWS_FIRST_HALF : s.config.ROWS_TOTAL;
        return socket.emit('reward:use', { row: Math.floor(Math.random() * activeRows), col: Math.floor(Math.random() * 6) });
      }
      if (r.type === 'ROW_COUNT' || r.type === 'COL_COUNT') {
        const cats = ['CREST_1', 'CREST_2', 'CREST_3'];
        const targetType = cats[crestTargetCycle % cats.length];
        crestTargetCycle += 1;
        console.log(`[TEST] ${label} forcing reward:use type=${r.type} targetType=${targetType}`);
        return socket.emit('reward:use', { targetType });
      }
    }, 30);
  }
  if (s.phase !== 'ROUND_ACTION' || !s.myReward || !s.myReward.type) rewardUsed[label] = false;

  if (s.phase === 'END' && !done) {
    done = true;
    console.log('=== GAME END ===');
    console.log('ROW_COUNT/COL_COUNT results captured:', rowColCrestResults.length);
    rowColCrestResults.forEach((r) => console.log('  ->', JSON.stringify(r)));
    console.log('errors:', errors.length ? errors : 'none');
    const ok = errors.length === 0 && rowColCrestResults.length > 0;
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    setTimeout(() => process.exit(ok ? 0 : 1), 200);
  }
}

connectPlayer('A');
setTimeout(() => connectPlayer('B'), 100);

setTimeout(() => {
  if (!done) {
    console.error('TIMEOUT — errors so far:', errors);
    console.error('ROW_COUNT/COL_COUNT results captured so far:', rowColCrestResults.length);
    process.exit(1);
  }
}, 90000);
