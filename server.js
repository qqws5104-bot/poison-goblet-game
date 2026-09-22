// ============================================================================
// 당신의 술잔에 독배를 — 2인 밸런스 테스트 프로토타입 서버
// 두 대의 컴퓨터가 같은 네트워크에서 이 서버(하나만 실행)에 브라우저로 접속합니다.
// ============================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const CONFIG = {
  GRID: 6,                // 가로(열) 칸 수는 항상 6
  ROWS_FIRST_HALF: 4,     // 전반전에 활성화된 줄 수 — 6×4 = 24칸
  ROWS_TOTAL: 6,          // 후반전에 확장된 뒤의 전체 줄 수 — 6×6 = 36칸
  GEM_PTS: 1,
  CREST_PTS: 2,           // 문장 칸 1칸을 열 때마다 획득하는 점수
  CREST_BONUS: 3,         // 문장을 전부 열어 완성하면 추가로 받는 보너스 점수
  ANTIDOTE_NEED: 2,       // 해독제 2개 = 독 1개 무효화
  POISON_PENALTY: 3,      // 종료 시, 무효화되지 않은 독 1개당 -3점
  ROUNDS_FIRST_HALF: 8,   // 전반(6×4) 라운드 수
  ROUNDS_TOTAL: 15,       // 총 라운드 수(전반 8 + 후반 7)
  OPENS_PER_TURN: 2,      // 본행동: 내 턴마다 내 처소에서 열 술잔 개수
  ROUND_COUNTDOWN_MS: 3000, // 매 라운드 미니게임 시작 전 3-2-1 카운트다운 길이
  SETUP_DONE_MS: 5000, // 양쪽 다 독배 설치를 마친 직후, 본게임(1라운드 3-2-1 카운트다운)으로 넘어가기 전 대기 시간
  MID_SETUP_DONE_MS: 5000, // 중반 재설치(독 추가+처소 확장) 완료 직후, 후반 첫 라운드로 넘어가기 전 대기 시간
  ROUND_DONE_MS: 5000, // 매 라운드 양쪽 다 칸을 다 연 직후, 다음 라운드 3-2-1 카운트다운으로 넘어가기 전 대기 시간
  POISON_INITIAL: 3,      // 전반 셋업: 24칸 중 상대 처소에 몰래 지정하는 독 개수
  POISON_MID: 2,          // 중반 재설치: 아직 안 연 칸 중 상대 처소에 추가로 지정하는 독 개수
  CREST_WAVE1_MIN: 5, CREST_WAVE1_MAX: 6, // 전반 24칸 안에 무작위 배치되는 문장 조각 개수(본인도 비공개)
  CREST_WAVE2_MIN: 3, CREST_WAVE2_MAX: 4, // 후반에 새로 열리는 12칸 안에 무작위 배치되는 문장 조각 개수
  POOL_GEM_RATIO: 0.25, POOL_A_RATIO: 0.25, // 독·문장을 뺀 나머지 칸을 보석/해독제/빈칸으로 채울 때 비율(빈칸이 나머지)
  NIM_LIMIT_MIN: 12, NIM_LIMIT_MAX: 20, // 독배 채우기: 이 숫자(매판 무작위)에 도달/초과시키면 그 사람이 패배
  BOMB_FUSE_MS_MIN: 12000, BOMB_FUSE_MS_MAX: 20000, // 폭탄 눈치 넘기기: 실시간(ms) 퓨즈 — 이 시간 후 터짐
  PIN_COUNT_MIN: 8, PIN_COUNT_MAX: 12, // 안전핀 뽑기: 이번 판에 놓일 안전핀 개수(그 중 1개가 폭탄)
  GUESS_COUNT_MIN: 15, GUESS_COUNT_MAX: 30, // 와인잔 개수 세기: 실제 술잔 개수 범위
  BANK_DIGITS: 3,         // 금고 번호 맞추기: 서로 다른 숫자 몇 자리
  REWARD_FLASH_MS_MIN: 0, REWARD_FLASH_MS_MAX: 10000, // 섬광 정찰 보상: 획득 후 이 구간(ms) 안의 무작위 순간에 자동 발동
  REWARD_FLASH_REVEAL_MS: 300, // 섬광 정찰 발동 시 실제로 화면에 드러나 있는 시간(ms) — 너무 길면 화면이 깜빡이는 느낌이 강해져 짧게 줄임
  REWARD_USE_LIMIT: 3, // 보상 종류별로 한 사람이 실제로 사용할 수 있는 최대 횟수
};

// 배짱 대결(SHOWDOWN)은 "너무 단순한 게임"이라는 피드백으로 제외.
// "심리싸움 하는 느낌이 살면 좋겠다"는 최종 피드백에 따라, 운/대박 요소는 유지하면서도 상대를
// 읽어야 이기는 3종(BLUFF/LIAR_DIE/GAMBIT)을 추가했다 — 총 11종. ROUNDS(10) < 11종이라
// 한 매치에 11종이 전부 나오진 않지만(그중 10개를 무작위로 섞어 사용), 그 편이 매치마다
// 다른 조합을 보게 되어 오히려 반복감이 줄어든다.
// 숫자 합 홀짝(PARITY)은 상호작용이 단조롭다는 피드백으로, 사라진 유품 찾기(MEMORY)는 재미 피드백으로 제외.
const MINIGAME_SEQUENCE = ['NIM', 'HAND', 'REFLEX', 'BOMB', 'PIN', 'SIGIL', 'GUESS_COUNT', 'BANK', 'BLUFF', 'LIAR_DIE', 'GAMBIT'];
const MINIGAME_NAMES = {
  NIM: '독배 채우기', HAND: '독 든 손 맞히기', REFLEX: '잔 낚아채기',
  BOMB: '폭탄 눈치 넘기기', PIN: '안전핀 뽑기 배팅',
  SIGIL: '표식 대결', GUESS_COUNT: '탁자 위 술잔 개수 세기',
  BANK: '금고 번호 맞추기',
  BLUFF: '허세 배팅', LIAR_DIE: '라이어 주사위', GAMBIT: '황금 잔 허세 대결',
};
function buildMinigameOrder() {
  const order = shuffle(MINIGAME_SEQUENCE).slice(0, CONFIG.ROUNDS_TOTAL);
  while (order.length < CONFIG.ROUNDS_TOTAL) {
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
// 가문의 문장은 더 이상 고정된 좌표에 놓이지 않는다 — 독을 심고 남은 칸 중에서 매치마다
// 무작위 위치·무작위 개수(전반 5~6개, 후반 3~4개)로 배치되고, 본인도 총 몇 개인지 모른 채
// 칸을 열다가 우연히 발견한다(finalizeSetup/finalizeMidSetup에서 실제 배치). 위치·개수 모두
// 비공개 정보이므로 buildClientState는 이를 내려주지 않는다.
const CLUE_CATS = ['P', 'GEM', 'A', 'C'];
const CLUE_CAT_NAMES = { P: '독 술잔', GEM: '보석', A: '해독제', C: '가문의 문장' };
const CELL_NAMES = { P: '독 술잔', GEM: '보석', A: '해독제', E: '빈 칸', C: '가문의 문장' };

const REWARD_TYPES = ['FLASH_ALL', 'PEEK_CELL', 'ROW_COUNT', 'COL_COUNT'];
const REWARD_NAMES = {
  FLASH_ALL: '철가방 정찰 — 무작위 순간, 내 처소 전체가 뚜껑처럼 확 열렸다가 저절로 잠깐 드러남',
  PEEK_CELL: '한 칸 정찰 — 내 처소 원하는 1칸의 정체 확인',
  ROW_COUNT: '가로줄 정찰 — 내 처소에서 종류 하나를 고르면, 6개 가로줄 전부에 몇 개씩 있는지 확인',
  COL_COUNT: '세로줄 정찰 — 내 처소에서 종류 하나를 고르면, 6개 세로줄 전부에 몇 개씩 있는지 확인',
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
// 4대 분리 모드 전용 고정 주소 — 컴퓨터마다 이 중 하나를 북마크해두고 접속하면 된다.
// /game/A, /game/B: 셋업·미니게임·보상 등 처소 열기를 뺀 나머지 전부.
// /pick/A, /pick/B: 장남·차남 처소 6×6을 나란히 보여주고 본인 처소만 클릭해 여는 전용 화면.
// 실제 화면 분기는 client.js가 location.pathname을 보고 처리하므로, 서버는 그냥 같은
// index.html을 내려주기만 하면 된다.
app.get('/game/:slot(A|B)', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/pick/:slot(A|B)', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// 4대 분리 모드로 접속할 주소를 직접 타이핑하지 않아도 되도록, 큰 버튼 4개로 안내하는 시작
// 페이지. 소켓 연결을 만들지 않으므로(순수 링크 모음) 이 페이지를 열어도 플레이어 자리를
// 차지하지 않는다 — 아무 기기에서나 먼저 열어보고 눌러도 안전하다.
app.get('/start', (req, res) => res.sendFile(path.join(__dirname, 'public', 'start.html')));
const server = http.createServer(app);
const io = new Server(server);

// ------------------------------ 상태 ---------------------------------------
// 처소는 항상 6×ROWS_TOTAL(6×6=36칸) 배열로 만들되, 후반에 확장되는 아래쪽 줄들은
// locked:true로 시작해 전반 동안은 열 수도, 보이지도 않는다(finalizeMidSetup에서 잠금 해제).
function makeRoom() {
  const cells = [];
  for (let r = 0; r < CONFIG.ROWS_TOTAL; r++) {
    const row = [];
    for (let c = 0; c < CONFIG.GRID; c++) row.push({ type: null, opened: false, locked: r >= CONFIG.ROWS_FIRST_HALF, cluedType: null, cluedNote: null });
    cells.push(row);
  }
  return cells;
}
function newPlayer(id, name) {
  return {
    id, name, room: makeRoom(),
    poison: 0, antidote: 0, score: 0, finalScore: null,
    crestOpened: 0, // 자기 처소에서 연 문장 칸 개수
    crestTotal: 0,  // 문장 조각 총 개수 — 전반(finalizeSetup)+후반(finalizeMidSetup) 배치가 끝나야 확정되고,
                     // 완성 전까지는 본인에게도 공개하지 않는다(비공개 서프라이즈 요소).
    connected: true,
    // 보상 종류별로 "실제로 사용(발동)한" 횟수 — 각 종류 최대 REWARD_USE_LIMIT(3)번까지만 쓸 수
    // 있고, 다 쓴 종류는 이후 보상 후보에서 제외된다(무한정 우려먹지 못하게).
    rewardUses: { FLASH_ALL: 0, PEEK_CELL: 0, ROW_COUNT: 0, COL_COUNT: 0 },
  };
}
// 남은(타입이 아직 null인) 칸들을 보석/해독제/빈칸으로 비율대로 채운다 — 전반 풀 채우기와
// 후반 풀 채우기 양쪽에서 재사용한다.
function fillPoolProportional(room, cells) {
  const n = cells.length;
  if (n === 0) return;
  const gemN = Math.round(n * CONFIG.POOL_GEM_RATIO);
  const antN = Math.round(n * CONFIG.POOL_A_RATIO);
  const emptyN = Math.max(0, n - gemN - antN);
  const pool = shuffle([
    ...Array(gemN).fill('GEM'),
    ...Array(antN).fill('A'),
    ...Array(emptyN).fill('E'),
  ]);
  cells.forEach(({ row, col }, i) => { room[row][col].type = pool[i]; });
}
function pickRandomCells(cells, n) { return shuffle(cells).slice(0, Math.max(0, Math.min(n, cells.length))); }
let matchSeq = 0;
function freshMatch() {
  matchSeq += 1;
  return {
    seq: matchSeq, // 새 매치(재대전 포함)마다 증가 — 클라이언트가 화면/입력 상태를 리셋하는 신호로 사용
    // LOBBY, SETUP, SETUP_DONE, ROUND_COUNTDOWN, ROUND_MINIGAME, ROUND_ACTION, ROUND_DONE,
    // MID_SETUP(전반 종료 후 독 추가 설치), MID_SETUP_DONE, END
    phase: 'LOBBY',
    players: {}, order: [],
    setupSelections: {},
    setupPreview: {}, // 확정 전 실시간 선택 상태 — 관리자 화면 전용(상대 플레이어에게는 절대 내려주지 않음)
    midSetupSelections: {}, // 중반 독 추가 설치(각자 상대 처소에 2칸) 확정 상태
    round: 0, minigameOrder: buildMinigameOrder(), minigame: null,
    countdownEndsAt: null, // ROUND_COUNTDOWN 동안 3-2-1이 몇 시에 끝나는지(클라이언트가 직접 카운트다운을 그리는 기준)
    setupDoneEndsAt: null, // SETUP_DONE(양쪽 독배 설치 완료 안내) 대기가 몇 시에 끝나는지
    midSetupDoneEndsAt: null, // MID_SETUP_DONE(중반 재설치 완료 안내) 대기가 몇 시에 끝나는지
    pendingReward: null, // 이번 라운드 미니게임 승자가 고를(또는 이미 고른) 보상 — { winnerId, choices, type, used, expiresAt }
    actionOpens: {}, // 라운드 액션(칸 열기)은 이제 순서 교대가 아니라 각자 독립적으로 동시에 진행됨
    streak: { winnerId: null, count: 0 }, // 미니게임 연승 스트릭 — 무승부나 승자가 바뀌면 끊긴다
    rematchReady: {},
    log: [], winner: null, endReason: null,
    // 4대 분리 모드(/game/A, /pick/A, /game/B, /pick/B로 접속) 여부 — 이 모드일 때만 처소 열기
    // 결과가 상대에게도 실시간 공개된다. 기존 방식(주소 하나로 2명이 접속)은 이 값이 계속 false로
    // 남아 있어 히든정보 규칙이 그대로 유지된다.
    splitMode: false,
  };
}
let match = freshMatch();
// 소켓ID → 슬롯('A'/'B') 매핑, 그리고 슬롯별로 지금 연결된 소켓ID 집합.
// "게임용" 기기와 "고르기용" 기기가 같은 슬롯(같은 플레이어)을 공유할 수 있으므로,
// 슬롯 하나에 소켓이 여러 개 붙을 수 있다 — 연결이 끊길 때는 그 슬롯의 소켓이 전부 사라졌을 때만
// "연결 끊김"으로 표시한다.
const socketSlot = {};
const slotSockets = { A: new Set(), B: new Set() };

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
  log(`셋업 시작 — 상대 왕자의 처소(전반 6×${CONFIG.ROWS_FIRST_HALF}칸)에 독 술잔 ${CONFIG.POISON_INITIAL}개를 몰래 지정하세요.`);
  broadcastState();
}

function finalizeSetup() {
  // 1) 독 배치 — setupSelections[id] = 그 플레이어가 "상대방" 처소(전반 24칸 안)에 지정한 좌표.
  for (const id of match.order) {
    const victim = otherId(id);
    const poisonCells = match.setupSelections[id];
    const room = match.players[victim].room;
    for (const { row, col } of poisonCells) room[row][col].type = 'P';
  }
  // 2) 가문의 문장 1차 배치 — 독이 아닌 전반 24칸 중 무작위 5~6개. 매치·플레이어마다 독립적으로
  //    무작위라 몇 개가 들어갔는지는 본인도 모른다(칸을 열어보며 우연히 발견하는 서프라이즈).
  for (const id of match.order) {
    const player = match.players[id];
    const room = player.room;
    const candidates = [];
    for (let r = 0; r < CONFIG.ROWS_FIRST_HALF; r++) {
      for (let c = 0; c < CONFIG.GRID; c++) {
        if (room[r][c].type === null) candidates.push({ row: r, col: c });
      }
    }
    const crestCount = randInt(CONFIG.CREST_WAVE1_MIN, CONFIG.CREST_WAVE1_MAX);
    const chosen = pickRandomCells(candidates, crestCount);
    for (const { row, col } of chosen) room[row][col].type = 'C';
    player.crestTotal += chosen.length;
  }
  // 3) 나머지 전반 칸(독·문장을 뺀 칸)을 보석/해독제/빈칸으로 비율대로 채운다.
  for (const id of match.order) {
    const room = match.players[id].room;
    const remaining = [];
    for (let r = 0; r < CONFIG.ROWS_FIRST_HALF; r++) {
      for (let c = 0; c < CONFIG.GRID; c++) {
        if (room[r][c].type === null) remaining.push({ row: r, col: c });
      }
    }
    fillPoolProportional(room, remaining);
  }
  log(`양쪽 처소(전반 6×${CONFIG.ROWS_FIRST_HALF}) 구성 완료. 총 ${CONFIG.ROUNDS_TOTAL}라운드(전반 ${CONFIG.ROUNDS_FIRST_HALF}·후반 ${CONFIG.ROUNDS_TOTAL - CONFIG.ROUNDS_FIRST_HALF})의 본게임을 시작합니다.`);
  // "선택하자마자 바로 게임으로 넘어가서 상황 인지가 어렵다"는 피드백 — 독배 설치가 끝났다는 걸
  // 잠깐 보여준 뒤(SETUP_DONE, 5초)에야 원래 있던 1라운드 3-2-1 카운트다운(startRound)으로 넘어간다.
  match.phase = 'SETUP_DONE';
  match.setupDoneEndsAt = Date.now() + CONFIG.SETUP_DONE_MS;
  const seqAtSetupDone = match.seq;
  broadcastState();
  setTimeout(() => {
    // 이 사이 재대전/재시작 등으로 매치가 이미 다른 상태가 됐다면 낡은 타이머이므로 무시한다.
    if (match.seq !== seqAtSetupDone || match.phase !== 'SETUP_DONE') return;
    match.setupDoneEndsAt = null;
    match.round = 0;
    startRound();
  }, CONFIG.SETUP_DONE_MS);
}

// ------------------------------ 중반 재설치(처소 확장) ------------------------
// 전반(8라운드)이 끝나면 처소가 6×4(24칸)에서 6×6(36칸)으로 확장되고, 서로의 처소에 독을
// 2개씩 추가로 몰래 심는다 — 대상은 "아직 안 연 칸"(옛 24칸의 남은 칸 + 새로 열리는 12칸
// 전부)이라, 상대가 모르고 고른 자리가 하필 이미 정해져 있던 문장 조각이었을 수도 있다.
function startMidSetup() {
  match.phase = 'MID_SETUP';
  match.midSetupSelections = {};
  log(`전반 종료 — 처소가 6×${CONFIG.ROWS_TOTAL}으로 확장됩니다. 상대 왕자의 아직 열리지 않은 칸 중 ${CONFIG.POISON_MID}곳에 독을 추가로 몰래 지정하세요.`);
  broadcastState();
}

function finalizeMidSetup() {
  // 1) 확장되는 12칸의 잠금을 먼저 해제한다(아직 타입은 null인 채로).
  for (const id of match.order) {
    const room = match.players[id].room;
    for (let r = CONFIG.ROWS_FIRST_HALF; r < CONFIG.ROWS_TOTAL; r++) {
      for (let c = 0; c < CONFIG.GRID; c++) room[r][c].locked = false;
    }
  }
  // 2) 중반 독 배치 — 안 연 칸(옛 칸이든 새 칸이든) 중 상대가 고른 자리를 그대로 독으로 덮어쓴다.
  //    하필 그 자리가 이미 정해져 있던 1차 문장 조각이었다면("문장 저격"), 그 조각은 독으로
  //    사라지는 대신 crestTotal에서도 함께 빼줘야 한다 — 안 그러면 실제 처소에는 문장이
  //    crestTotal개보다 적게 남는데도 목표치는 그대로라, 그 라운드부터는 아무리 다 찾아도
  //    "문장 완성 즉시승리"를 영영 달성할 수 없는 상태가 되어버린다.
  for (const id of match.order) {
    const victim = otherId(id);
    const victimPlayer = match.players[victim];
    const cells = match.midSetupSelections[id] || [];
    const room = victimPlayer.room;
    for (const { row, col } of cells) {
      if (room[row][col].type === 'C') victimPlayer.crestTotal -= 1;
      room[row][col].type = 'P';
    }
  }
  // 3) 가문의 문장 2차 배치 — 새로 열린 12칸 중, 방금 독이 되지 않은 칸에서만 무작위 3~4개.
  for (const id of match.order) {
    const player = match.players[id];
    const room = player.room;
    const candidates = [];
    for (let r = CONFIG.ROWS_FIRST_HALF; r < CONFIG.ROWS_TOTAL; r++) {
      for (let c = 0; c < CONFIG.GRID; c++) {
        if (room[r][c].type === null) candidates.push({ row: r, col: c });
      }
    }
    const crestCount = randInt(CONFIG.CREST_WAVE2_MIN, CONFIG.CREST_WAVE2_MAX);
    const chosen = pickRandomCells(candidates, crestCount);
    for (const { row, col } of chosen) room[row][col].type = 'C';
    player.crestTotal += chosen.length;
  }
  // 4) 새 12칸 중 아직 안 정해진 나머지를 보석/해독제/빈칸으로 채운다(옛 24칸은 이미 다 채워져 있음).
  for (const id of match.order) {
    const room = match.players[id].room;
    const remaining = [];
    for (let r = CONFIG.ROWS_FIRST_HALF; r < CONFIG.ROWS_TOTAL; r++) {
      for (let c = 0; c < CONFIG.GRID; c++) {
        if (room[r][c].type === null) remaining.push({ row: r, col: c });
      }
    }
    fillPoolProportional(room, remaining);
  }
  log(`중반 독 추가 설치 및 처소 확장 완료 — 후반 ${CONFIG.ROUNDS_TOTAL - CONFIG.ROUNDS_FIRST_HALF}라운드를 시작합니다.`);
  match.phase = 'MID_SETUP_DONE';
  match.midSetupDoneEndsAt = Date.now() + CONFIG.MID_SETUP_DONE_MS;
  const seqAtMidDone = match.seq;
  broadcastState();
  setTimeout(() => {
    if (match.seq !== seqAtMidDone || match.phase !== 'MID_SETUP_DONE') return;
    match.midSetupDoneEndsAt = null;
    startRound();
  }, CONFIG.MID_SETUP_DONE_MS);
}

// ------------------------------ 라운드 / 미니게임 ----------------------------
// "게임이 무지성으로 시작된다"는 피드백에 따라, 미니게임을 곧장 시작하지 않고 먼저 3-2-1
// 카운트다운(+ 다음 미니게임 이름 예고)을 보여준 뒤에야 실제로 시작한다. REFLEX의 무작위
// 신호 지연이나 BOMB의 실시간 퓨즈처럼 initMinigame()이 걸어두는 setTimeout은 전부 "실제
// 미니게임이 시작되는 시점"에만 걸려야 하므로, initMinigame() 호출 자체를 카운트다운이
// 끝난 뒤로 미룬다 — 그래야 카운트다운을 보는 동안 몰래 시간이 깎이지 않는다.
function startRound() {
  match.round += 1;
  match.phase = 'ROUND_COUNTDOWN';
  match.minigame = null;
  match.pendingReward = null;
  match.countdownEndsAt = Date.now() + CONFIG.ROUND_COUNTDOWN_MS;
  const type = match.minigameOrder[match.round - 1];
  const roundAtCountdown = match.round;
  log(`--- ${match.round}/${CONFIG.ROUNDS_TOTAL}라운드 준비 : 미니게임 [${MINIGAME_NAMES[type]}] — 곧 시작합니다 ---`);
  broadcastState();
  setTimeout(() => {
    // 재대전 등으로 매치가 이미 다른 상태로 넘어갔다면 낡은 타이머이므로 무시한다.
    if (match.phase !== 'ROUND_COUNTDOWN' || match.round !== roundAtCountdown) return;
    match.phase = 'ROUND_MINIGAME';
    match.countdownEndsAt = null;
    match.minigame = initMinigame(type, match.round);
    log(`--- ${match.round}/${CONFIG.ROUNDS_TOTAL}라운드 시작 : 미니게임 [${MINIGAME_NAMES[type]}] ---`);
    broadcastState();
  }, CONFIG.ROUND_COUNTDOWN_MS);
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
    // 실시간(ms) 퓨즈로 터진다 — 정해진 시간이 다 되면 그 순간 폭탄을 들고 있는 사람이 진다.
    // 남은 시간을 화면에 그대로 보여주므로(expiresAt), 클라이언트가 직접 카운트다운을 계산한다.
    const delay = randInt(CONFIG.BOMB_FUSE_MS_MIN, CONFIG.BOMB_FUSE_MS_MAX);
    const mgBomb = { ...base, holder: firstIsA ? a : b, passes: 0, expiresAt: Date.now() + delay };
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
    // 숨겨진 확률(팝 포인트)이 아니라, 8~12개의 안전핀 중 하나가 미리 정해진 폭탄이고
    // 두 사람이 번갈아 직접 핀을 하나씩 골라 뽑는 방식 — 폭탄을 뽑은 사람이 진다.
    const pinCount = randInt(CONFIG.PIN_COUNT_MIN, CONFIG.PIN_COUNT_MAX);
    return { ...base, turn: firstIsA ? a : b, pinCount, bombIndex: randInt(0, pinCount - 1), pulled: Array(pinCount).fill(false), pulls: 0 };
  }
  if (type === 'SIGIL') {
    return { ...base, picks: {} };
  }
  if (type === 'GUESS_COUNT') {
    // 너무 쉽다는 피드백 반영: 와인잔 개수 범위를 15~30으로 넓혀(눈으로 정확히 세기 어렵게) 노출 시간도 짧게 준다.
    return { ...base, trueCount: randInt(CONFIG.GUESS_COUNT_MIN, CONFIG.GUESS_COUNT_MAX), guesses: {}, guessOrder: [] };
  }
  if (type === 'BANK') {
    // 하나의 금고를 공유하는 게 아니라, 두 사람이 각자 자신만의 금고(컴퓨터가 무작위로 정한 서로 다른
    // 정답)를 갖고 동시에 독립적으로 숫자야구를 진행한다 — 자기 금고를 먼저 여는 쪽이 승리.
    return {
      ...base,
      secrets: { [a]: randomDistinctDigits(CONFIG.BANK_DIGITS), [b]: randomDistinctDigits(CONFIG.BANK_DIGITS) },
      history: { [a]: [], [b]: [] },
    };
  }
  if (type === 'BLUFF') {
    // 허세 배팅 — 동시에 몰래 1~3 중 하나를 "배팅"하고 공개. 더 큰 숫자를 낸 쪽이 승리.
    // 같은 숫자를 내면 정면충돌로 둘 다 허탕(무승부) — 재입력 없이 그대로 다음 라운드로 넘어간다.
    return { ...base, picks: {} };
  }
  if (type === 'LIAR_DIE') {
    // 라이어 주사위 — 선언자만 몰래 주사위(1~6)를 굴려 자신만 확인하고, 그 숫자가 "높다(4~6)"인지
    // "낮다(1~3)"인지를 선언한다(진실/거짓 가능). 상대는 그 선언을 믿을지(그대로 선언자 승리) 의심할지
    // (실제 주사위를 공개해 진위 판정) 고른다 — 표정/패턴을 읽는 심리전 + 주사위 자체의 운.
    return { ...base, declarer: firstIsA ? a : b, responder: firstIsA ? b : a, roll: randInt(1, 6), claim: null, decision: null };
  }
  if (type === 'GAMBIT') {
    // 황금 잔 허세 대결 — 각자 몰래 GOLD(강함)/GLASS(약함) 패를 받는다(각자 독립 50/50).
    // 동시에 PUSH(밀어붙인다)/YIELD(물러난다)를 고른다: 둘 다 YIELD면 무승부, 하나만 PUSH면
    // PUSH가 자동 승리, 둘 다 PUSH면 카드를 공개해 GOLD가 GLASS를 이긴다(같은 패면 무승부).
    // 내 패가 약해도 밀어붙이면 상대가 물러날 수 있다는 점이 허세/블러핑의 핵심.
    return { ...base, cards: { [a]: Math.random() < 0.5 ? 'GOLD' : 'GLASS', [b]: Math.random() < 0.5 ? 'GOLD' : 'GLASS' }, actions: {} };
  }
  return base;
}

function endMinigame(winnerId) {
  const loserId = otherId(winnerId);
  match.minigame.result = winnerId;

  // 연승 스트릭 — 같은 사람이 계속 이기면 카운트 증가, 승자가 바뀌면 1로 리셋.
  if (match.streak.winnerId === winnerId) match.streak.count += 1;
  else match.streak = { winnerId, count: 1 };

  // "보상은 승자가 직접 고르는 구조로" — 이제 라운드 시작 전 보상이 미리 하나로 고정되지 않고,
  // 미니게임 승자가 후보 중 하나를 스스로 골라야 종류(type)가 정해진다. 단, 종류별로 이미
  // REWARD_USE_LIMIT(3)번을 다 쓴 종류는 후보에서 빠진다 — 한 종류만 무한정 우려먹지 못하게.
  const winner = match.players[winnerId];
  let availableTypes = REWARD_TYPES.filter((t) => (winner.rewardUses[t] || 0) < CONFIG.REWARD_USE_LIMIT);
  // 네 종류를 전부 다 써버린 극단적인 경우(이론상 라운드 수가 아주 많아야 가능)에는 선택지가
  // 텅 비는 것보다는, 그냥 모든 종류를 다시 후보로 열어주는 쪽이 안전하다.
  if (availableTypes.length === 0) availableTypes = REWARD_TYPES.slice();
  match.pendingReward = {
    winnerId,
    choices: shuffle(availableTypes),
    type: null, // handleRewardChoose에서 채워짐
    used: false,
    fireAt: null, // 섬광 정찰(FLASH_ALL)에서만 쓰는, 실제로 터지는 정확한 시각
  };

  // 본행동(칸 열기)은 더 이상 순서 교대가 아니라 두 사람이 동시에 독립적으로 진행한다.
  match.actionOpens = {};
  match.phase = 'ROUND_ACTION';
  log(`미니게임 승리: ${match.players[winnerId].name} → 보상을 직접 고릅니다.`);
  broadcastState();
}

// "둘 다 정답을 맞히지 못함" 같은 무승부가 나는 미니게임을 위한 범용 처리 — 승자를 억지로
// 정해 보상까지 챙겨주지 않고, 이번 라운드는 그냥 보상 없이 본행동으로 넘어간다. (현재 남아있는
// 8종 미니게임 중에는 실제로 무승부가 나는 종류가 없어 당장은 호출되지 않지만, 이후 무승부가
// 가능한 미니게임을 추가할 때 재사용할 수 있도록 남겨둔다.)
function endMinigameDraw() {
  match.minigame.result = 'DRAW';
  match.pendingReward = null;
  match.actionOpens = {};
  match.phase = 'ROUND_ACTION';
  match.streak = { winnerId: null, count: 0 }; // 무승부는 스트릭을 끊는다
  log('무승부 — 이번 라운드는 보상 없이 넘어갑니다.');
  broadcastState();
}

// 미니게임 승자가 여러 보상 후보 중 하나를 직접 골라 확정한다.
function handleRewardChoose(id, payload) {
  const pr = match.pendingReward;
  if (!pr || pr.winnerId !== id || pr.type) return; // 승자가 아니거나 이미 골랐으면 무시
  const type = payload && payload.type;
  if (!pr.choices.includes(type)) return;
  pr.type = type;
  log(`${match.players[id].name}이 보상으로 [${REWARD_NAMES[type]}]을(를) 선택했습니다.`);

  // 섬광 정찰은 직접 "사용" 버튼을 누르는 게 아니라, 고른 후 0~10초(REWARD_FLASH_MS_MIN~MAX) 사이의
  // 무작위 순간에 자동으로 REWARD_FLASH_REVEAL_MS만큼 내 처소 전체가 드러나는 방식이다. 언제 터질지는
  // 클라이언트에 알려주지 않아 기습적으로 느껴지게 하고, doAction()에서는 그 순간이 오기 전까지는
  // 칸을 열 수 없게 막는다 — 미리 봐야 의미 있는 정보인데 칸부터 다 열어버리면 쓸모가 없어지기 때문.
  if (type === 'FLASH_ALL') {
    const roundAtGrant = match.round;
    const fireDelay = randInt(CONFIG.REWARD_FLASH_MS_MIN, CONFIG.REWARD_FLASH_MS_MAX);
    pr.fireAt = Date.now() + fireDelay;
    setTimeout(() => {
      if (match.round === roundAtGrant && match.pendingReward && match.pendingReward.winnerId === id && !match.pendingReward.used) {
        match.pendingReward.used = true;
        const winner = match.players[id];
        winner.rewardUses.FLASH_ALL = (winner.rewardUses.FLASH_ALL || 0) + 1;
        const room = winner.room.map((r) => r.map((cell) => cell.type));
        actionLog(winner, `보상 발동 — 섬광 정찰로 내 처소 전체가 ${(CONFIG.REWARD_FLASH_REVEAL_MS / 1000).toFixed(1)}초간 드러났습니다.`);
        io.to(id).emit('rewardResult', { kind: 'FLASH_ALL', room, revealMs: CONFIG.REWARD_FLASH_REVEAL_MS });
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
  if (mg.type === 'BANK') return handleBank(id, payload, mg);
  if (mg.type === 'BLUFF') return handleBluff(id, payload, mg);
  if (mg.type === 'LIAR_DIE') return handleLiarDie(id, payload, mg);
  if (mg.type === 'GAMBIT') return handleGambit(id, payload, mg);
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

// 5) 안전핀 뽑기 배팅 — N개(8~12) 안전핀 중 하나가 폭탄, 번갈아 직접 하나씩 골라 뽑는다(순수 확률형)
function handlePin(id, payload, mg) {
  if (mg.turn !== id) return;
  if (payload.action !== 'PICK') return;
  const index = Number(payload.index);
  if (!Number.isInteger(index) || index < 0 || index >= mg.pinCount || mg.pulled[index]) return;
  mg.pulled[index] = true;
  mg.pulls += 1;
  if (index === mg.bombIndex) {
    log(`펑! ${match.players[id].name}이 폭탄 안전핀을 뽑았습니다. (${mg.pulls}번째 핀)`);
    broadcastState();
    return endMinigame(otherId(id));
  }
  log(`${match.players[id].name}이 안전핀을 뽑았습니다 — 무사합니다. (${mg.pulls}번째 핀)`);
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
  if (!Number.isInteger(g) || g < 0 || g > CONFIG.GUESS_COUNT_MAX) return;
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
  // 자릿수별 결과(marks)를 함께 저장해, 화면에서 칸 자체를 초록(스트라이크)/노랑(볼)/기본(미스)으로
  // 바로 칠할 수 있게 한다 — 숫자로만 "2스트라이크 1볼"이라고 알려주는 것보다 한눈에 들어온다.
  const marks = guess.map((d, i) => (secret[i] === d ? 'S' : secret.includes(d) ? 'B' : 'X'));
  const strikes = marks.filter((m) => m === 'S').length;
  const balls = marks.filter((m) => m === 'B').length;
  mg.history[id].push({ guess: guess.slice(), strikes, balls, marks });
  const outcome = strikes === 0 && balls === 0 ? '아웃' : `${strikes}스트라이크 ${balls}볼`;
  log(`${match.players[id].name}: 자신의 금고에 ${guess.join('')} 시도 → ${outcome}`);
  if (strikes === CONFIG.BANK_DIGITS) {
    log(`${match.players[id].name}이 자신의 금고를 열었습니다! (번호: ${secret.join('')})`);
    broadcastState();
    return endMinigame(id);
  }
  broadcastState();
}

// 11) 허세 배팅 — 동시에 몰래 1~3 배팅, 큰 쪽 승리, 동수는 무승부(심리+대박형)
function handleBluff(id, payload, mg) {
  if (mg.picks[id]) return;
  const stake = Number(payload && payload.stake);
  if (![1, 2, 3].includes(stake)) return;
  mg.picks[id] = stake;
  const [a, b] = match.order;
  if (mg.picks[a] != null && mg.picks[b] != null) {
    log(`허세 배팅 공개: ${match.players[a].name}=${mg.picks[a]} vs ${match.players[b].name}=${mg.picks[b]}`);
    if (mg.picks[a] === mg.picks[b]) {
      broadcastState();
      log('정면충돌! 같은 배팅 — 둘 다 허탕입니다.');
      return endMinigameDraw();
    }
    broadcastState();
    return endMinigame(mg.picks[a] > mg.picks[b] ? a : b);
  }
  broadcastState();
}

// 12) 라이어 주사위 — 선언자의 "높다/낮다" 선언을 믿을지 의심할지(심리) + 실제 주사위(운)
function handleLiarDie(id, payload, mg) {
  if (id === mg.declarer && mg.claim == null) {
    if (!['HIGH', 'LOW'].includes(payload && payload.claim)) return;
    mg.claim = payload.claim;
    log(`${match.players[mg.declarer].name}이 "내 주사위는 ${mg.claim === 'HIGH' ? '높다(4~6)' : '낮다(1~3)'}"라고 선언했습니다.`);
    broadcastState();
    return;
  }
  if (id === mg.responder && mg.claim != null && mg.decision == null) {
    if (!['TRUST', 'DOUBT'].includes(payload && payload.decision)) return;
    mg.decision = payload.decision;
    if (mg.decision === 'TRUST') {
      log(`${match.players[mg.responder].name}이 선언을 그대로 믿었습니다 — 진실은 아무도 모른 채 넘어갑니다.`);
      broadcastState();
      return endMinigame(mg.declarer);
    }
    const actualRange = mg.roll >= 4 ? 'HIGH' : 'LOW';
    const wasTrue = actualRange === mg.claim;
    log(`${match.players[mg.responder].name}이 의심했습니다 — 실제 주사위는 ${mg.roll}이었습니다 (선언은 ${wasTrue ? '진실' : '거짓'}).`);
    broadcastState();
    return endMinigame(wasTrue ? mg.declarer : mg.responder);
  }
}

// 13) 황금 잔 허세 대결 — 몰래 받은 패(강/약)를 숨긴 채 밀어붙일지 물러날지 동시에 결정(블러핑형)
function handleGambit(id, payload, mg) {
  if (mg.actions[id]) return;
  if (!['PUSH', 'YIELD'].includes(payload && payload.action)) return;
  mg.actions[id] = payload.action;
  const [a, b] = match.order;
  if (mg.actions[a] && mg.actions[b]) {
    log(`대결 공개: ${match.players[a].name}=${mg.cards[a]}/${mg.actions[a]} vs ${match.players[b].name}=${mg.cards[b]}/${mg.actions[b]}`);
    broadcastState();
    if (mg.actions[a] === 'YIELD' && mg.actions[b] === 'YIELD') {
      log('둘 다 물러났습니다 — 무승부.');
      return endMinigameDraw();
    }
    if (mg.actions[a] === 'PUSH' && mg.actions[b] === 'YIELD') return endMinigame(a);
    if (mg.actions[b] === 'PUSH' && mg.actions[a] === 'YIELD') return endMinigame(b);
    // 둘 다 PUSH — 카드로 승부(같은 패면 무승부)
    if (mg.cards[a] === mg.cards[b]) {
      log('둘 다 밀어붙였지만 같은 패 — 무승부.');
      return endMinigameDraw();
    }
    return endMinigame(mg.cards[a] === 'GOLD' ? a : b);
  }
  broadcastState();
}

// ------------------------------ 본행동(액션) ---------------------------------
// 본행동: 내 턴이 되면 내 처소에서 술잔 CONFIG.OPENS_PER_TURN(기본 2)개를 직접 골라 연다.
// (아이템/단서 획득 같은 별도 행동 선택 없이, 정찰은 미니게임 보상으로만 얻는다.)
function doAction(id, kind, payload) {
  if (match.phase !== 'ROUND_ACTION') return;
  if (kind !== 'OPEN') return;
  const pr = match.pendingReward;
  // 섬광 정찰(FLASH_ALL)을 골랐다면, 실제로 번쩍여서 내 처소가 드러나는 그 순간을 먼저 겪은
  // 뒤에야 칸을 열 수 있다 — 정보를 보기도 전에 칸부터 다 열어버리면 보상의 의미가 없어진다.
  if (pr && pr.winnerId === id && pr.type === 'FLASH_ALL' && !pr.used) return;
  const opens = match.actionOpens[id] || 0;
  if (opens >= CONFIG.OPENS_PER_TURN) return; // 이미 이번 라운드 몫을 다 열었음
  const player = match.players[id];
  const { row, col } = payload;
  if (row == null || col == null || row < 0 || row >= CONFIG.ROWS_TOTAL || col < 0 || col >= CONFIG.GRID) return;
  const cell = player.room[row][col];
  if (cell.locked) return; // 아직 후반에 열리지 않은(전반에는 존재하지 않는) 칸
  if (cell.opened) return;
  if (cell.type == null) return; // 안전장치 — 아직 타입이 정해지지 않은 칸
  resolveOpen(player, row, col, cell);
  match.actionOpens[id] = opens + 1;
  // 문장을 전부 열어 완성했다면 그 즉시 왕위를 차지한다 — 라운드 진행 중이어도 즉시 종료.
  // crestTotal은 전반+후반 배치가 모두 끝나야 확정되므로, 0인 동안(예: 전반 셋업 직후에도
  // 이론상 0일 수는 없지만 방어적으로) 오판하지 않도록 함께 확인한다.
  if (player.crestTotal > 0 && player.crestOpened >= player.crestTotal) {
    return endMatch(`${player.name}이(가) 가문의 문장을 완성하여 왕위를 차지했습니다!`, player.id);
  }
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
  } else if (t === 'GEM') {
    player.score += CONFIG.GEM_PTS;
  } else if (t === 'A') {
    player.antidote += 1;
    checkNeutralize(player);
  } else if (t === 'C') {
    player.crestOpened += 1;
    player.score += CONFIG.CREST_PTS;
    // 총 몇 조각인지는 본인에게도 비공개이므로 분모 없이 발견 개수만 남긴다.
    actionLog(player, `가문의 문장 조각을 발견했습니다! (지금까지 ${player.crestOpened}개째)`);
    if (player.crestOpened >= player.crestTotal) {
      player.score += CONFIG.CREST_BONUS;
      actionLog(player, `문장 완성 보너스 +${CONFIG.CREST_BONUS}점!`);
    }
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
  if (!pr || pr.winnerId !== id || pr.used || !pr.type) return; // 보상 종류를 아직 안 골랐으면 사용 불가
  const player = match.players[id];
  const opp = match.players[otherId(id)];
  if (!opp) return;

  // 보상 4종은 모두 "내 처소"(내가 실제로 술잔을 여는 곳)를 정찰하는 도구다.
  // 상대 처소는 내가 어떤 행동도 할 수 없는 곳이라 정찰해도 쓸 데가 없으므로,
  // 기존 아이템(은수저/소믈리에의 코)과 동일하게 자신의 방을 대상으로 한다.
  // (섬광 정찰은 직접 사용하는 게 아니라 endMinigame()에서 무작위 시점에 자동 발동된다.)
  if (pr.type === 'PEEK_CELL') {
    const row = Number(payload.row), col = Number(payload.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= CONFIG.ROWS_TOTAL || col < 0 || col >= CONFIG.GRID) return;
    if (player.room[row][col].locked) return; // 아직 후반에 열리지 않은 칸은 정찰 대상이 될 수 없다
    pr.used = true;
    player.rewardUses.PEEK_CELL = (player.rewardUses.PEEK_CELL || 0) + 1;
    const type = player.room[row][col].type;
    actionLog(player, `보상 사용 — 내 처소 (${row + 1},${col + 1}) 정찰 → ${CELL_NAMES[type]}`);
    io.to(id).emit('rewardResult', { kind: 'PEEK_CELL', row, col, type });
    broadcastState();
    return;
  }
  if (pr.type === 'ROW_COUNT' || pr.type === 'COL_COUNT') {
    // "몇 행에 몇 개"처럼 한 줄만 알려주는 게 아니라, 종류 하나만 고르면 6개 가로줄(또는 세로줄)
    // 전부의 개수를 한 번에 알려준다 — 줄 번호는 더 이상 직접 고르지 않는다.
    const axis = pr.type === 'ROW_COUNT' ? 'row' : 'col';
    const targetType = payload.targetType;
    if (!CLUE_CATS.includes(targetType)) return;
    pr.used = true;
    player.rewardUses[pr.type] = (player.rewardUses[pr.type] || 0) + 1;
    // 가로줄(row) 개수는 전반/후반에 따라 4개 또는 6개로 달라지지만, 세로줄(col)은 늘 6개다.
    // 아직 잠긴(후반에 열리는) 줄은 타입이 없어 자연히 0으로 집계된다.
    const rowN = CONFIG.ROWS_TOTAL, colN = CONFIG.GRID;
    const outerN = axis === 'row' ? rowN : colN;
    const innerN = axis === 'row' ? colN : rowN;
    const counts = [];
    for (let idx = 0; idx < outerN; idx++) {
      let count = 0;
      for (let i = 0; i < innerN; i++) {
        const cell = axis === 'row' ? player.room[idx][i] : player.room[i][idx];
        if (!cell.locked && cell.type === targetType) count += 1;
      }
      counts.push(count);
    }
    const axisLabel = axis === 'row' ? '가로줄' : '세로줄';
    actionLog(player, `보상 사용 — 내 처소 각 ${axisLabel}의 ${CLUE_CAT_NAMES[targetType]} 개수 확인 → [${counts.join(', ')}]`);
    io.to(id).emit('rewardResult', { kind: pr.type, targetType, counts });
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
  if (match.round >= CONFIG.ROUNDS_TOTAL) return endMatchByScore();
  // 전반 마지막 라운드가 끝나면 다음 라운드로 바로 넘어가지 않고, 처소 확장 + 중반 독 추가
  // 설치(MID_SETUP)를 먼저 거친다.
  if (match.round === CONFIG.ROUNDS_FIRST_HALF) return startMidSetup();
  // "칸을 다 열자마자 바로 다음 라운드로 넘어가서 상황 인지가 어렵다"는 피드백 — SETUP_DONE과
  // 같은 패턴으로, 이번 라운드가 끝났다는 걸 5초간 보여준 뒤에야 다음 라운드 3-2-1 카운트다운으로
  // 넘어간다. 마지막 라운드(위의 endMatchByScore 분기)는 "다음 라운드"가 없으므로 대상이 아니다.
  match.phase = 'ROUND_DONE';
  const seqAtRoundDone = match.seq;
  const roundAtDone = match.round;
  broadcastState();
  setTimeout(() => {
    // 이 사이 재대전/재시작 등으로 매치가 이미 다른 상태가 됐다면 낡은 타이머이므로 무시한다.
    if (match.seq !== seqAtRoundDone || match.phase !== 'ROUND_DONE' || match.round !== roundAtDone) return;
    startRound();
  }, CONFIG.ROUND_DONE_MS);
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
    reason = `${CONFIG.ROUNDS_TOTAL}라운드 종료 — 최종 점수 비교 승리 (독배 -${CONFIG.POISON_PENALTY}점 반영)`;
  } else if (pa.poison !== pb.poison) {
    // 최종 점수가 완전히 같으면, 무효화하지 못한 독을 더 적게 마신 쪽(더 안전하게 버틴 쪽)이 승리한다.
    winner = pa.poison < pb.poison ? a : b;
    reason = `${CONFIG.ROUNDS_TOTAL}라운드 종료 — 점수 동률, 무효화하지 못한 독 개수로 승부 판정`;
  } else {
    reason = `${CONFIG.ROUNDS_TOTAL}라운드 종료 — 점수·독 개수 완전 동률(무승부)`;
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
      locked: cell.locked,
      type: cell.opened || revealAll ? cell.type : (cell.cluedType || null),
      note: cell.cluedNote || null,
    })));

  const pr = match.pendingReward;
  return {
    seq: match.seq,
    phase: match.phase,
    round: match.round,
    roundsTotal: CONFIG.ROUNDS_TOTAL,
    roundsFirstHalf: CONFIG.ROUNDS_FIRST_HALF,
    minigame: match.minigame && {
      type: match.minigame.type,
      name: MINIGAME_NAMES[match.minigame.type],
      // 클라이언트에 필요한 진행상황만 노출 (히든정보 보호)
      public: publicMinigameView(match.minigame, forId),
      // 라운드가 끝난 뒤(ROUND_ACTION 동안)에도 match.minigame은 그대로 남아있으므로, 방금 끝난
      // 미니게임의 승패를 결과 요약 배너에 쓸 수 있게 승/패/무승부만 알려준다(구체적 정답은 각
      // 타입의 public 필드에서 이미 필요한 만큼만 공개됨).
      result: match.minigame.result == null ? null : match.minigame.result === 'DRAW' ? 'draw' : (match.minigame.result === forId ? 'me' : 'opp'),
    },
    // 라운드 시작 전 3-2-1 카운트다운 — 몇 시에 끝나는지만 내려주고 클라이언트가 직접 숫자를 센다.
    countdownEndsAt: match.phase === 'ROUND_COUNTDOWN' ? match.countdownEndsAt : null,
    nextMinigameName: match.phase === 'ROUND_COUNTDOWN' ? MINIGAME_NAMES[match.minigameOrder[match.round - 1]] : null,
    // 보상은 승자가 직접 고르는 구조 — type이 아직 null이면 choices 중 하나를 골라야 한다.
    // FLASH_ALL은 정확히 언제 터지는지(fireAt)를 클라이언트에 내려주지 않는다 — "몇 초 후 터집니다"
    // 카운트다운이 없어야 기습적으로 느껴진다는 피드백. doAction()에서는 서버가 들고 있는 pr.fireAt
    // 기준으로 여전히 그 순간이 오기 전까지 칸 열기를 막는다.
    myReward: pr && pr.winnerId === forId ? {
      type: pr.type,
      name: pr.type ? REWARD_NAMES[pr.type] : null,
      used: pr.used,
      choices: pr.type ? null : pr.choices.map((t) => ({
        type: t, name: REWARD_NAMES[t],
        usesLeft: CONFIG.REWARD_USE_LIMIT - (me.rewardUses[t] || 0),
      })),
    } : null,
    oppHasReward: !!(pr && pr.winnerId !== forId && !pr.used),
    oppChoosingReward: !!(pr && pr.winnerId !== forId && !pr.type),
    // 미니게임 연승 스트릭 — 긴장감 연출(콤보 배지)용. 누구 스트릭인지와 몇 연승인지만 알려준다.
    streakOwner: match.streak.winnerId == null ? null : (match.streak.winnerId === forId ? 'me' : 'opp'),
    streakCount: match.streak.count,
    // 처소 열기는 두 사람이 동시에 독립적으로 진행 — "내 턴"은 이제 "아직 이번 라운드 몫이 남았는가"를 뜻한다.
    isMyTurn: match.phase === 'ROUND_ACTION' && (match.actionOpens[forId] || 0) < CONFIG.OPENS_PER_TURN,
    opensRemaining: CONFIG.OPENS_PER_TURN - (match.actionOpens[forId] || 0),
    oppOpensRemaining: oppId ? CONFIG.OPENS_PER_TURN - (match.actionOpens[oppId] || 0) : null,
    // 문장의 위치·총 개수는 매치마다 무작위로 정해지는 비공개 정보라 미리 내려주지 않는다 —
    // 게임이 끝나야(전부 공개되거나, 완성해서 즉시 승리하거나) me/opp.crestTotal이 채워진다.
    me: me && {
      name: me.name, poison: me.poison, antidote: me.antidote, score: me.score, finalScore: me.finalScore,
      crestOpened: me.crestOpened,
      crestTotal: match.phase === 'END' ? me.crestTotal : null,
      room: sanitizeRoom(me.room, match.phase === 'END'),
      history: me.history || [],
    },
    // 상대의 점수/독/해독제/처소는 게임이 끝나기 전까지 서버도 클라이언트에 내려주지 않는다
    // (콘솔로 훔쳐보기 방지). 4대 분리 모드에서도 "고르기" 화면은 이제 본인 처소만 보여주므로,
    // 레거시 2인 모드와 동일하게 상대 처소는 계속 비공개다 — "서로 뭘 골랐는지"는 화면을
    // 소프트웨어로 합쳐 보여주는 대신, 컴퓨터를 마주보게 배치하는 물리적 방식으로 해결한다.
    // MID_SETUP 동안만은 예외로, 상대 처소의 "이미 열렸는지 여부"만(내용은 여전히 비공개) 알려줘야
    // 중반 독 추가 설치에서 이미 연 칸을 고르지 못하게 화면에서 걸러줄 수 있다.
    opp: opp && (match.phase === 'END'
      ? { name: opp.name, poison: opp.poison, antidote: opp.antidote, score: opp.score, finalScore: opp.finalScore, crestOpened: opp.crestOpened, crestTotal: opp.crestTotal, connected: opp.connected, room: sanitizeRoom(opp.room, true) }
      : { name: opp.name, connected: opp.connected, room: null }),
    oppOpenedMask: (match.phase === 'MID_SETUP' && opp) ? opp.room.map((row) => row.map((cell) => cell.opened)) : null,
    setupDone: match.order.reduce((acc, id) => { acc[id === forId ? 'me' : 'opp'] = !!match.setupSelections[id]; return acc; }, {}),
    midSetupDone: match.order.reduce((acc, id) => { acc[id === forId ? 'me' : 'opp'] = !!match.midSetupSelections[id]; return acc; }, {}),
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
  if (mg.type === 'BOMB') {
    // 몇 번 넘겼는지는 더 이상 보여주지 않는다 — 실시간 남은 시간(expiresAt)이 훨씬 중요한 정보다.
    return { myTurn: mg.holder === forId, expiresAt: mg.expiresAt };
  }
  if (mg.type === 'PIN') {
    // 안전핀 N개 중 아직 안 뽑힌 것/뽑힌 것만 알려주고, 폭탄 위치는 게임이 끝나야만(result가 있을 때) 공개한다.
    return { pinCount: mg.pinCount, pulled: mg.pulled.slice(), myTurn: mg.turn === forId, bombIndex: mg.result != null ? mg.bombIndex : null };
  }
  if (mg.type === 'SIGIL') {
    return { myPick: mg.picks[forId] || null, oppPicked: !!mg.picks[otherId(forId)], waitingForMe: !mg.picks[forId] };
  }
  if (mg.type === 'GUESS_COUNT') {
    const myGuess = mg.guesses[forId] ?? null;
    // 상대의 추측값은 나도 이미 추측을 마친 뒤에만(라운드가 끝난 뒤 결과 확인용으로) 내려준다.
    const oppGuess = myGuess != null ? (mg.guesses[otherId(forId)] ?? null) : null;
    return { trueCount: mg.trueCount, myGuess, oppGuess, waitingForMe: mg.guesses[forId] == null };
  }
  if (mg.type === 'BANK') {
    // "상대 것은 볼 필요 없다"는 피드백으로, 더 이상 상대의 시도 내역을 보여주지 않는다 —
    // 각자 자신의 금고만 붙잡고 푸는 순수 독립 문제다.
    return {
      digits: CONFIG.BANK_DIGITS,
      myGuesses: (mg.history[forId] || []).map((h) => ({ guess: h.guess, strikes: h.strikes, balls: h.balls, marks: h.marks })),
    };
  }
  if (mg.type === 'BLUFF') {
    return { myPick: mg.picks[forId] ?? null, oppPicked: mg.picks[otherId(forId)] != null, waitingForMe: mg.picks[forId] == null,
      revealed: mg.result != null ? { my: mg.picks[forId], opp: mg.picks[otherId(forId)] } : null };
  }
  if (mg.type === 'LIAR_DIE') {
    const role = mine(mg.declarer) ? 'declarer' : 'responder';
    return {
      role, myRoll: mine(mg.declarer) ? mg.roll : null,
      claim: mg.claim, decision: mg.decision,
      waitingForMe: (role === 'declarer' && mg.claim == null) || (role === 'responder' && mg.claim != null && mg.decision == null),
      revealedRoll: mg.decision === 'DOUBT' ? mg.roll : null,
    };
  }
  if (mg.type === 'GAMBIT') {
    return {
      myCard: mg.cards[forId], myAction: mg.actions[forId] || null, oppActed: !!mg.actions[otherId(forId)],
      waitingForMe: !mg.actions[forId],
      revealed: mg.result != null ? { myCard: mg.cards[forId], oppCard: mg.cards[otherId(forId)], myAction: mg.actions[forId], oppAction: mg.actions[otherId(forId)] } : null,
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
  if (type === 'BOMB') return { 현재소지자: nameOf(mg.holder), 전달횟수: mg.passes, 남은시간초: Math.max(0, Math.round((mg.expiresAt - Date.now()) / 1000)) };
  if (type === 'PIN') return { 현재차례: nameOf(mg.turn), 안전핀개수: mg.pinCount, 뽑은횟수: mg.pulls, 폭탄위치: mg.bombIndex };
  if (type === 'SIGIL') return { 선택현황: byName(mg.picks) };
  if (type === 'GUESS_COUNT') return { 실제개수: mg.trueCount, 추측현황: byName(mg.guesses) };
  if (type === 'BANK') return {
    각자의정답: byName(mg.secrets, (v) => v.join('')),
    시도횟수: byName(mg.history, (v) => v.length),
  };
  if (type === 'BLUFF') return { 배팅현황: byName(mg.picks) };
  if (type === 'LIAR_DIE') return { 선언자: nameOf(mg.declarer), 실제주사위: mg.roll, 선언: mg.claim, 상대판단: mg.decision };
  if (type === 'GAMBIT') return { 패: byName(mg.cards), 선택: byName(mg.actions) };
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
    roundsTotal: CONFIG.ROUNDS_TOTAL,
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
    midSetupPreview: match.phase === 'MID_SETUP' ? match.order.map((id) => ({
      name: match.players[id].name,
      confirmed: !!match.midSetupSelections[id],
      cells: match.midSetupSelections[id] || [],
    })) : null,
    players: match.order.map((id) => {
      const p = match.players[id];
      return {
        name: p.name,
        connected: p.connected,
        poison: p.poison, antidote: p.antidote, score: p.score, finalScore: p.finalScore,
        crestOpened: p.crestOpened, crestTotal: p.crestTotal,
        opens: match.actionOpens[id] || 0,
        // 관리자 화면의 목적은 "서로 어떤 걸 선택하고 있는지"만 보여주는 것 — 아직 열지 않은 칸의
        // 정체까지 미리 다 보여주면 그 취지를 벗어나므로, 실제로 연(선택한) 칸만 종류를 공개한다.
        room: p.room.map((row) => row.map((cell) => ({ type: cell.opened ? cell.type : null, opened: cell.opened, locked: cell.locked }))),
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

  // 슬롯 결정: /game/A, /pick/A, /game/B, /pick/B로 접속하면 handshake 쿼리에 slot='A'|'B'가
  // 명시적으로 실려온다 — 이때는 4대 분리 모드로 표시하고, 같은 슬롯에 이미 다른 기기(게임용/
  // 고르기용)가 붙어 있어도 그냥 슬롯을 공유해 같은 상태 방송을 함께 받는다. slot이 없으면(예전
  // 방식으로 주소 하나에 접속한 경우) 소켓ID 자체를 슬롯으로 써서 기존 2인 모드 동작을 그대로 둔다.
  const queriedSlot = socket.handshake.query && socket.handshake.query.slot;
  const slot = (queriedSlot === 'A' || queriedSlot === 'B') ? queriedSlot : socket.id;
  if (queriedSlot === 'A' || queriedSlot === 'B') match.splitMode = true;

  if (match.order.length >= 2 && !match.order.includes(slot)) {
    socket.emit('full');
    return;
  }
  const isNew = !match.order.includes(slot);
  if (isNew) {
    const name = match.order.length === 0 ? '장남' : '차남';
    match.players[slot] = newPlayer(slot, name);
    match.order.push(slot);
    log(`${name}(이)가 궁에 입장했습니다.`);
  } else if (match.players[slot]) {
    match.players[slot].connected = true; // 같은 슬롯에 기기가 추가로(또는 다시) 연결됨
  }
  socket.join(slot);
  socketSlot[socket.id] = slot;
  if (!slotSockets[slot]) slotSockets[slot] = new Set();
  slotSockets[slot].add(socket.id);
  broadcastState();

  if (match.order.length === 2 && match.phase === 'LOBBY') startSetup();

  socket.on('disconnect', () => {
    const s = socketSlot[socket.id];
    delete socketSlot[socket.id];
    if (!s || !slotSockets[s]) return;
    slotSockets[s].delete(socket.id);
    // 같은 슬롯을 공유하는 다른 기기(게임용/고르기용)가 아직 붙어있으면 "연결 끊김" 처리하지 않는다.
    if (slotSockets[s].size === 0 && match.players[s]) {
      match.players[s].connected = false;
      log(`${match.players[s].name} 연결 끊김`);
      broadcastState();
    }
  });

  socket.on('setup:confirm', (payload) => {
    if (match.phase !== 'SETUP') return;
    const cells = Array.isArray(payload && payload.cells) ? payload.cells : [];
    if (cells.length !== CONFIG.POISON_INITIAL) return socket.emit('error', { message: `정확히 ${CONFIG.POISON_INITIAL}칸을 선택해야 합니다.` });
    const seen = new Set();
    for (const cell of cells) {
      if (cell.row < 0 || cell.row >= CONFIG.ROWS_FIRST_HALF || cell.col < 0 || cell.col >= CONFIG.GRID)
        return socket.emit('error', { message: '유효하지 않은 좌표입니다.' });
      seen.add(cell.row + '_' + cell.col);
    }
    if (seen.size !== CONFIG.POISON_INITIAL) return socket.emit('error', { message: '중복되지 않게 선택해야 합니다.' });
    match.setupSelections[slot] = cells;
    delete match.setupPreview[slot];
    log(`${match.players[slot].name} 독 설치 완료`);
    broadcastState();
    if (match.order.every((id) => match.setupSelections[id])) finalizeSetup();
  });

  // 확정 전 실시간 미리보기 — 관리자 화면 전용. 상대 플레이어에게는 절대 내려주지 않으므로
  // broadcastState()가 아니라 broadcastAdminState()만 호출한다.
  socket.on('setup:preview', (payload) => {
    if (match.phase !== 'SETUP') return;
    const cells = Array.isArray(payload && payload.cells) ? payload.cells : [];
    const valid = cells.filter((cell) => cell && cell.row >= 0 && cell.row < CONFIG.ROWS_FIRST_HALF && cell.col >= 0 && cell.col < CONFIG.GRID);
    match.setupPreview[slot] = valid;
    broadcastAdminState();
  });

  // 중반 독 추가 설치 — 대상은 상대 처소에서 "아직 안 연 칸"(옛 24칸의 남은 칸 + 새로 열리는
  // 12칸 전부) 중 아무 곳이나. 이미 연 칸은 내용이 이미 드러나 있어 대상이 될 수 없다.
  socket.on('mid_setup:confirm', (payload) => {
    if (match.phase !== 'MID_SETUP') return;
    const victimId = otherId(slot);
    const victimRoom = victimId && match.players[victimId] && match.players[victimId].room;
    if (!victimRoom) return;
    const cells = Array.isArray(payload && payload.cells) ? payload.cells : [];
    if (cells.length !== CONFIG.POISON_MID) return socket.emit('error', { message: `정확히 ${CONFIG.POISON_MID}칸을 선택해야 합니다.` });
    const seen = new Set();
    for (const cell of cells) {
      if (cell.row < 0 || cell.row >= CONFIG.ROWS_TOTAL || cell.col < 0 || cell.col >= CONFIG.GRID)
        return socket.emit('error', { message: '유효하지 않은 좌표입니다.' });
      if (victimRoom[cell.row][cell.col].opened)
        return socket.emit('error', { message: '이미 연 칸에는 독을 심을 수 없습니다.' });
      seen.add(cell.row + '_' + cell.col);
    }
    if (seen.size !== CONFIG.POISON_MID) return socket.emit('error', { message: '중복되지 않게 선택해야 합니다.' });
    match.midSetupSelections[slot] = cells;
    log(`${match.players[slot].name} 중반 독 추가 설치 완료`);
    broadcastState();
    if (match.order.every((id) => match.midSetupSelections[id])) finalizeMidSetup();
  });

  socket.on('minigame:move', (payload) => handleMinigameMove(slot, payload || {}));
  socket.on('action:open', (p) => doAction(slot, 'OPEN', p || {}));
  socket.on('reward:use', (p) => handleRewardUse(slot, p || {}));
  socket.on('reward:choose', (p) => handleRewardChoose(slot, p || {}));
  socket.on('rematch:ready', () => handleRematchReady(slot));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`당신의 술잔에 독배를 — 프로토타입 서버 실행 중: http://localhost:${PORT}`);
  console.log('같은 네트워크의 다른 컴퓨터에서는 이 컴퓨터의 IP로 접속하세요 (예: http://192.168.0.5:3000)');
});
