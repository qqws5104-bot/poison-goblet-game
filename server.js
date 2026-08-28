// ============================================================================
// 당신의 술잔에 독배를 — 2인 밸런스 테스트 프로토타입 서버
// 두 대의 컴퓨터가 같은 네트워크에서 이 서버(하나만 실행)에 브라우저로 접속합니다.
// ============================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const CONFIG = {
  GRID: 6,
  COUNTS: { P: 3, G: 4, S: 5, A: 6, E: 18 }, // 독/금/은/해독제/빈칸
  GOLD_PTS: 2,
  SILVER_PTS: 1,
  ANTIDOTE_NEED: 2,       // 해독제 2개 = 독 1개 무효화
  POISON_LIMIT: 3,        // 독 3개 = 즉시 패배
  TIME_LIMIT_SEC: 600,    // 본게임 제한시간(테스트 편의상 10분, 필요시 조정)
  INVENTORY_CAP: 3,
  NIM_LIMIT: 15,          // 독배 채우기: 이 숫자에 도달/초과시키면 그 사람이 패배
  BOMB_FUSE_MIN: 3, BOMB_FUSE_MAX: 7,
  PIN_POP_MIN: 3, PIN_POP_MAX: 8,
  CARD_MAX: 5,
};

const MINIGAME_SEQUENCE = ['NIM', 'HAND', 'CARD', 'BOMB', 'PIN'];
const MINIGAME_NAMES = {
  NIM: '독배 채우기', HAND: '독 든 손 맞히기', CARD: '거짓 카드 건네기',
  BOMB: '폭탄 눈치 넘기기', PIN: '안전핀 뽑기 배팅',
};
const ITEM_NAMES = { SPOON: '은수저', NOSE: '소믈리에의 코', WARD: '해독의 부적', SWAP: '잔 바꿔치기' };
const CLUE_CATS = ['P', 'G', 'S', 'A'];
const CLUE_CAT_NAMES = { P: '독 술잔', G: '금 술잔', S: '은 술잔', A: '해독제' };
const CELL_NAMES = { P: '독 술잔', G: '금 술잔', S: '은 술잔', A: '해독제', E: '빈 칸' };

// 밸런스 테스트 편의를 위해 환경변수로 숫자 설정값을 덮어쓸 수 있게 함
// 예: TIME_LIMIT_SEC=120 NIM_LIMIT=21 node server.js
for (const key of Object.keys(CONFIG)) {
  if (typeof CONFIG[key] === 'number' && process.env[key] !== undefined) {
    const v = Number(process.env[key]);
    if (!Number.isNaN(v)) CONFIG[key] = v;
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// ------------------------------ 상태 ---------------------------------------
function makeRoom() {
  const cells = [];
  for (let r = 0; r < CONFIG.GRID; r++) {
    const row = [];
    for (let c = 0; c < CONFIG.GRID; c++) row.push({ type: null, opened: false, cluedType: null, cluedNote: null });
    cells.push(row);
  }
  return cells;
}
function newPlayer(id, name) {
  return {
    id, name, room: makeRoom(),
    poison: 0, antidote: 0, score: 0,
    items: [], shield: false, decoyNextClue: false, connected: true,
  };
}
function freshMatch() {
  return {
    phase: 'LOBBY', // LOBBY, SETUP, ROUND_MINIGAME, ROUND_ACTION, END
    players: {}, order: [],
    setupSelections: {},
    round: 0, minigameIndex: 0, minigame: null,
    priorityOrder: [], turnIndex: 0,
    startTime: null, timeLimit: CONFIG.TIME_LIMIT_SEC,
    log: [], winner: null, endReason: null,
  };
}
let match = freshMatch();

function otherId(id) { return match.order.find((x) => x !== id); }
function log(msg) { match.log.push({ t: Date.now(), msg }); if (match.log.length > 300) match.log.shift(); io.emit('log', { msg }); }
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

// ------------------------------ 셋업 -----------------------------------------
function startSetup() {
  match.phase = 'SETUP';
  match.setupSelections = {};
  log('셋업 시작 — 상대 왕자의 처소에 독 술잔 3개를 몰래 지정하세요.');
  broadcastState();
}

function finalizeSetup() {
  // setupSelections[id] = 그 플레이어가 "상대방" 방에 지정한 독 좌표 3개
  for (const id of match.order) {
    const victim = otherId(id);
    const poisonCells = match.setupSelections[id];
    const room = match.players[victim].room;
    for (const { row, col } of poisonCells) room[row][col].type = 'P';
  }
  // 나머지 33칸에 금4·은5·해독제6·빈칸18 랜덤 배치
  for (const id of match.order) {
    const room = match.players[id].room;
    const pool = shuffle([
      ...Array(CONFIG.COUNTS.G).fill('G'),
      ...Array(CONFIG.COUNTS.S).fill('S'),
      ...Array(CONFIG.COUNTS.A).fill('A'),
      ...Array(CONFIG.COUNTS.E).fill('E'),
    ]);
    let k = 0;
    for (let r = 0; r < CONFIG.GRID; r++) {
      for (let c = 0; c < CONFIG.GRID; c++) {
        if (room[r][c].type === null) room[r][c].type = pool[k++];
      }
    }
  }
  log('양쪽 처소 구성 완료. 본게임을 시작합니다.');
  match.startTime = Date.now();
  match.round = 0;
  startRound();
}

// ------------------------------ 라운드 / 미니게임 ----------------------------
function startRound() {
  match.round += 1;
  const type = MINIGAME_SEQUENCE[match.minigameIndex % MINIGAME_SEQUENCE.length];
  match.minigameIndex += 1;
  match.phase = 'ROUND_MINIGAME';
  match.minigame = initMinigame(type, match.round);
  log(`--- ${match.round}라운드 : 우선권 미니게임 [${MINIGAME_NAMES[type]}] ---`);
  broadcastState();
}

function initMinigame(type, roundNo) {
  const [a, b] = match.order;
  const firstIsA = roundNo % 2 === 1; // 라운드마다 선공 교대
  const base = { type, moves: {}, result: null };
  if (type === 'NIM') {
    return { ...base, count: 0, turn: firstIsA ? a : b, limit: CONFIG.NIM_LIMIT };
  }
  if (type === 'HAND') {
    return { ...base, hider: firstIsA ? a : b, guesser: firstIsA ? b : a, hiderPick: null, guesserPick: null };
  }
  if (type === 'CARD') {
    const trueVal = randInt(1, CONFIG.CARD_MAX);
    return { ...base, presenter: firstIsA ? a : b, guesser: firstIsA ? b : a, trueVal, declared: null, declaredIsTruth: null, guess: null };
  }
  if (type === 'BOMB') {
    return { ...base, holder: firstIsA ? a : b, fuse: randInt(CONFIG.BOMB_FUSE_MIN, CONFIG.BOMB_FUSE_MAX), passes: 0 };
  }
  if (type === 'PIN') {
    return { ...base, turn: firstIsA ? a : b, pulls: 0, popAt: randInt(CONFIG.PIN_POP_MIN, CONFIG.PIN_POP_MAX) };
  }
  return base;
}

function endMinigame(winnerId) {
  const loserId = otherId(winnerId);
  match.minigame.result = winnerId;
  match.priorityOrder = [winnerId, loserId];
  match.turnIndex = 0;
  match.phase = 'ROUND_ACTION';
  log(`미니게임 승리: ${match.players[winnerId].name} → 이번 라운드 우선권 획득`);
  broadcastState();
}

function handleMinigameMove(id, payload) {
  if (match.phase !== 'ROUND_MINIGAME') return; // 이미 종료/전환된 미니게임으로 오는 지연 메시지 무시
  const mg = match.minigame;
  if (!mg) return;
  if (mg.type === 'NIM') return handleNim(id, payload, mg);
  if (mg.type === 'HAND') return handleHand(id, payload, mg);
  if (mg.type === 'CARD') return handleCard(id, payload, mg);
  if (mg.type === 'BOMB') return handleBomb(id, payload, mg);
  if (mg.type === 'PIN') return handlePin(id, payload, mg);
}

// 1) 독배 채우기 — Nim류 (번갈아 1~3 더하기, 한도 도달/초과시키면 패배). 정보 완전공개(계산형)
function handleNim(id, payload, mg) {
  if (mg.turn !== id) return;
  const n = Number(payload && payload.n);
  if (![1, 2, 3].includes(n)) return;
  mg.count += n;
  log(`${match.players[id].name}: 독배에 ${n}칸 채움 (누적 ${mg.count}/${mg.limit})`);
  if (mg.count >= mg.limit) { broadcastState(); return endMinigame(otherId(id)); }
  mg.turn = otherId(id);
  broadcastState();
}

// 2) 독 든 손 맞히기 — 관찰/블러핑형(숨김정보 소량)
function handleHand(id, payload, mg) {
  if (id === mg.hider && mg.hiderPick == null) {
    if (!['L', 'R'].includes(payload.hand)) return;
    mg.hiderPick = payload.hand;
    log(`${match.players[mg.hider].name}이 손을 숨겼습니다.`);
  } else if (id === mg.guesser && mg.guesserPick == null) {
    if (!['L', 'R'].includes(payload.hand)) return;
    mg.guesserPick = payload.hand;
    log(`${match.players[mg.guesser].name}이 ${payload.hand === 'L' ? '왼손' : '오른손'}을 지목했습니다.`);
  }
  broadcastState();
  if (mg.hiderPick != null && mg.guesserPick != null) {
    const correct = mg.hiderPick === mg.guesserPick;
    log(`정답 공개: 독은 ${mg.hiderPick === 'L' ? '왼손' : '오른손'}에 있었습니다. (${correct ? '맞힘' : '틀림'})`);
    endMinigame(correct ? mg.guesser : mg.hider);
  }
}

// 3) 거짓 카드 건네기 — 진실/거짓 판별형
function handleCard(id, payload, mg) {
  if (id === mg.presenter && mg.declared == null) {
    const declared = Number(payload.declared);
    if (!Number.isInteger(declared) || declared < 1 || declared > CONFIG.CARD_MAX) return;
    mg.declared = declared;
    mg.declaredIsTruth = declared === mg.trueVal;
    log(`${match.players[mg.presenter].name}이 카드 값 "${declared}"을 제시했습니다.`);
  } else if (id === mg.guesser && mg.guess == null && mg.declared != null) {
    if (!['TRUE', 'LIE'].includes(payload.guess)) return;
    mg.guess = payload.guess;
    log(`${match.players[mg.guesser].name}이 "${payload.guess === 'TRUE' ? '진실' : '거짓'}"이라고 판단했습니다.`);
  }
  broadcastState();
  if (mg.declared != null && mg.guess != null) {
    const guessedTruth = mg.guess === 'TRUE';
    const correct = guessedTruth === mg.declaredIsTruth;
    log(`정답 공개: 실제 카드는 "${mg.trueVal}" (제시값은 ${mg.declaredIsTruth ? '진실' : '거짓'}이었습니다). (${correct ? '맞힘' : '틀림'})`);
    endMinigame(correct ? mg.guesser : mg.presenter);
  }
}

// 4) 폭탄 눈치 넘기기 — 숨겨진 퓨즈 길이(확률/눈치형)
function handleBomb(id, payload, mg) {
  if (mg.holder !== id) return;
  if (payload.action !== 'PASS') return;
  mg.passes += 1;
  log(`${match.players[id].name}이 폭탄을 넘겼습니다. (${mg.passes}번째 전달)`);
  if (mg.passes >= mg.fuse) {
    const nextHolder = otherId(id);
    log(`펑! 폭탄이 ${match.players[nextHolder].name}의 손에서 터졌습니다.`);
    broadcastState();
    return endMinigame(id); // 터진 사람이 패배 → 안 터진 사람(마지막으로 넘긴 id)이 승리
  }
  mg.holder = otherId(id);
  broadcastState();
}

// 5) 안전핀 뽑기 배팅 — 숨겨진 팝 포인트(순수 확률형)
function handlePin(id, payload, mg) {
  if (mg.turn !== id) return;
  if (payload.action !== 'PULL') return;
  mg.pulls += 1;
  log(`${match.players[id].name}이 안전핀을 뽑았습니다. (${mg.pulls}번째)`);
  if (mg.pulls >= mg.popAt) {
    log('펑! 이번 핀에서 터졌습니다.');
    broadcastState();
    return endMinigame(otherId(id));
  }
  mg.turn = otherId(id);
  broadcastState();
}

// ------------------------------ 본행동(액션) ---------------------------------
function doAction(id, kind, payload) {
  if (match.phase !== 'ROUND_ACTION') return;
  const activeId = match.priorityOrder[match.turnIndex];
  if (activeId !== id) return;
  const player = match.players[id];

  if (kind === 'ITEM_GET') {
    const itemType = payload.itemType;
    if (!ITEM_NAMES[itemType]) return;
    if (player.items.length >= CONFIG.INVENTORY_CAP) {
      io.to(id).emit('error', { message: '아이템 보관함이 가득 찼습니다 (최대 ' + CONFIG.INVENTORY_CAP + '개).' });
      return;
    }
    player.items.push(itemType);
    log(`${player.name}: 아이템 획득 — ${ITEM_NAMES[itemType]}`);
    afterAction();
    return;
  }

  if (kind === 'CLUE') {
    const cat = payload.category;
    if (!CLUE_CATS.includes(cat)) return;
    resolveClue(player, cat);
    afterAction();
    return;
  }

  if (kind === 'OPEN') {
    const { row, col } = payload;
    if (row < 0 || row >= CONFIG.GRID || col < 0 || col >= CONFIG.GRID) return;
    const cell = player.room[row][col];
    if (cell.opened) return;
    resolveOpen(player, row, col, cell);
    afterAction();
    return;
  }

  if (kind === 'ITEM_USE') {
    const { itemType, target } = payload;
    const idx = player.items.indexOf(itemType);
    if (idx === -1) return;
    if (!applyItem(player, itemType, target)) return; // 실패 시(잘못된 타겟 등) 턴 소모 안 함
    player.items.splice(idx, 1);
    afterAction();
    return;
  }
}

function resolveClue(player, cat) {
  const room = player.room;
  const unknownCells = [];
  for (let r = 0; r < CONFIG.GRID; r++)
    for (let c = 0; c < CONFIG.GRID; c++) {
      const cell = room[r][c];
      if (cell.type === cat && !cell.opened && !cell.cluedType) unknownCells.push({ r, c });
    }
  if (unknownCells.length === 0) {
    log(`${player.name}: [${CLUE_CAT_NAMES[cat]}] 단서 뽑기 — 더 이상 알아낼 정보가 없습니다.`);
    return;
  }
  // 잔 바꿔치기로 오염된 경우: 실제로는 다른(엉뚱한) 좌표/거짓 정보를 알려준다
  const poisoned = player.decoyNextClue;
  if (poisoned) player.decoyNextClue = false;

  const roll = Math.random();
  let clueType = roll < 0.25 ? 'exact' : roll < 0.5 ? 'row' : roll < 0.75 ? 'col' : 'quad';
  const pick = unknownCells[randInt(0, unknownCells.length - 1)];

  if (poisoned) {
    // 거짓 좌표: 실제 pick과 무관한, 그 타입이 아닐 가능성이 높은 랜덤 칸 정보를 진짜인 것처럼 알려준다
    const fr = randInt(0, CONFIG.GRID - 1), fc = randInt(0, CONFIG.GRID - 1);
    if (clueType === 'exact') {
      room[fr][fc].cluedNote = `(교란) ${CLUE_CAT_NAMES[cat]} 위치로 안내됨`;
      io.to(player.id).emit('clueResult', { text: `[${CLUE_CAT_NAMES[cat]}] 정확한 위치: ${fr + 1}행 ${fc + 1}열 (※ 정보가 오염되었을 수 있습니다)` });
    } else if (clueType === 'row') {
      io.to(player.id).emit('clueResult', { text: `[${CLUE_CAT_NAMES[cat]}]가 ${fr + 1}행에 있습니다. (※ 정보가 오염되었을 수 있습니다)` });
    } else if (clueType === 'col') {
      io.to(player.id).emit('clueResult', { text: `[${CLUE_CAT_NAMES[cat]}]가 ${fc + 1}열에 있습니다. (※ 정보가 오염되었을 수 있습니다)` });
    } else {
      const quad = quadrantOf(fr, fc);
      io.to(player.id).emit('clueResult', { text: `[${CLUE_CAT_NAMES[cat]}]가 ${quad} 구역에 있습니다. (※ 정보가 오염되었을 수 있습니다)` });
    }
    log(`${player.name}: [${CLUE_CAT_NAMES[cat]}] 단서 뽑기 (누군가 정보를 조작했을 수도?)`);
    return;
  }

  if (clueType === 'exact') {
    room[pick.r][pick.c].cluedType = cat;
    io.to(player.id).emit('clueResult', { text: `[${CLUE_CAT_NAMES[cat]}] 정확한 위치: ${pick.r + 1}행 ${pick.c + 1}열` });
    log(`${player.name}: [${CLUE_CAT_NAMES[cat]}] 단서 뽑기 → 정확한 좌표 확인`);
  } else if (clueType === 'row') {
    io.to(player.id).emit('clueResult', { text: `[${CLUE_CAT_NAMES[cat]}]가 ${pick.r + 1}행 어딘가에 있습니다.` });
    log(`${player.name}: [${CLUE_CAT_NAMES[cat]}] 단서 뽑기 → 행 정보 확인`);
  } else if (clueType === 'col') {
    io.to(player.id).emit('clueResult', { text: `[${CLUE_CAT_NAMES[cat]}]가 ${pick.c + 1}열 어딘가에 있습니다.` });
    log(`${player.name}: [${CLUE_CAT_NAMES[cat]}] 단서 뽑기 → 열 정보 확인`);
  } else {
    const quad = quadrantOf(pick.r, pick.c);
    io.to(player.id).emit('clueResult', { text: `[${CLUE_CAT_NAMES[cat]}]가 ${quad} 구역 어딘가에 있습니다.` });
    log(`${player.name}: [${CLUE_CAT_NAMES[cat]}] 단서 뽑기 → 구역 정보 확인`);
  }
}

function quadrantOf(r, c) {
  const half = CONFIG.GRID / 2;
  const v = r < half ? '상단' : '하단';
  const h = c < half ? '좌측' : '우측';
  return v + h;
}

function resolveOpen(player, row, col, cell) {
  cell.opened = true;
  const t = cell.type;
  log(`${player.name}: 술잔 고르기 → (${row + 1},${col + 1}) = ${CELL_NAMES[t]}`);
  if (t === 'P') {
    if (player.shield) {
      player.shield = false;
      log(`${player.name}: 해독의 부적이 독을 대신 막았습니다!`);
    } else {
      player.poison += 1;
      checkNeutralize(player);
    }
  } else if (t === 'G') {
    player.score += CONFIG.GOLD_PTS;
  } else if (t === 'S') {
    player.score += CONFIG.SILVER_PTS;
  } else if (t === 'A') {
    player.antidote += 1;
    checkNeutralize(player);
  }
  checkInstantLoss(player);
}

function checkNeutralize(player) {
  while (player.poison > 0 && player.antidote >= CONFIG.ANTIDOTE_NEED) {
    player.poison -= 1;
    player.antidote -= CONFIG.ANTIDOTE_NEED;
    log(`${player.name}: 해독제 ${CONFIG.ANTIDOTE_NEED}개로 독 1개 무효화!`);
  }
}

function checkInstantLoss(player) {
  if (player.poison >= CONFIG.POISON_LIMIT) {
    const winner = otherId(player.id);
    endMatch(`${player.name}이 독 술잔 ${CONFIG.POISON_LIMIT}개를 마셔 즉시 패배`, winner);
  }
}

function applyItem(player, itemType, target) {
  if (itemType === 'SPOON') {
    if (!target) return false;
    const { row, col } = target;
    if (row == null || col == null) return false;
    const cell = player.room[row][col];
    if (cell.opened) return false;
    const isPoison = cell.type === 'P';
    cell.cluedNote = isPoison ? '독!' : '안전';
    io.to(player.id).emit('clueResult', { text: `은수저: (${row + 1},${col + 1})은 ${isPoison ? '독 술잔입니다!' : '독이 아닙니다.'}` });
    log(`${player.name}: 은수저 사용 → (${row + 1},${col + 1}) 확인`);
    return true;
  }
  if (itemType === 'NOSE') {
    if (!target || !['row', 'col'].includes(target.axis)) return false;
    const idx = Number(target.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= CONFIG.GRID) return false;
    let count = 0;
    for (let i = 0; i < CONFIG.GRID; i++) {
      const cell = target.axis === 'row' ? player.room[idx][i] : player.room[i][idx];
      if (cell.type === 'P') count += 1;
    }
    const label = target.axis === 'row' ? `${idx + 1}행` : `${idx + 1}열`;
    io.to(player.id).emit('clueResult', { text: `소믈리에의 코: ${label}에 독 술잔이 ${count}개 있습니다.` });
    log(`${player.name}: 소믈리에의 코 사용 → ${label} 독 개수 확인`);
    return true;
  }
  if (itemType === 'WARD') {
    player.shield = true;
    log(`${player.name}: 해독의 부적 장착 — 다음 독을 자동으로 막아줍니다.`);
    return true;
  }
  if (itemType === 'SWAP') {
    const opp = match.players[otherId(player.id)];
    opp.decoyNextClue = true;
    log(`${player.name}: 잔 바꿔치기 사용 — 상대의 다음 단서를 조작했습니다.`);
    return true;
  }
  return false;
}

// ------------------------------ 라운드 진행/종료 -----------------------------
function afterAction() {
  broadcastState();
  if (match.phase !== 'ROUND_ACTION') return; // 즉시패배 등으로 이미 종료됨
  if (match.turnIndex === 0) {
    match.turnIndex = 1;
    broadcastState();
  } else {
    // 라운드 종료
    if (checkTimeUp()) return;
    startRound();
  }
}

function checkTimeUp() {
  if (!match.startTime) return false;
  const elapsed = (Date.now() - match.startTime) / 1000;
  if (elapsed >= match.timeLimit) {
    const [a, b] = match.order;
    const pa = match.players[a], pb = match.players[b];
    let winner = null, reason;
    if (pa.score !== pb.score) {
      winner = pa.score > pb.score ? a : b;
      reason = '제한시간 종료 — 술잔 점수 비교 승리';
    } else if (pa.poison !== pb.poison) {
      winner = pa.poison < pb.poison ? a : b;
      reason = '제한시간 종료 — 점수 동률, 독 개수 적은 쪽 승리';
    } else {
      reason = '제한시간 종료 — 완전 동률(무승부)';
    }
    endMatch(reason, winner);
    return true;
  }
  return false;
}

function endMatch(reason, winnerId) {
  match.phase = 'END';
  match.winner = winnerId || null;
  match.endReason = reason;
  log(`=== 게임 종료: ${reason}${winnerId ? ` (승자: ${match.players[winnerId].name})` : ''} ===`);
  broadcastState();
}

// ------------------------------ 소켓 -----------------------------------------
function buildClientState(forId) {
  const me = match.players[forId];
  const oppId = otherId(forId);
  const opp = oppId ? match.players[oppId] : null;
  const sanitizeRoom = (room, revealAll) =>
    room.map((row) => row.map((cell) => ({
      opened: cell.opened,
      type: cell.opened || revealAll ? cell.type : (cell.cluedType || null),
      note: cell.cluedNote || null,
    })));

  return {
    phase: match.phase,
    round: match.round,
    minigame: match.minigame && {
      type: match.minigame.type,
      name: MINIGAME_NAMES[match.minigame.type],
      // 클라이언트에 필요한 진행상황만 노출 (히든정보 보호)
      public: publicMinigameView(match.minigame, forId),
    },
    priorityOrder: match.priorityOrder.map((id) => (id === forId ? 'me' : 'opp')),
    turnIndex: match.turnIndex,
    isMyTurn: match.phase === 'ROUND_ACTION' && match.priorityOrder[match.turnIndex] === forId,
    me: me && {
      name: me.name, poison: me.poison, antidote: me.antidote, score: me.score,
      items: me.items, shield: me.shield,
      room: sanitizeRoom(me.room, match.phase === 'END'),
    },
    opp: opp && {
      name: opp.name, poison: opp.poison, antidote: opp.antidote, score: opp.score,
      itemCount: opp.items.length, shield: opp.shield, connected: opp.connected,
      room: match.phase === 'END' ? sanitizeRoom(opp.room, true) : null,
    },
    setupDone: match.order.reduce((acc, id) => { acc[id === forId ? 'me' : 'opp'] = !!match.setupSelections[id]; return acc; }, {}),
    timeLimit: match.timeLimit,
    startTime: match.startTime,
    winner: match.winner ? (match.winner === forId ? 'me' : 'opp') : (match.phase === 'END' ? 'draw' : null),
    endReason: match.endReason,
    config: CONFIG,
    itemNames: ITEM_NAMES,
    clueCatNames: CLUE_CAT_NAMES,
    playersConnected: match.order.length,
  };
}

function publicMinigameView(mg, forId) {
  const mine = (pid) => pid === forId;
  if (mg.type === 'NIM') return { count: mg.count, limit: mg.limit, myTurn: mg.turn === forId };
  if (mg.type === 'HAND') {
    const role = mine(mg.hider) ? 'hider' : mine(mg.guesser) ? 'guesser' : null;
    return { role, waitingForMe: (role === 'hider' && mg.hiderPick == null) || (role === 'guesser' && mg.hiderPick != null && mg.guesserPick == null), hiderDone: mg.hiderPick != null };
  }
  if (mg.type === 'CARD') {
    const role = mine(mg.presenter) ? 'presenter' : mine(mg.guesser) ? 'guesser' : null;
    return {
      role, trueVal: role === 'presenter' ? mg.trueVal : null,
      declared: mg.declared, waitingForMe: (role === 'presenter' && mg.declared == null) || (role === 'guesser' && mg.declared != null && mg.guess == null),
    };
  }
  if (mg.type === 'BOMB') return { passes: mg.passes, myTurn: mg.holder === forId };
  if (mg.type === 'PIN') return { pulls: mg.pulls, myTurn: mg.turn === forId };
  return {};
}

function broadcastState() {
  for (const id of match.order) {
    io.to(id).emit('state', buildClientState(id));
  }
}

io.on('connection', (socket) => {
  if (match.order.length >= 2 && !match.order.includes(socket.id)) {
    socket.emit('full');
    return;
  }
  const isNew = !match.order.includes(socket.id);
  if (isNew) {
    const name = match.order.length === 0 ? '장남' : '차남';
    match.players[socket.id] = newPlayer(socket.id, name);
    match.order.push(socket.id);
    socket.join(socket.id);
    log(`${name}(이)가 궁에 입장했습니다.`);
  }
  broadcastState();

  if (match.order.length === 2 && match.phase === 'LOBBY') startSetup();

  socket.on('disconnect', () => {
    if (match.players[socket.id]) {
      match.players[socket.id].connected = false;
      log(`${match.players[socket.id].name} 연결 끊김`);
      broadcastState();
    }
  });

  socket.on('setup:confirm', (payload) => {
    if (match.phase !== 'SETUP') return;
    const cells = Array.isArray(payload && payload.cells) ? payload.cells : [];
    if (cells.length !== CONFIG.COUNTS.P) return socket.emit('error', { message: `정확히 ${CONFIG.COUNTS.P}칸을 선택해야 합니다.` });
    const seen = new Set();
    for (const cell of cells) {
      if (cell.row < 0 || cell.row >= CONFIG.GRID || cell.col < 0 || cell.col >= CONFIG.GRID)
        return socket.emit('error', { message: '유효하지 않은 좌표입니다.' });
      seen.add(cell.row + '_' + cell.col);
    }
    if (seen.size !== CONFIG.COUNTS.P) return socket.emit('error', { message: '중복되지 않게 선택해야 합니다.' });
    match.setupSelections[socket.id] = cells;
    log(`${match.players[socket.id].name} 독 설치 완료`);
    broadcastState();
    if (match.order.every((id) => match.setupSelections[id])) finalizeSetup();
  });

  socket.on('minigame:move', (payload) => handleMinigameMove(socket.id, payload || {}));
  socket.on('action:item_get', (p) => doAction(socket.id, 'ITEM_GET', p || {}));
  socket.on('action:clue', (p) => doAction(socket.id, 'CLUE', p || {}));
  socket.on('action:open', (p) => doAction(socket.id, 'OPEN', p || {}));
  socket.on('action:item_use', (p) => doAction(socket.id, 'ITEM_USE', p || {}));

  socket.on('admin:end', () => { if (match.phase !== 'END') endMatch('관리자가 조기 종료함'); });
  socket.on('admin:reset', () => { match = freshMatch(); broadcastState(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`당신의 술잔에 독배를 — 프로토타입 서버 실행 중: http://localhost:${PORT}`);
  console.log('같은 네트워크의 다른 컴퓨터에서는 이 컴퓨터의 IP로 접속하세요 (예: http://192.168.0.5:3000)');
});
