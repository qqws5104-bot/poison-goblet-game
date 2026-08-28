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
  INVENTORY_CAP: 3,
  NIM_LIMIT: 15,          // 독배 채우기: 이 숫자에 도달/초과시키면 그 사람이 패배
  BOMB_FUSE_MIN: 3, BOMB_FUSE_MAX: 7,
  PIN_POP_MIN: 3, PIN_POP_MAX: 8,
  CARD_MAX: 5,
  BANK_DIGITS: 3,         // 금고 번호 맞추기: 서로 다른 숫자 몇 자리
  REWARD_FLASH_MS: 60000, // 섬광 정찰 보상의 사용 제한 시간(ms)
};

const MINIGAME_SEQUENCE = ['NIM', 'HAND', 'CARD', 'BOMB', 'PIN', 'SIGIL', 'GUESS_COUNT', 'PARITY', 'SHOWDOWN', 'BANK'];
const MINIGAME_NAMES = {
  NIM: '독배 채우기', HAND: '독 든 손 맞히기', CARD: '거짓 카드 건네기',
  BOMB: '폭탄 눈치 넘기기', PIN: '안전핀 뽑기 배팅',
  SIGIL: '표식 대결', GUESS_COUNT: '촛불 개수 맞히기', PARITY: '숫자 합 홀짝', SHOWDOWN: '배짱 대결',
  BANK: '금고 번호 맞추기',
};
const SIGIL_BEATS = { SWORD: 'POISON', POISON: 'SHIELD', SHIELD: 'SWORD' };
const SIGIL_NAMES_KR = { SWORD: '검', POISON: '독배', SHIELD: '방패' };
const ITEM_NAMES = { SPOON: '은수저', NOSE: '소믈리에의 코', WARD: '해독의 부적', SWAP: '잔 바꿔치기' };
const CLUE_CATS = ['P', 'G', 'S', 'A'];
const CLUE_CAT_NAMES = { P: '독 술잔', G: '금 술잔', S: '은 술잔', A: '해독제' };
const CELL_NAMES = { P: '독 술잔', G: '금 술잔', S: '은 술잔', A: '해독제', E: '빈 칸' };

const REWARD_TYPES = ['FLASH_ALL', 'PEEK_CELL', 'ROW_COUNT', 'COL_COUNT'];
const REWARD_NAMES = {
  FLASH_ALL: '섬광 정찰 — 1분 내 원할 때, 상대 처소 전체를 0.1초간 공개',
  PEEK_CELL: '한 칸 정찰 — 상대 처소 원하는 1칸의 정체 확인',
  ROW_COUNT: '행 정찰 — 상대 처소 원하는 행에서 지정한 술잔 개수 확인',
  COL_COUNT: '열 정찰 — 상대 처소 원하는 열에서 지정한 술잔 개수 확인',
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
    items: [], shield: false, decoyNextClue: false, connected: true,
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
    round: 0, minigameOrder: shuffle(MINIGAME_SEQUENCE), minigame: null,
    roundRewardType: null, pendingReward: null,
    actionOrder: [], turnIndex: 0,
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
  if (type === 'SIGIL') {
    return { ...base, picks: {} };
  }
  if (type === 'GUESS_COUNT') {
    return { ...base, trueCount: randInt(3, 9), guesses: {}, guessOrder: [] };
  }
  if (type === 'PARITY') {
    return { ...base, oddPlayer: firstIsA ? a : b, evenPlayer: firstIsA ? b : a, picks: {} };
  }
  if (type === 'SHOWDOWN') {
    return { ...base, picks: {} };
  }
  if (type === 'BANK') {
    // 각자 자신만의 금고 번호(서로 다른 숫자 N개)를 직접 정한다. 둘 다 정하고 나면
    // 번갈아 "상대의" 번호를 추리한다 — 숫자야구(스트라이크/볼/아웃) 방식.
    return { ...base, secrets: {}, firstTurn: firstIsA ? a : b, turn: null, history: { [a]: [], [b]: [] } };
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

  // 행동 순서는 더 이상 미니게임 승패가 아니라 라운드 홀/짝으로 고정 교대한다 (보상이 우선권을 대체).
  const [a, b] = match.order;
  const firstId = match.round % 2 === 1 ? a : b;
  match.actionOrder = [firstId, otherId(firstId)];
  match.turnIndex = 0;
  match.phase = 'ROUND_ACTION';
  log(`미니게임 승리: ${match.players[winnerId].name} → 이번 라운드 보상 [${REWARD_NAMES[match.roundRewardType]}] 획득`);

  if (match.pendingReward.expiresAt) {
    const roundAtGrant = match.round;
    setTimeout(() => {
      if (match.round === roundAtGrant && match.pendingReward && match.pendingReward.winnerId === winnerId && !match.pendingReward.used) {
        match.pendingReward.used = true;
        log(`${match.players[winnerId].name}의 섬광 정찰 보상 시간이 만료되었습니다.`);
        broadcastState();
      }
    }, CONFIG.REWARD_FLASH_MS);
  }

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
  if (mg.type === 'SIGIL') return handleSigil(id, payload, mg);
  if (mg.type === 'GUESS_COUNT') return handleGuessCount(id, payload, mg);
  if (mg.type === 'PARITY') return handleParity(id, payload, mg);
  if (mg.type === 'SHOWDOWN') return handleShowdown(id, payload, mg);
  if (mg.type === 'BANK') {
    if (payload && Array.isArray(payload.secret)) return handleBankSecret(id, payload, mg);
    return handleBank(id, payload, mg);
  }
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
  if (![1, 2, 3].includes(n)) return;
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

// 9) 배짱 대결 — 동시에 1~10 중 배짱 수치를 제시, 더 높은 쪽 승리(동률이면 재시도, 순수 배짱형)
function handleShowdown(id, payload, mg) {
  if (mg.picks[id] != null) return;
  const n = Number(payload.n);
  if (!Number.isInteger(n) || n < 1 || n > 10) return;
  mg.picks[id] = n;
  const [a, b] = match.order;
  if (mg.picks[a] != null && mg.picks[b] != null) {
    log(`배짱 공개: ${match.players[a].name}=${mg.picks[a]}, ${match.players[b].name}=${mg.picks[b]}`);
    if (mg.picks[a] === mg.picks[b]) {
      log('무승부 — 같은 숫자를 냈습니다. 다시 냅니다.');
      mg.picks = {};
      broadcastState();
      return;
    }
    broadcastState();
    return endMinigame(mg.picks[a] > mg.picks[b] ? a : b);
  }
  broadcastState();
}

// 10) 금고 번호 맞추기 — 숫자야구. 각자 자신의 금고 번호를 정한 뒤, 번갈아 상대의 번호를 추리한다.
// 스트라이크(숫자·자리 모두 일치) / 볼(숫자만 일치) / 아웃(둘 다 없음). 먼저 상대 번호를 완전히 맞히면 승리.
function isValidDigits(arr) {
  return Array.isArray(arr) && arr.length === CONFIG.BANK_DIGITS
    && arr.every((d) => Number.isInteger(d) && d >= 0 && d <= 9)
    && new Set(arr).size === arr.length;
}
function handleBankSecret(id, payload, mg) {
  if (mg.secrets[id]) return; // 이미 정했으면 변경 불가
  const secret = Array.isArray(payload.secret) ? payload.secret.map(Number) : null;
  if (!isValidDigits(secret)) return;
  mg.secrets[id] = secret;
  log(`${match.players[id].name}이 자신의 금고 번호를 정했습니다.`);
  const [a, b] = match.order;
  if (mg.secrets[a] && mg.secrets[b]) {
    mg.turn = mg.firstTurn;
    log('양쪽 모두 번호를 정했습니다 — 이제 서로 상대의 금고를 열어보세요.');
  }
  broadcastState();
}
function handleBank(id, payload, mg) {
  if (mg.turn !== id) return; // 아직 양쪽 다 번호를 정하지 않았거나 내 차례가 아님
  const oppId = otherId(id);
  const secret = mg.secrets[oppId];
  if (!secret) return;
  const guess = Array.isArray(payload.guess) ? payload.guess.map(Number) : null;
  if (!isValidDigits(guess)) return;
  let strikes = 0, balls = 0;
  guess.forEach((d, i) => {
    if (secret[i] === d) strikes += 1;
    else if (secret.includes(d)) balls += 1;
  });
  mg.history[id].push({ guess: guess.slice(), strikes, balls });
  const outcome = strikes === 0 && balls === 0 ? '아웃' : `${strikes}스트라이크 ${balls}볼`;
  log(`${match.players[id].name}: 상대 금고에 ${guess.join('')} 시도 → ${outcome}`);
  if (strikes === CONFIG.BANK_DIGITS) {
    log(`${match.players[id].name}이 상대의 금고를 열었습니다! (번호: ${secret.join('')})`);
    broadcastState();
    return endMinigame(id);
  }
  mg.turn = oppId;
  broadcastState();
}

// ------------------------------ 본행동(액션) ---------------------------------
function doAction(id, kind, payload) {
  if (match.phase !== 'ROUND_ACTION') return;
  const activeId = match.actionOrder[match.turnIndex];
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
    actionLog(player, `아이템 획득 — ${ITEM_NAMES[itemType]}`);
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
    actionLog(player, `[${CLUE_CAT_NAMES[cat]}] 단서 뽑기 — 더 이상 알아낼 정보가 없습니다.`);
    return;
  }
  // 잔 바꿔치기로 오염된 경우: 실제로는 다른(엉뚱한) 좌표/거짓 정보를 알려준다
  const poisoned = player.decoyNextClue;
  if (poisoned) player.decoyNextClue = false;

  // 같은 칸끼리 붙어 있는(인접한) 쌍이 있으면 "인접" 단서도 후보에 넣는다
  const adjPair = poisoned ? null : findAdjacentPair(unknownCells);
  const pool = adjPair ? ['exact', 'row', 'col', 'block', 'adjacent'] : ['exact', 'row', 'col', 'block'];

  if (!player.lastClueByCat) player.lastClueByCat = {};
  const prevSig = player.lastClueByCat[cat];

  let clueType, source, signature;
  for (let attempt = 0; attempt < 8; attempt++) {
    clueType = pool[randInt(0, pool.length - 1)];
    const pick = unknownCells[randInt(0, unknownCells.length - 1)];
    source = poisoned ? { r: randInt(0, CONFIG.GRID - 1), c: randInt(0, CONFIG.GRID - 1) } : { r: pick.r, c: pick.c };
    if (clueType === 'exact') signature = `exact:${source.r},${source.c}`;
    else if (clueType === 'row') signature = `row:${source.r}`;
    else if (clueType === 'col') signature = `col:${source.c}`;
    else if (clueType === 'adjacent') signature = `adjacent:${adjPair.a.r},${adjPair.a.c}-${adjPair.b.r},${adjPair.b.c}`;
    else { const { br, bc } = blockOf(source.r, source.c); signature = `block:${br},${bc}`; }
    // 같은 신호(직전과 완전히 동일한 단서)면 다시 뽑는다 — 매번 새로운 정보를 주기 위함
    if (signature !== prevSig) break;
  }
  player.lastClueByCat[cat] = signature;
  const suffix = poisoned ? ' (※ 정보가 오염되었을 수 있습니다)' : '';

  let text, cells;
  if (clueType === 'exact') {
    cells = [{ row: source.r, col: source.c }];
    if (!poisoned) room[source.r][source.c].cluedType = cat;
    else room[source.r][source.c].cluedNote = `(교란) ${CLUE_CAT_NAMES[cat]} 위치로 안내됨`;
    text = `[${CLUE_CAT_NAMES[cat]}] 정확한 위치: ${source.r + 1}행 ${source.c + 1}열${suffix}`;
  } else if (clueType === 'row') {
    cells = rowCells(source.r);
    text = `[${CLUE_CAT_NAMES[cat]}]가 ${source.r + 1}행${source.r === CONFIG.GRID - 1 ? '(맨 마지막 행)' : ''} 어딘가에 있습니다.${suffix}`;
  } else if (clueType === 'col') {
    cells = colCells(source.c);
    text = `[${CLUE_CAT_NAMES[cat]}]가 ${source.c + 1}열${source.c === CONFIG.GRID - 1 ? '(맨 마지막 열)' : ''} 어딘가에 있습니다.${suffix}`;
  } else if (clueType === 'adjacent') {
    cells = [{ row: adjPair.a.r, col: adjPair.a.c }, { row: adjPair.b.r, col: adjPair.b.c }];
    if (!poisoned) { room[adjPair.a.r][adjPair.a.c].cluedType = cat; room[adjPair.b.r][adjPair.b.c].cluedType = cat; }
    text = `[${CLUE_CAT_NAMES[cat]}] 두 개가 서로 붙어 있는 칸을 찾았습니다: ${adjPair.a.r + 1}행 ${adjPair.a.c + 1}열 / ${adjPair.b.r + 1}행 ${adjPair.b.c + 1}열${suffix}`;
  } else {
    const { br, bc } = blockOf(source.r, source.c);
    cells = blockCells(br, bc);
    text = `[${CLUE_CAT_NAMES[cat]}]가 ${br + 1}~${br + 2}행 × ${bc + 1}~${bc + 2}열 사각형(4칸) 중 하나에 있습니다.${suffix}`;
  }

  io.to(player.id).emit('clueResult', { text, cells, cat });
  actionLog(player, `[${CLUE_CAT_NAMES[cat]}] 단서 뽑기 → ${text}`);
}

// 같은 카테고리의 칸 중, 상하좌우로 서로 맞닿은(인접한) 쌍이 있는지 찾는다
function findAdjacentPair(cellsOfCat) {
  const set = new Set(cellsOfCat.map((c) => `${c.r},${c.c}`));
  for (const cell of cellsOfCat) {
    const neighbors = [{ r: cell.r + 1, c: cell.c }, { r: cell.r, c: cell.c + 1 }];
    for (const n of neighbors) {
      if (set.has(`${n.r},${n.c}`)) return { a: { r: cell.r, c: cell.c }, b: { r: n.r, c: n.c } };
    }
  }
  return null;
}

function rowCells(r) {
  const out = [];
  for (let c = 0; c < CONFIG.GRID; c++) out.push({ row: r, col: c });
  return out;
}
function colCells(c) {
  const out = [];
  for (let r = 0; r < CONFIG.GRID; r++) out.push({ row: r, col: c });
  return out;
}
function blockOf(r, c) {
  return { br: Math.floor(r / 2) * 2, bc: Math.floor(c / 2) * 2 };
}
function blockCells(br, bc) {
  return [{ row: br, col: bc }, { row: br, col: bc + 1 }, { row: br + 1, col: bc }, { row: br + 1, col: bc + 1 }];
}

function resolveOpen(player, row, col, cell) {
  cell.opened = true;
  const t = cell.type;
  actionLog(player, `술잔 고르기 → (${row + 1},${col + 1}) = ${CELL_NAMES[t]}`);
  if (t === 'P') {
    if (player.shield) {
      player.shield = false;
      actionLog(player, `해독의 부적이 독을 대신 막았습니다!`);
    } else {
      player.poison += 1;
      actionLog(player, `독배를 마셨습니다... (해독하지 못하면 게임 종료 시 -${CONFIG.POISON_PENALTY}점)`);
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
}

function checkNeutralize(player) {
  while (player.poison > 0 && player.antidote >= CONFIG.ANTIDOTE_NEED) {
    player.poison -= 1;
    player.antidote -= CONFIG.ANTIDOTE_NEED;
    actionLog(player, `해독제 ${CONFIG.ANTIDOTE_NEED}개로 독 1개 무효화!`);
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
    actionLog(player, `은수저 사용 → (${row + 1},${col + 1}) 확인`);
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
    actionLog(player, `소믈리에의 코 사용 → ${label} 독 개수 확인`);
    return true;
  }
  if (itemType === 'WARD') {
    player.shield = true;
    actionLog(player, `해독의 부적 장착 — 다음 독을 자동으로 막아줍니다.`);
    return true;
  }
  if (itemType === 'SWAP') {
    const opp = match.players[otherId(player.id)];
    opp.decoyNextClue = true;
    actionLog(player, `잔 바꿔치기 사용 — 상대의 다음 단서를 조작했습니다.`);
    return true;
  }
  return false;
}

// ------------------------------ 보상(정찰) 사용 -------------------------------
function handleRewardUse(id, payload) {
  if (match.phase !== 'ROUND_ACTION') return;
  const pr = match.pendingReward;
  if (!pr || pr.winnerId !== id || pr.used) return;
  const player = match.players[id];
  const opp = match.players[otherId(id)];
  if (!opp) return;

  if (pr.type === 'FLASH_ALL') {
    pr.used = true;
    const room = opp.room.map((row) => row.map((cell) => cell.type));
    actionLog(player, `보상 사용 — 섬광 정찰로 상대 처소 전체를 0.1초간 확인했습니다.`);
    io.to(id).emit('rewardResult', { kind: 'FLASH_ALL', room });
    broadcastState();
    return;
  }
  if (pr.type === 'PEEK_CELL') {
    const row = Number(payload.row), col = Number(payload.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= CONFIG.GRID || col < 0 || col >= CONFIG.GRID) return;
    pr.used = true;
    const type = opp.room[row][col].type;
    actionLog(player, `보상 사용 — 상대 처소 (${row + 1},${col + 1}) 정찰 → ${CELL_NAMES[type]}`);
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
      const cell = axis === 'row' ? opp.room[idx][i] : opp.room[i][idx];
      if (cell.type === targetType) count += 1;
    }
    const label = axis === 'row' ? `${idx + 1}행` : `${idx + 1}열`;
    actionLog(player, `보상 사용 — 상대 처소 ${label}의 ${CLUE_CAT_NAMES[targetType]} 개수 확인 → ${count}개`);
    io.to(id).emit('rewardResult', { kind: pr.type, index: idx, targetType, count });
    broadcastState();
    return;
  }
}

// ------------------------------ 라운드 진행/종료 -----------------------------
function afterAction() {
  broadcastState();
  if (match.phase !== 'ROUND_ACTION') return;
  if (match.turnIndex === 0) {
    match.turnIndex = 1;
    broadcastState();
  } else {
    if (match.round >= CONFIG.ROUNDS) return endMatchByScore();
    startRound();
  }
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
  } else {
    reason = `${CONFIG.ROUNDS}라운드 종료 — 최종 점수 완전 동률(무승부)`;
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
    myReward: pr && pr.winnerId === forId ? { type: pr.type, name: REWARD_NAMES[pr.type], used: pr.used, expiresAt: pr.expiresAt } : null,
    oppHasReward: !!(pr && pr.winnerId !== forId && !pr.used),
    actionOrder: match.actionOrder.map((id) => (id === forId ? 'me' : 'opp')),
    turnIndex: match.turnIndex,
    isMyTurn: match.phase === 'ROUND_ACTION' && match.actionOrder[match.turnIndex] === forId,
    me: me && {
      name: me.name, poison: me.poison, antidote: me.antidote, score: me.score, finalScore: me.finalScore,
      items: me.items, shield: me.shield,
      room: sanitizeRoom(me.room, match.phase === 'END'),
      history: me.history || [],
    },
    opp: opp && {
      name: opp.name, poison: opp.poison, antidote: opp.antidote, score: opp.score, finalScore: opp.finalScore,
      itemCount: opp.items.length, shield: opp.shield, connected: opp.connected,
      room: match.phase === 'END' ? sanitizeRoom(opp.room, true) : null,
    },
    setupDone: match.order.reduce((acc, id) => { acc[id === forId ? 'me' : 'opp'] = !!match.setupSelections[id]; return acc; }, {}),
    winner: match.winner ? (match.winner === forId ? 'me' : 'opp') : (match.phase === 'END' ? 'draw' : null),
    endReason: match.endReason,
    rematchReady: { me: !!match.rematchReady[forId], opp: !!match.rematchReady[otherId(forId)] },
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
  if (mg.type === 'SIGIL') {
    return { myPick: mg.picks[forId] || null, oppPicked: !!mg.picks[otherId(forId)], waitingForMe: !mg.picks[forId] };
  }
  if (mg.type === 'GUESS_COUNT') {
    return { trueCount: mg.trueCount, myGuess: mg.guesses[forId] ?? null, oppGuessed: !!mg.guesses[otherId(forId)] && mg.guesses[otherId(forId)] !== undefined, waitingForMe: mg.guesses[forId] == null };
  }
  if (mg.type === 'PARITY') {
    return { role: mg.oddPlayer === forId ? 'ODD' : 'EVEN', myPick: mg.picks[forId] || null, waitingForMe: !mg.picks[forId] };
  }
  if (mg.type === 'SHOWDOWN') {
    return { myPick: mg.picks[forId] ?? null, oppPicked: mg.picks[otherId(forId)] != null, waitingForMe: mg.picks[forId] == null };
  }
  if (mg.type === 'BANK') {
    const oppId = otherId(forId);
    return {
      digits: CONFIG.BANK_DIGITS,
      mySecretSet: !!mg.secrets[forId],
      oppSecretSet: !!mg.secrets[oppId],
      myTurn: mg.turn === forId,
      myGuesses: (mg.history[forId] || []).map((h) => ({ guess: h.guess, strikes: h.strikes, balls: h.balls })),
      oppGuesses: (mg.history[oppId] || []).map((h) => ({ guess: h.guess, strikes: h.strikes, balls: h.balls })),
    };
  }
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
  socket.on('reward:use', (p) => handleRewardUse(socket.id, p || {}));
  socket.on('rematch:ready', () => handleRematchReady(socket.id));

  socket.on('admin:end', () => { if (match.phase !== 'END') endMatch('관리자가 조기 종료함'); });
  socket.on('admin:reset', () => { match = freshMatch(); broadcastState(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`당신의 술잔에 독배를 — 프로토타입 서버 실행 중: http://localhost:${PORT}`);
  console.log('같은 네트워크의 다른 컴퓨터에서는 이 컴퓨터의 IP로 접속하세요 (예: http://192.168.0.5:3000)');
});
