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
  POISON_PENALTY: 3,      // 종료 시, 무효화되지 않은 독 1개당 -3점
  ROUNDS: 10,             // 총 라운드 수 (고정)
  OPENS_PER_TURN: 2,      // 본행동: 내 턴마다 내 처소에서 열 술잔 개수
  NIM_LIMIT_MIN: 12, NIM_LIMIT_MAX: 20, // 독배 채우기: 이 숫자(매판 무작위)에 도달/초과시키면 그 사람이 패배
  BOMB_FUSE_MS_MIN: 30000, BOMB_FUSE_MS_MAX: 60000, // 폭탄 눈치 넘기기: 실시간(ms) 퓨즈 — 이 시간 후 터짐
  PIN_POP_MIN: 3, PIN_POP_MAX: 8,
  BANK_DIGITS: 3,         // 금고 번호 맞추기: 서로 다른 숫자 몇 자리
  REWARD_FLASH_MS: 30000,       // 섬광 정찰 보상: 이 시간(ms) 안의 무작위 순간에 자동 발동
  REWARD_FLASH_REVEAL_MS: 500, // 섬광 정찰 발동 시 실제로 화면에 드러나 있는 시간(ms)
};

// 배짱 대결(SHOWDOWN)은 "너무 단순한 게임"이라는 피드백으로 제외 — 9종만 남았다.
// 그래도 ROUNDS(10)는 유지하기로 했으므로, 매치마다 9종을 섞은 뒤 하나를 무작위로 한 번 더 채운다(buildMinigameOrder).
const MINIGAME_SEQUENCE = ['NIM', 'HAND', 'REFLEX', 'BOMB', 'PIN', 'SIGIL', 'GUESS_COUNT', 'PARITY', 'BANK', 'MEMORY'];
const MINIGAME_NAMES = {
  NIM: '독배 채우기', HAND: '독 든 손 맞히기', REFLEX: '잔 낚아채기',
  BOMB: '폭탄 눈치 넘기기', PIN: '안전핀 뽑기 배팅',
  SIGIL: '표식 대결', GUESS_COUNT: '탁자 위 술잔 개수 세기', PARITY: '숫자 합 홀짝',
  BANK: '금고 번호 맞추기', MEMORY: '사라진 유품 찾기',
};
// 사라진 유품 찾기(MEMORY): 5개 중 4개를 잠깐 보여준 뒤, 보이지 않았던 1개를 맞히는 기억력 게임.
const MEMORY_POOL = ['CROWN', 'SCROLL', 'DAGGER', 'RING', 'KEY'];
const MEMORY_NAMES_KR = { CROWN: '왕관', SCROLL: '밀서', DAGGER: '단검', RING: '인장 반지', KEY: '열쇠' };
function buildMinigameOrder() {
  const order = shuffle(MINIGAME_SEQUENCE);
  while (order.length < CONFIG.ROUNDS) {
    let pick = MINIGAME_SEQUENCE[randInt(0, MINIGAME_SEQUENCE.length - 1)];
    if (pick === order[order.length - 1]) {
      pick = MINIGAME_SEQUENCE.find((t) => t !== pick) || pick;
    }
    order.push(pick);
  }
  return order;
}
const SIGIL_BEATS = { SWORD: 'POISON', POISON: 'SHIELD', SHIELD: 'SWORD' };
const SIGIL_NAMES_KR = { SWORD: '검', POISON: '독배', SHIELD: '방패' };
const CLUE_CATS = ['P', 'G', 'S', 'A'];
const CLUE_CAT_NAMES = { P: '독 술잔', G: '금 술잔', S: '은 술잔', A: '해독제' };
const CELL_NAMES = { P: '독 술잔', G: '금 술잔', S: '은 술잔', A: '해독제', E: '빈 칸' };

const REWARD_TYPES = ['FLASH_ALL', 'PEEK_CELL', 'ROW_COUNT', 'COL_COUNT'];
const REWARD_NAMES = {
  FLASH_ALL: '철가방 정찰 — 무작위 순간, 내 처소 전체가 뚜껑처럼 확 열렸다가 저절로 잠깐 드러남',
  PEEK_CELL: '한 칸 정찰 — 내 처소 원하는 1칸의 정체 확인',
  ROW_COUNT: '행 정찰 — 내 처소 원하는 행에서 지정한 술잔 개수 확인',
  COL_COUNT: '열 정찰 — 내 처소 원하는 열에서 지정한 술잔 개수 확인',
};

// 밸런스 테스트 편의를 위해 환경변수로 숫자 설정값을 덮어쓸 수 있게 함
// 예: NIM_LIMIT=21 POISON_PENALTY=2 node server.js
for (const key of Object.keys(CONFIG)) {
  if (typeof CONFIG[key] === 'number' && process.env[key] !== undefined) {
    const v = Number(process.env[key]);
    if (!Number.isNaN(v)) CONFIG[key] = v;
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
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
    poison: 0, antidote: 0, score: 0, finalScore: null,
    connected: true,
  };
}
let matchSeq = 0;
function freshMatch() {
  matchSeq += 1;
  return {
    seq: matchSeq, // 새 매치(재대전 포함)마다 증가 — 클라이언트가 화면/입력 상태를 리셋하는 신호로 사용
    phase: 'LOBBY', // LOBBY, SETUP, ROUND_MINIGAME, ROUND_ACTION, END
    players: {}, order: [],
    setupSelections: {},
    setupPreview: {}, // 확정 전 실시간 선택 상태 — 관리자 화면 전용(상대 플레이어에게는 절대 내려주지 않음)
    round: 0, minigameOrder: buildMinigameOrder(), minigame: null,
    roundRewardType: null, pendingReward: null,
    actionOpens: {}, // 라운드 액션(칸 열기)은 이제 순서 교대가 아니라 각자 독립적으로 동시에 진행됨
    rematchReady: {},
    log: [], winner: null, endReason: null,
  };
}
let match = freshMatch();

function otherId(id) { return match.order.find((x) => x !== id); }
function log(msg) { match.log.push({ t: Date.now(), msg }); if (match.log.length > 300) match.log.shift(); io.emit('log', { msg }); }
// 본인 처소의 구체적인 정보(어느 칸에 뭐가 나왔는지 등)는 상대에게 새면 안 되므로,
// 이런 개인 행동 기록은 방송하지 않고 그 플레이어의 state.me.history로만 내려준다.
function actionLog(player, msg) {
  if (!player.history) player.history = [];
  player.history.push({ t: Date.now(), msg });
  if (player.history.length > 40) player.history.shift();
  match.log.push({ t: Date.now(), msg: `(개인) ${player.name}: ${msg}` });
}
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function randomDistinctDigits(n) { return shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, n); }

// ------------------------------ 셋업 -----------------------------------------
function startSetup() {
  match.phase = 'SETUP';
  match.setupSelections = {};
  match.setupPreview = {};
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
  log(`양쪽 처소 구성 완료. 총 ${CONFIG.ROUNDS}라운드의 본게임을 시작합니다.`);
  match.round = 0;
  startRound();
}

// ------------------------------ 라운드 / 미니게임 ----------------------------
function startRound() {
  match.round += 1;
  const type = match.minigameOrder[match.round - 1];
  match.phase = 'ROUND_MINIGAME';
  match.minigame = initMinigame(type, match.round);
  match.pendingReward = null;
  match.roundRewardType = REWARD_TYPES[randInt(0, REWARD_TYPES.length - 1)];
  log(`--- ${match.round}/${CONFIG.ROUNDS}라운드 : 미니게임 [${MINIGAME_NAMES[type]}] · 이번 라운드 보상: ${REWARD_NAMES[match.roundRewardType]} ---`);
  broadcastState();
}

function initMinigame(type, roundNo) {
  const [a, b] = match.order;
  const firstIsA = roundNo % 2 === 1; // 라운드마다 선공 교대
  const base = { type, moves: {}, result: null };
  if (type === 'NIM') {
    // 목표치(limit)를 매 판 15~30 사이에서 무작위로 정하고, 클라이언트에는 이 숫자를 노출하지 않는다
    // (publicMinigameView에서 fillRatio로만 시각화 — 술잔이 차오르는 이미지로만 보여준다).
    return { ...base, count: 0, turn: firstIsA ? a : b, limit: randInt(CONFIG.NIM_LIMIT_MIN, CONFIG.NIM_LIMIT_MAX) };
  }
  if (type === 'HAND') {
    return { ...base, hider: firstIsA ? a : b, guesser: firstIsA ? b : a, hiderPick: null, guesserPick: null };
  }
  if (type === 'REFLEX') {
    // 서버가 무작위 시점에 "신호"를 알려주고, 신호 후 가장 먼저 누른 사람이 승리.
    // 신호 전에 누르면 성급하게 움직인 것으로 간주해 그 자리에서 즉시 패배한다.
    const mgReflex = { ...base, goAt: null, clicks: {} };
    const delay = randInt(2000, 5000);
    setTimeout(() => {
      if (match.minigame === mgReflex && match.phase === 'ROUND_MINIGAME') {
        mgReflex.goAt = Date.now();
        broadcastState();
      }
    }, delay);
    return mgReflex;
  }
  if (type === 'BOMB') {
    // 더 이상 "넘긴 횟수"가 아니라 실시간(ms) 퓨즈로 터진다 — 정해진 시간이 다 되면
    // 그 순간 폭탄을 들고 있는 사람이 진다. 넘기는 횟수는 표시용일 뿐, 승패에는 영향 없음.
    const mgBomb = { ...base, holder: firstIsA ? a : b, passes: 0 };
    const delay = randInt(CONFIG.BOMB_FUSE_MS_MIN, CONFIG.BOMB_FUSE_MS_MAX);
    setTimeout(() => {
      if (match.minigame === mgBomb && match.phase === 'ROUND_MINIGAME') {
        const loser = mgBomb.holder;
        log(`펑! 폭탄이 ${match.players[loser].name}의 손에서 터졌습니다.`);
        broadcastState();
        endMinigame(otherId(loser));
      }
    }, delay);
    return mgBomb;
  }
  if (type === 'PIN') {
    return { ...base, turn: firstIsA ? a : b, pulls: 0, popAt: randInt(CONFIG.PIN_POP_MIN, CONFIG.PIN_POP_MAX) };
  }
  if (type === 'SIGIL') {
    return { ...base, picks: {} };
  }
  if (type === 'GUESS_COUNT') {
    // 너무 쉽다는 피드백 반영: 촛불 개수 범위를 넓히고(눈으로 정확히 세기 어렵게) 노출 시간도 짧게 준다.
    return { ...base, trueCount: randInt(9, 20), guesses: {}, guessOrder: [] };
  }
  if (type === 'PARITY') {
    return { ...base, oddPlayer: firstIsA ? a : b, evenPlayer: firstIsA ? b : a, picks: {} };
  }
  if (type === 'BANK') {
    // 하나의 금고를 공유하는 게 아니라, 두 사람이 각자 자신만의 금고(컴퓨터가 무작위로 정한 서로 다른
    // 정답)를 갖고 동시에 독립적으로 숫자야구를 진행한다 — 자기 금고를 먼저 여는 쪽이 승리.
    return { ...base, secrets: { [a]: randomDistinctDigits(CONFIG.BANK_DIGITS), [b]: randomDistinctDigits(CONFIG.BANK_DIGITS) }, history: { [a]: [], [b]: [] } };
  }
  if (type === 'MEMORY') {
    // "5개 중 안 보인 1개 고르기"는 처음 보는 5번째 항목이 눈에 띄어 너무 쉬웠다 — 진짜 기억력을
    // 요구하도록 재설계: 유품 4개를 먼저 보여준 뒤, 같은 4자리에 그중 하나만 다른 유품으로
    // 바꿔서 다시 보여주고 "무엇이 바뀌었는지" 맞히게 한다.
    const pool = shuffle(MEMORY_POOL); // pool[0..3] = 처음 보여줄 4개, pool[4] = 나중에 등장할 대체 유품
    const before = pool.slice(0, 4);
    const swapIndex = randInt(0, 3);
    const changedItem = pool[4];
    const after = before.slice();
    after[swapIndex] = changedItem;
    return { ...base, before, after, changedItem, revealUntil: Date.now() + 3000, answers: {} };
  }
  return base;
}

function endMinigame(winnerId) {
  const loserId = otherId(winnerId);
  match.minigame.result = winnerId;

  // 보상은 라운드 시작 전에 이미 공개되어 있었고, 이번 라운드 미니게임 승자가 그 보상을 받는다.
  match.pendingReward = {
    type: match.roundRewardType,
    winnerId,
    used: false,
    expiresAt: match.roundRewardType === 'FLASH_ALL' ? Date.now() + CONFIG.REWARD_FLASH_MS : null,
  };

  // 본행동(칸 열기)은 더 이상 순서 교대가 아니라 두 사람이 동시에 독립적으로 진행한다.
  match.actionOpens = {};
  match.phase = 'ROUND_ACTION';
  log(`미니게임 승리: ${match.players[winnerId].name} → 이번 라운드 보상 [${REWARD_NAMES[match.roundRewardType]}] 획득`);

  // 섬광 정찰은 직접 "사용" 버튼을 누르는 게 아니라, 정해진 시간(REWARD_FLASH_MS) 안의
  // 무작위 순간에 자동으로 REWARD_FLASH_REVEAL_MS만큼 내 처소 전체가 드러나는 방식이다.
  // (발동까지 남은 시간은 클라이언트에 알려주지 않는다 — 예측 가능해지면 보상 가치가 떨어짐.)
  if (match.pendingReward.expiresAt) {
    const roundAtGrant = match.round;
    const fireDelay = randInt(0, CONFIG.REWARD_FLASH_MS);
    setTimeout(() => {
      if (match.round === roundAtGrant && match.pendingReward && match.pendingReward.winnerId === winnerId && !match.pendingReward.used) {
        match.pendingReward.used = true;
        const winner = match.players[winnerId];
        const room = winner.room.map((r) => r.map((cell) => cell.type));
        actionLog(winner, `보상 발동 — 섬광 정찰로 내 처소 전체가 ${(CONFIG.REWARD_FLASH_REVEAL_MS / 1000).toFixed(1)}초간 드러났습니다.`);
        io.to(winnerId).emit('rewardResult', { kind: 'FLASH_ALL', room, revealMs: CONFIG.REWARD_FLASH_REVEAL_MS });
        broadcastState();
      }
    }, fireDelay);
  }

  broadcastState();
}

function handleMinigameMove(id, payload) {
  if (match.phase !== 'ROUND_MINIGAME') return; // 이미 종료/전환된 미니게임으로 오는 지연 메시지 무시
  const mg = match.minigame;
  if (!mg) return;
  if (mg.type === 'NIM') return handleNim(id, payload, mg);
  if (mg.type === 'HAND') return handleHand(id, payload, mg);
  if (mg.type === 'REFLEX') return handleReflex(id, payload, mg);
  if (mg.type === 'BOMB') return handleBomb(id, payload, mg);
  if (mg.type === 'PIN') return handlePin(id, payload, mg);
  if (mg.type === 'SIGIL') return handleSigil(id, payload, mg);
  if (mg.type === 'GUESS_COUNT') return handleGuessCount(id, payload, mg);
  if (mg.type === 'PARITY') return handleParity(id, payload, mg);
  if (mg.type === 'BANK') return handleBank(id, payload, mg);
  if (mg.type === 'MEMORY') return handleMemory(id, payload, mg);
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

// 3) 잔 낚아채기 — 서버가 알려주는 신호 후 가장 먼저 반응하는 사람이 승리(반응속도형).
// 신호 전에 누르면 성급하게 움직인 것으로 간주해 즉시 패배한다.
function handleReflex(id, payload, mg) {
  if (mg.clicks[id]) return; // 이미 눌렀음
  if (!mg.goAt) {
    mg.clicks[id] = { early: true, reactMs: null };
    log(`${match.players[id].name}이 신호가 오기 전에 성급하게 잔을 낚아챘습니다!`);
    broadcastState();
    return endMinigame(otherId(id));
  }
  const reactMs = Date.now() - mg.goAt;
  mg.clicks[id] = { early: false, reactMs };
  log(`${match.players[id].name}의 반응 시간: ${reactMs}ms`);
  const [a, b] = match.order;
  if (mg.clicks[a] && mg.clicks[b]) {
    broadcastState();
    const winner = mg.clicks[a].reactMs <= mg.clicks[b].reactMs ? a : b;
    return endMinigame(winner);
  }
  broadcastState();
}

// 4) 폭탄 눈치 넘기기 — 숨겨진 실시간 퓨즈(초 단위, 확률/눈치형). 승패는 initMinigame에 걸린
// setTimeout이 판정하므로, 여기서는 넘기기 동작만 처리한다(넘긴 횟수는 표시용).
function handleBomb(id, payload, mg) {
  if (mg.holder !== id) return;
  if (payload.action !== 'PASS') return;
  mg.passes += 1;
  mg.holder = otherId(id);
  log(`${match.players[id].name}이 폭탄을 넘겼습니다. (${mg.passes}번째 전달)`);
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

// 6) 표식 대결 — 검>독배>방패>검, 동시에 몰래 선택 후 공개(가위바위보류, 순수 심리전)
function handleSigil(id, payload, mg) {
  if (mg.picks[id]) return;
  if (!['SWORD', 'POISON', 'SHIELD'].includes(payload.pick)) return;
  mg.picks[id] = payload.pick;
  const [a, b] = match.order;
  if (mg.picks[a] && mg.picks[b]) {
    log(`표식 공개: ${match.players[a].name}=${SIGIL_NAMES_KR[mg.picks[a]]} vs ${match.players[b].name}=${SIGIL_NAMES_KR[mg.picks[b]]}`);
    if (mg.picks[a] === mg.picks[b]) {
      log('무승부 — 같은 표식을 냈습니다. 다시 냅니다.');
      mg.picks = {};
      broadcastState();
      return;
    }
    broadcastState();
    return endMinigame(SIGIL_BEATS[mg.picks[a]] === mg.picks[b] ? a : b);
  }
  broadcastState();
}

// 7) 촛불 개수 맞히기 — 잠깐 보여준 촛불 개수를 추측, 더 근접한 쪽 승리(관찰/집중형)
function handleGuessCount(id, payload, mg) {
  if (mg.guesses[id] != null) return;
  const g = Number(payload.guess);
  if (!Number.isInteger(g) || g < 0 || g > 20) return;
  mg.guesses[id] = g;
  mg.guessOrder.push(id);
  log(`${match.players[id].name}이 촛불 개수를 ${g}개로 추측했습니다.`);
  const [a, b] = match.order;
  if (mg.guesses[a] != null && mg.guesses[b] != null) {
    log(`정답 공개: 실제 촛불은 ${mg.trueCount}개였습니다.`);
    const da = Math.abs(mg.guesses[a] - mg.trueCount);
    const db = Math.abs(mg.guesses[b] - mg.trueCount);
    broadcastState();
    const winner = da < db ? a : db < da ? b : mg.guessOrder[0];
    return endMinigame(winner);
  }
  broadcastState();
}

// 8) 숫자 합 홀짝 — 동시에 1~3을 선택, 합의 홀/짝으로 승부(계산+확률 혼합형)
function handleParity(id, payload, mg) {
  if (mg.picks[id]) return;
  const n = Number(payload.n);
  if (![1, 2, 3, 4].includes(n)) return;
  mg.picks[id] = n;
  const [a, b] = match.order;
  if (mg.picks[a] && mg.picks[b]) {
    const sum = mg.picks[a] + mg.picks[b];
    const isEven = sum % 2 === 0;
    log(`숫자 공개: ${match.players[a].name}=${mg.picks[a]}, ${match.players[b].name}=${mg.picks[b]} → 합 ${sum} (${isEven ? '짝' : '홀'})`);
    broadcastState();
    return endMinigame(isEven ? mg.evenPlayer : mg.oddPlayer);
  }
  broadcastState();
}

// 10) 금고 번호 맞추기 — 숫자야구. 서버가 금고 번호를 하나 정해두고, 두 사람이 순서 제한 없이
// 동시에 추리한다. 스트라이크(숫자·자리 모두 일치) / 볼(숫자만 일치) / 아웃(둘 다 없음).
// 먼저 정확히 맞히는 쪽이 승리 — 몇 번이든 계속 시도할 수 있다.
function isValidDigits(arr) {
  return Array.isArray(arr) && arr.length === CONFIG.BANK_DIGITS
    && arr.every((d) => Number.isInteger(d) && d >= 0 && d <= 9)
    && new Set(arr).size === arr.length;
}
function handleBank(id, payload, mg) {
  const guess = Array.isArray(payload.guess) ? payload.guess.map(Number) : null;
  if (!isValidDigits(guess)) return;
  const secret = mg.secrets[id]; // 각자 자신의 금고(정답)만 상대한다 — 공유 정답이 아니다.
  let strikes = 0, balls = 0;
  guess.forEach((d, i) => {
    if (secret[i] === d) strikes += 1;
    else if (secret.includes(d)) balls += 1;
  });
  mg.history[id].push({ guess: guess.slice(), strikes, balls });
  const outcome = strikes === 0 && balls === 0 ? '아웃' : `${strikes}스트라이크 ${balls}볼`;
  log(`${match.players[id].name}: 자신의 금고에 ${guess.join('')} 시도 → ${outcome}`);
  if (strikes === CONFIG.BANK_DIGITS) {
    log(`${match.players[id].name}이 자신의 금고를 열었습니다! (번호: ${secret.join('')})`);
    broadcastState();
    return endMinigame(id);
  }
  broadcastState();
}

// 11) 사라진 유품 찾기 — 유품 4개를 잠깐 보여준 뒤, 같은 4자리 중 하나만 다른 유품으로 바뀐
// 모습을 다시 보여주고 "무엇이 바뀌었는지" 맞힌다. 둘 다 같은 것을 보므로 순수 기억력/속도
// 승부(숨김정보 없음). 정답+더 빠른 쪽이 승리, 둘 다 틀리면 무작위로 승자를 정한다(드문 경우).
function handleMemory(id, payload, mg) {
  if (mg.answers[id]) return; // 이미 답함
  const choice = payload && payload.choice;
  if (!mg.after.includes(choice)) return;
  mg.answers[id] = { choice, t: Date.now() };
  log(`${match.players[id].name}이 "${MEMORY_NAMES_KR[choice]}"(으)로 바뀌었다고 답했습니다.`);
  const [a, b] = match.order;
  if (mg.answers[a] && mg.answers[b]) {
    const correctA = mg.answers[a].choice === mg.changedItem;
    const correctB = mg.answers[b].choice === mg.changedItem;
    let winner;
    if (correctA && correctB) winner = mg.answers[a].t <= mg.answers[b].t ? a : b;
    else if (correctA) winner = a;
    else if (correctB) winner = b;
    else winner = Math.random() < 0.5 ? a : b;
    log(`정답 공개: 바뀐 유품은 "${MEMORY_NAMES_KR[mg.changedItem]}"이었습니다.`);
    broadcastState();
    return endMinigame(winner);
  }
  broadcastState();
}

// ------------------------------ 본행동(액션) ---------------------------------
// 본행동: 내 턴이 되면 내 처소에서 술잔 CONFIG.OPENS_PER_TURN(기본 2)개를 직접 골라 연다.
// (아이템/단서 획득 같은 별도 행동 선택 없이, 정찰은 미니게임 보상으로만 얻는다.)
function doAction(id, kind, payload) {
  if (match.phase !== 'ROUND_ACTION') return;
  if (kind !== 'OPEN') return;
  const opens = match.actionOpens[id] || 0;
  if (opens >= CONFIG.OPENS_PER_TURN) return; // 이미 이번 라운드 몫을 다 열었음
  const player = match.players[id];
  const { row, col } = payload;
  if (row == null || col == null || row < 0 || row >= CONFIG.GRID || col < 0 || col >= CONFIG.GRID) return;
  const cell = player.room[row][col];
  if (cell.opened) return;
  resolveOpen(player, row, col, cell);
  match.actionOpens[id] = opens + 1;
  checkRoundActionDone();
}

function resolveOpen(player, row, col, cell) {
  cell.opened = true;
  const t = cell.type;
  actionLog(player, `술잔 고르기 → (${row + 1},${col + 1}) = ${CELL_NAMES[t]}`);
  if (t === 'P') {
    player.poison += 1;
    actionLog(player, `독배를 마셨습니다... (해독하지 못하면 게임 종료 시 -${CONFIG.POISON_PENALTY}점)`);
    checkNeutralize(player);
  } else if (t === 'G') {
    player.score += CONFIG.GOLD_PTS;
  } else if (t === 'S') {
    player.score += CONFIG.SILVER_PTS;
  } else if (t === 'A') {
    player.antidote += 1;
    checkNeutralize(player);
  }
}

function checkNeutralize(player) {
  while (player.poison > 0 && player.antidote >= CONFIG.ANTIDOTE_NEED) {
    player.poison -= 1;
    player.antidote -= CONFIG.ANTIDOTE_NEED;
    actionLog(player, `해독제 ${CONFIG.ANTIDOTE_NEED}개로 독 1개 무효화!`);
  }
}

// ------------------------------ 보상(정찰) 사용 -------------------------------
function handleRewardUse(id, payload) {
  if (match.phase !== 'ROUND_ACTION') return;
  const pr = match.pendingReward;
  if (!pr || pr.winnerId !== id || pr.used) return;
  const player = match.players[id];
  const opp = match.players[otherId(id)];
  if (!opp) return;

  // 보상 4종은 모두 "내 처소"(내가 실제로 술잔을 여는 곳)를 정찰하는 도구다.
  // 상대 처소는 내가 어떤 행동도 할 수 없는 곳이라 정찰해도 쓸 데가 없으므로,
  // 기존 아이템(은수저/소믈리에의 코)과 동일하게 자신의 방을 대상으로 한다.
  // (섬광 정찰은 직접 사용하는 게 아니라 endMinigame()에서 무작위 시점에 자동 발동된다.)
  if (pr.type === 'PEEK_CELL') {
    const row = Number(payload.row), col = Number(payload.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= CONFIG.GRID || col < 0 || col >= CONFIG.GRID) return;
    pr.used = true;
    const type = player.room[row][col].type;
    actionLog(player, `보상 사용 — 내 처소 (${row + 1},${col + 1}) 정찰 → ${CELL_NAMES[type]}`);
    io.to(id).emit('rewardResult', { kind: 'PEEK_CELL', row, col, type });
    broadcastState();
    return;
  }
  if (pr.type === 'ROW_COUNT' || pr.type === 'COL_COUNT') {
    const axis = pr.type === 'ROW_COUNT' ? 'row' : 'col';
    const idx = Number(payload.index);
    const targetType = payload.targetType;
    if (!Number.isInteger(idx) || idx < 0 || idx >= CONFIG.GRID) return;
    if (!CLUE_CATS.includes(targetType)) return;
    pr.used = true;
    let count = 0;
    for (let i = 0; i < CONFIG.GRID; i++) {
      const cell = axis === 'row' ? player.room[idx][i] : player.room[i][idx];
      if (cell.type === targetType) count += 1;
    }
    const label = axis === 'row' ? `${idx + 1}행` : `${idx + 1}열`;
    actionLog(player, `보상 사용 — 내 처소 ${label}의 ${CLUE_CAT_NAMES[targetType]} 개수 확인 → ${count}개`);
    io.to(id).emit('rewardResult', { kind: pr.type, index: idx, targetType, count });
    broadcastState();
    return;
  }
}

// ------------------------------ 라운드 진행/종료 -----------------------------
// 처소 열기는 두 사람이 각자 동시에 진행하므로, 한 명이 칸을 열 때마다 이 함수로 상태를 갱신하고
// 두 사람 모두 이번 라운드 몫(OPENS_PER_TURN)을 다 열었을 때만 다음 라운드로 넘어간다.
function checkRoundActionDone() {
  broadcastState();
  if (match.phase !== 'ROUND_ACTION') return;
  const allDone = match.order.length === 2 && match.order.every((pid) => (match.actionOpens[pid] || 0) >= CONFIG.OPENS_PER_TURN);
  if (!allDone) return;
  if (match.round >= CONFIG.ROUNDS) return endMatchByScore();
  startRound();
}

function endMatchByScore() {
  const [a, b] = match.order;
  const pa = match.players[a], pb = match.players[b];
  const finalize = (p) => p.score - p.poison * CONFIG.POISON_PENALTY;
  const fa = finalize(pa), fb = finalize(pb);
  pa.finalScore = fa; pb.finalScore = fb;
  let winner = null, reason;
  if (fa !== fb) {
    winner = fa > fb ? a : b;
    reason = `${CONFIG.ROUNDS}라운드 종료 — 최종 점수 비교 승리 (독배 -${CONFIG.POISON_PENALTY}점 반영)`;
  } else if (pa.poison !== pb.poison) {
    // 최종 점수가 완전히 같으면, 무효화하지 못한 독을 더 적게 마신 쪽(더 안전하게 버틴 쪽)이 승리한다.
    winner = pa.poison < pb.poison ? a : b;
    reason = `${CONFIG.ROUNDS}라운드 종료 — 점수 동률, 무효화하지 못한 독 개수로 승부 판정`;
  } else {
    reason = `${CONFIG.ROUNDS}라운드 종료 — 점수·독 개수 완전 동률(무승부)`;
  }
  endMatch(reason, winner);
}

function endMatch(reason, winnerId) {
  match.phase = 'END';
  match.winner = winnerId || null;
  match.endReason = reason;
  log(`=== 게임 종료: ${reason}${winnerId ? ` (승자: ${match.players[winnerId].name})` : ''} ===`);
  broadcastState();
}

// ------------------------------ 재대전(다시 하기) -----------------------------
function handleRematchReady(id) {
  if (match.phase !== 'END') return;
  if (!match.order.includes(id)) return;
  if (match.rematchReady[id]) return; // 이미 눌렀으면 무시
  match.rematchReady[id] = true;
  log(`${match.players[id].name}이(가) 다시 하기를 신청했습니다.`);
  broadcastState();
  if (match.order.every((pid) => match.rematchReady[pid])) {
    resetForRematch();
  }
}

// 같은 두 소켓(같은 브라우저 탭)을 그대로 유지한 채, 게임 데이터만 초기화하고 새 셋업을 시작한다.
// 재접속 없이 곧바로 다음 판을 시작할 수 있게 하기 위함 — 이름(장남/차남)과 연결 상태는 유지한다.
function resetForRematch() {
  const order = match.order.slice();
  const names = order.map((id) => match.players[id].name);
  const connected = order.map((id) => match.players[id].connected);
  match = freshMatch();
  match.order = order;
  order.forEach((id, i) => {
    match.players[id] = newPlayer(id, names[i]);
    match.players[id].connected = connected[i];
  });
  log('양측이 다시 하기에 합의했습니다 — 새 게임을 시작합니다.');
  startSetup();
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

  const pr = match.pendingReward;
  return {
    seq: match.seq,
    phase: match.phase,
    round: match.round,
    roundsTotal: CONFIG.ROUNDS,
    minigame: match.minigame && {
      type: match.minigame.type,
      name: MINIGAME_NAMES[match.minigame.type],
      // 클라이언트에 필요한 진행상황만 노출 (히든정보 보호)
      public: publicMinigameView(match.minigame, forId),
    },
    roundReward: match.roundRewardType ? { type: match.roundRewardType, name: REWARD_NAMES[match.roundRewardType] } : null,
    // FLASH_ALL은 언제 터질지 알려주면 보상의 의미가 없어지므로 expiresAt(발동 시한)은 내려주지 않는다.
    myReward: pr && pr.winnerId === forId ? { type: pr.type, name: REWARD_NAMES[pr.type], used: pr.used } : null,
    oppHasReward: !!(pr && pr.winnerId !== forId && !pr.used),
    // 처소 열기는 두 사람이 동시에 독립적으로 진행 — "내 턴"은 이제 "아직 이번 라운드 몫이 남았는가"를 뜻한다.
    isMyTurn: match.phase === 'ROUND_ACTION' && (match.actionOpens[forId] || 0) < CONFIG.OPENS_PER_TURN,
    opensRemaining: CONFIG.OPENS_PER_TURN - (match.actionOpens[forId] || 0),
    oppOpensRemaining: oppId ? CONFIG.OPENS_PER_TURN - (match.actionOpens[oppId] || 0) : null,
    me: me && {
      name: me.name, poison: me.poison, antidote: me.antidote, score: me.score, finalScore: me.finalScore,
      room: sanitizeRoom(me.room, match.phase === 'END'),
      history: me.history || [],
    },
    // 상대의 점수/독/해독제는 게임이 끝나기 전까지 서버도 클라이언트에 내려주지 않는다(콘솔로 훔쳐보기 방지).
    opp: opp && (match.phase === 'END'
      ? { name: opp.name, poison: opp.poison, antidote: opp.antidote, score: opp.score, finalScore: opp.finalScore, connected: opp.connected, room: sanitizeRoom(opp.room, true) }
      : { name: opp.name, connected: opp.connected, room: null }),
    setupDone: match.order.reduce((acc, id) => { acc[id === forId ? 'me' : 'opp'] = !!match.setupSelections[id]; return acc; }, {}),
    winner: match.winner ? (match.winner === forId ? 'me' : 'opp') : (match.phase === 'END' ? 'draw' : null),
    endReason: match.endReason,
    rematchReady: { me: !!match.rematchReady[forId], opp: !!match.rematchReady[otherId(forId)] },
    config: CONFIG,
    clueCatNames: CLUE_CAT_NAMES,
    playersConnected: match.order.length,
  };
}

function publicMinigameView(mg, forId) {
  const mine = (pid) => pid === forId;
  if (mg.type === 'NIM') {
    // 정확한 누적/한계 숫자는 숨기고, 술잔이 얼마나 차올랐는지 비율(fillRatio)만 시각화용으로 내려준다.
    return { fillRatio: Math.min(1, mg.count / mg.limit), myTurn: mg.turn === forId };
  }
  if (mg.type === 'HAND') {
    const role = mine(mg.hider) ? 'hider' : mine(mg.guesser) ? 'guesser' : null;
    return { role, waitingForMe: (role === 'hider' && mg.hiderPick == null) || (role === 'guesser' && mg.hiderPick != null && mg.guesserPick == null), hiderDone: mg.hiderPick != null };
  }
  if (mg.type === 'REFLEX') {
    return { goFired: !!mg.goAt, myClicked: !!mg.clicks[forId], oppClicked: !!mg.clicks[otherId(forId)] };
  }
  if (mg.type === 'BOMB') return { passes: mg.passes, myTurn: mg.holder === forId };
  if (mg.type === 'PIN') return { pulls: mg.pulls, myTurn: mg.turn === forId };
  if (mg.type === 'SIGIL') {
    return { myPick: mg.picks[forId] || null, oppPicked: !!mg.picks[otherId(forId)], waitingForMe: !mg.picks[forId] };
  }
  if (mg.type === 'GUESS_COUNT') {
    return { trueCount: mg.trueCount, myGuess: mg.guesses[forId] ?? null, oppGuessed: !!mg.guesses[otherId(forId)] && mg.guesses[otherId(forId)] !== undefined, waitingForMe: mg.guesses[forId] == null };
  }
  if (mg.type === 'PARITY') {
    return { role: mg.oddPlayer === forId ? 'ODD' : 'EVEN', myPick: mg.picks[forId] || null, waitingForMe: !mg.picks[forId] };
  }
  if (mg.type === 'BANK') {
    const oppId = otherId(forId);
    return {
      digits: CONFIG.BANK_DIGITS,
      // 서로 다른 금고를 각자 푸는 방식이므로, 상대의 시도 횟수만 참고용으로 보여주고
      // 상대의 스트라이크/볼 결과는(내 금고와 무관한 정보라) 굳이 내려줄 필요가 없다.
      myGuesses: (mg.history[forId] || []).map((h) => ({ guess: h.guess, strikes: h.strikes, balls: h.balls })),
      oppAttempts: (mg.history[oppId] || []).length,
    };
  }
  if (mg.type === 'MEMORY') {
    // 정답(changedItem)은 절대 내려주지 않는다 — 둘 다 답하고 나서야 endMinigame으로 결과가 공개됨.
    return {
      before: mg.before, after: mg.after, revealUntil: mg.revealUntil,
      myAnswered: !!mg.answers[forId], oppAnswered: !!mg.answers[otherId(forId)],
    };
  }
  return {};
}

function broadcastState() {
  for (const id of match.order) {
    io.to(id).emit('state', buildClientState(id));
  }
  broadcastAdminState();
}

// 관리자 화면 전용 — 진행 중인 미니게임의 숨김정보(정답, 각자의 선택 등)를 사람이 읽기 쉬운
// 라벨(플레이어 이름 기준)로 풀어서 보여준다. "서로 어떤 걸 선택하고 있는지" 실시간으로 보이게
// 하는 것이 관리자 화면의 목적이므로, 아직 공개되지 않은 진행 중 선택도 그대로 노출한다.
function buildAdminMinigameSummary(mg) {
  const nameOf = (id) => (id ? (match.players[id] ? match.players[id].name : id) : null);
  const byName = (obj, mapVal) => {
    const out = {};
    for (const [id, v] of Object.entries(obj || {})) out[nameOf(id)] = mapVal ? mapVal(v) : v;
    return out;
  };
  const type = mg.type;
  if (type === 'NIM') return { 누적: mg.count, 목표: mg.limit, 현재차례: nameOf(mg.turn) };
  if (type === 'HAND') return { 숨기는사람: nameOf(mg.hider), 맞히는사람: nameOf(mg.guesser), 숨긴손: mg.hiderPick, 지목한손: mg.guesserPick };
  if (type === 'REFLEX') return { 신호발동여부: !!mg.goAt, 클릭기록: byName(mg.clicks, (v) => (v.early ? '성급하게 누름' : `${v.reactMs}ms`)) };
  if (type === 'BOMB') return { 현재소지자: nameOf(mg.holder), 전달횟수: mg.passes };
  if (type === 'PIN') return { 현재차례: nameOf(mg.turn), 뽑은횟수: mg.pulls, 터지는시점: mg.popAt };
  if (type === 'SIGIL') return { 선택현황: byName(mg.picks) };
  if (type === 'GUESS_COUNT') return { 실제개수: mg.trueCount, 추측현황: byName(mg.guesses) };
  if (type === 'PARITY') return { 역할: { [nameOf(mg.oddPlayer)]: '홀', [nameOf(mg.evenPlayer)]: '짝' }, 선택현황: byName(mg.picks) };
  if (type === 'BANK') return {
    각자의정답: byName(mg.secrets, (v) => v.join('')),
    시도횟수: byName(mg.history, (v) => v.length),
  };
  if (type === 'MEMORY') return {
    처음보여준4개: (mg.before || []).map((k) => MEMORY_NAMES_KR[k]),
    바뀐후4개: (mg.after || []).map((k) => MEMORY_NAMES_KR[k]),
    실제로바뀐것: MEMORY_NAMES_KR[mg.changedItem],
    답변현황: byName(mg.answers, (v) => MEMORY_NAMES_KR[v.choice]),
  };
  return {};
}

// 관리자(관전) 화면용 — 두 플레이어(장남/차남)의 처소를 전부(비공개 정보 포함) 그대로 보여준다.
// 밸런스 테스트 관찰 용도이므로 플레이어에게는 숨기는 정보도 관리자에게는 그대로 내려준다.
// 요청사항: "서로 어떤 걸 선택하고 있는지" 실시간으로 보여야 하므로, 이미 확정된 결과뿐 아니라
// 설치 단계의 확정 전 미리보기(setupPreview)와 미니게임 진행 중 선택도 함께 내려준다.
function buildAdminState() {
  return {
    phase: match.phase,
    round: match.round,
    roundsTotal: CONFIG.ROUNDS,
    minigame: match.minigame ? {
      type: match.minigame.type,
      name: MINIGAME_NAMES[match.minigame.type],
      detail: buildAdminMinigameSummary(match.minigame),
    } : null,
    setupPreview: match.phase === 'SETUP' ? match.order.map((id) => ({
      name: match.players[id].name,
      confirmed: !!match.setupSelections[id],
      cells: match.setupSelections[id] || match.setupPreview[id] || [],
    })) : null,
    players: match.order.map((id) => {
      const p = match.players[id];
      return {
        name: p.name,
        connected: p.connected,
        poison: p.poison, antidote: p.antidote, score: p.score, finalScore: p.finalScore,
        opens: match.actionOpens[id] || 0,
        room: p.room.map((row) => row.map((cell) => ({ type: cell.type, opened: cell.opened }))),
      };
    }),
  };
}
function broadcastAdminState() {
  io.to('admins').emit('adminState', buildAdminState());
}

io.on('connection', (socket) => {
  // 관리자(관전) 화면 — 플레이어 슬롯을 차지하지 않고 그냥 지켜만 본다.
  if (socket.handshake.query && socket.handshake.query.role === 'admin') {
    socket.join('admins');
    socket.emit('adminState', buildAdminState());
    return;
  }

  // "게임 재시작"은 방이 꽉 차서 거부된 상태(예: 예전 접속자들이 유령으로 자리를 차지한 경우)에서도
  // 눌러야 하는 경우가 많으므로, 방 정원 체크보다 먼저 등록해 항상 동작하게 한다.
  // 누가 눌렀는지와 무관하게 서버 상태를 완전히 새로 만들고, 접속해 있는 모든 클라이언트를
  // 새로고침시켜 깨끗한 상태로 재접속하게 한다 — 그래야 정체된(full) 화면도 확실히 풀린다.
  socket.on('admin:reset', () => {
    match = freshMatch();
    io.emit('reload');
    broadcastAdminState();
  });

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
    delete match.setupPreview[socket.id];
    log(`${match.players[socket.id].name} 독 설치 완료`);
    broadcastState();
    if (match.order.every((id) => match.setupSelections[id])) finalizeSetup();
  });

  // 확정 전 실시간 미리보기 — 관리자 화면 전용. 상대 플레이어에게는 절대 내려주지 않으므로
  // broadcastState()가 아니라 broadcastAdminState()만 호출한다.
  socket.on('setup:preview', (payload) => {
    if (match.phase !== 'SETUP') return;
    const cells = Array.isArray(payload && payload.cells) ? payload.cells : [];
    const valid = cells.filter((cell) => cell && cell.row >= 0 && cell.row < CONFIG.GRID && cell.col >= 0 && cell.col < CONFIG.GRID);
    match.setupPreview[socket.id] = valid;
    broadcastAdminState();
  });

  socket.on('minigame:move', (payload) => handleMinigameMove(socket.id, payload || {}));
  socket.on('action:open', (p) => doAction(socket.id, 'OPEN', p || {}));
  socket.on('reward:use', (p) => handleRewardUse(socket.id, p || {}));
  socket.on('rematch:ready', () => handleRematchReady(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`당신의 술잔에 독배를 — 프로토타입 서버 실행 중: http://localhost:${PORT}`);
  console.log('같은 네트워크의 다른 컴퓨터에서는 이 컴퓨터의 IP로 접속하세요 (예: http://192.168.0.5:3000)');
});
