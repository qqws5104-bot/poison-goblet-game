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
  // 보석찾기 — 동그란 보석(1칸, 즉시 완성) · 긴 보석(세로로 붙은 2칸) · 네모난 보석(2x2, 4칸)
  // 세 가지 모양이 처소 안에 무작위로 흩뿌려진다. 조각을 "발견"(칸을 여는 순간)하면 그 즉시
  // +GEM_PIECE_PTS를 받고, 같은 보석의 나머지 조각까지 전부 다 찾아 완성하면 조각 점수와는
  // 별개로 크기 × GEM_COMPLETE_BONUS_PER_PIECE 만큼 추가 보너스를 더 받는다(예: 4조각 보석을
  // 완성하면 조각당 +1씩 4점 + 완성 보너스 4점 = 총 8점). 여러 칸짜리 보석의 첫 조각을 찾으면
  // 나머지 조각이 어느 방향(위/아래/좌/우)에 붙어 있는지 즉시 알려준다.
  GEM_PIECE_PTS: 1,
  GEM_COMPLETE_BONUS_PER_PIECE: 1,
  FIRST_HALF_GEM_SIZES: [4, 2, 2, 1, 1, 1], // 전반(6x4) 보석 구성 — 4조각 1개, 2조각 2개, 1조각 3개
  FIRST_HALF_ANTIDOTE_COUNT: 5, // 전반에서 보석을 뺀 나머지 칸 중 해독제로 채울 개수(나머지는 빈 칸)
  SECOND_HALF_GEM_SIZES: [2, 2, 1], // 후반 확장분(2x6=12칸) 보석 구성 — 2조각 2개, 1조각 1개
  SECOND_HALF_ANTIDOTE_COUNT: 1,
  ANTIDOTE_NEED: 2,       // 해독제 2개 = 독 1개 무효화
  // [2026-10-01] "암살 긴장감을 더 올려야 한다"는 피드백으로 독배 감점을 올렸다(2→3 / 3→5) —
  // 독을 무효화하지 못하면 더 아프게 대가를 치러야 "암살당할 수도 있다"는 공포가 실감난다.
  // 가문의 문장 퍼즐(독배와 무관한 병렬 미니게임)을 완전히 삭제하면서 빈 점수 배분(매치당 최대
  // 14점)을 여기와 FULL_NEUTRALIZE_BONUS_PTS로 옮겨, 보상도 핵심 독배 루프 안에서만 나오게 했다.
  POISON_PENALTY: 3,      // 종료 시, 무효화되지 않은 "1차(전반 셋업)" 독 1개당 -3점
  POISON_PENALTY_MID: 5,  // 종료 시, 무효화되지 않은 "2차(중반 재설치)" 독 1개당 -5점 — 후반에 심는
                           // 독이 더 아파야 중반 재설치가 실제로 위협적으로 느껴진다는 피드백. 해독은
                           // (checkNeutralize에서) 항상 더 비싼 2차 독부터 자동으로 상쇄된다.
  FULL_NEUTRALIZE_BONUS_PTS: 4, // 종료 시 독을 하나라도 마셨지만(poisonInitial+poisonMid 누적 발견 ≥1)
                                 // 전부 해독해 최종 감점이 0인 경우의 "생환 보너스" — 독배를 들이켜고도
                                 // 살아남았다는 긴장감의 보상. 독을 아예 안 마신 매치에는 주지 않는다
                                 // (마신 적도 없이 자동으로 받는 보너스는 "암살 위기를 넘겼다"는 서사와 안 맞음).
  ROUNDS_FIRST_HALF: 8,   // 전반(6×4) 라운드 수
  ROUNDS_TOTAL: 15,       // 총 라운드 수(전반 8 + 후반 7)
  OPENS_PER_TURN: 2,      // 본행동: 내 턴마다 내 처소에서 열 술잔 개수
  ROUND_COUNTDOWN_MS: 3000, // 매 라운드 미니게임 시작 전 3-2-1 카운트다운 길이
  SETUP_DONE_MS: 5000, // 양쪽 다 독배 설치를 마친 직후, 본게임(1라운드 3-2-1 카운트다운)으로 넘어가기 전 대기 시간
  MID_SETUP_DONE_MS: 5000, // 중반 재설치(독 추가+처소 확장) 완료 직후, 후반 첫 라운드로 넘어가기 전 대기 시간
  ROUND_DONE_MS: 5000, // 매 라운드 양쪽 다 칸을 다 연 직후, 다음 라운드 3-2-1 카운트다운으로 넘어가기 전 대기 시간
  POISON_INITIAL: 3,      // 전반 셋업: 24칸 중 상대 처소에 몰래 지정하는 독 개수
  POISON_MID: 2,          // 중반 재설치: 아직 안 연 칸 중 상대 처소에 추가로 지정하는 독 개수
  NIM_LIMIT_MIN: 12, NIM_LIMIT_MAX: 20, // 독배 채우기: 이 숫자(매판 무작위)에 도달/초과시키면 그 사람이 패배
  BOMB_FUSE_MS_MIN: 12000, BOMB_FUSE_MS_MAX: 20000, // 폭탄 눈치 넘기기: 실시간(ms) 퓨즈 — 이 시간 후 터짐
  PIN_COUNT_MIN: 8, PIN_COUNT_MAX: 12, // 안전핀 뽑기: 이번 판에 놓일 안전핀 개수(그 중 1개가 폭탄)
  GUESS_COUNT_MIN: 15, GUESS_COUNT_MAX: 30, // 와인잔 개수 세기: 실제 술잔 개수 범위
  BANK_DIGITS: 3,         // 금고 번호 맞추기: 서로 다른 숫자 몇 자리
  REWARD_FLASH_REVEAL_MS: 80, // 철가방(FLASH_ALL) 정찰 발동 시 실제로 화면에 드러나 있는 시간(ms) — 계속 "더 빠르게" 피드백이 와서 300→150→80으로 더 줄임
  REWARD_USE_LIMIT: 3, // 보상 종류별로 한 사람이 실제로 사용할 수 있는 최대 횟수
  // "장고 금지" 타이머 — 시간이 다 되면 아직 결정을 안 내린 쪽의 몫을 서버가 무작위로 대신
  // 결정해버린다(핸들러 함수를 그대로 재사용하므로 검증/승패 판정 로직은 완전히 동일하다).
  DECISION_TIMER_MS: 15000, // NIM/HAND/PIN/GUESS_COUNT/DICE/SIGIL처럼 결정이 한 번(또는 교대로 한 번씩)인 미니게임
  // [2026-10-01] 장고 페널티(시간 초과 시 칸 잠금)는 폐지됨 — 이제 시간 초과는 즉시 패배로
  // 처리되고(아래 armXxxTimer들 참고), 패배 자체가 유일한 페널티다.
  DICE_CYCLE_MS: 100, // 주사위 누르기 — 스페이스바를 누르고 있는 동안 이 간격(ms)마다 눈금이 1~6으로 순환하며, 뗀 시점의 경과시간으로 서버가 눈을 확정한다(220→100, "눈이 더 빠르게 흘러가게" 피드백)
  DICE_MAX_TIE_REPLAYS: 2, // 동점이면 이 횟수만큼 다시 굴린다 — 그래도 계속 동점이면 더 먼저 주사위를 놓은(release가 빠른) 쪽이 승리
  BANK_TIMER_MS: 45000, // 금고 번호 맞추기는 여러 번 시도해야 하는 퍼즐이라 더 긴 여유를 준다
  ROUND_ACTION_TIMER_MS: 40000, // 본행동(칸 열기) — 라운드당 행동 예산을 다 쓸 시간
  // [2026-10-01] "독배로 암살한다는 긴장감을 더 줘야 한다"는 피드백으로, 독배와 무관하게 따로
  // 떠 있던 가문의 문장 슬라이딩 퍼즐(개인전 미니게임)은 완전히 삭제했다. 대신 보상(정찰) 체계에
  // 상대를 직접 심리적으로 흔드는 "협박 표식"(MARK, REWARD_TYPES 참고)을 추가해, 모든 상호작용이
  // 독배 루프 안에서만 일어나게 했다.
  MARK_USE_LIMIT: 2, // 협박 표식은 다른 보상(3회)보다 더 강력하므로 한 사람당 매치 전체에서 2회로 제한
};
// 매치 전체에서 나올 보석 조각 총 개수(전반+후반 고정 구성의 합) — 화면에 분모로 보여주는 용도.
CONFIG.GEM_PIECES_TOTAL = CONFIG.FIRST_HALF_GEM_SIZES.reduce((a, b) => a + b, 0)
  + CONFIG.SECOND_HALF_GEM_SIZES.reduce((a, b) => a + b, 0);

// 배짱 대결(SHOWDOWN)은 "너무 단순한 게임"이라는 피드백으로 제외.
// "심리싸움 하는 느낌이 살면 좋겠다"는 피드백에 따라 운/대박 요소는 유지하면서도 상대를 읽어야
// 이기는 심리전 계열을 추가했다 — 총 9종(숫자 패 대결은 "너무 생각해야 한다"는 피드백으로
// 이후 제외). ROUNDS(15) > 9종이라 한 매치에 9종이 전부 나올 수도 있다(그중 최대 15개를
// 무작위로 섞어 채움).
// 숫자 합 홀짝(PARITY)은 상호작용이 단조롭다는 피드백으로, 사라진 유품 찾기(MEMORY)는 재미
// 피드백으로 제외. 심리전 계열 초안 3종(BLUFF/LIAR_DIE/GAMBIT)은 플레이테스트 결과 셋 다
// 실제로는 "읽을 게 없는" 게임이었다는 게 드러나 전부 제외했다 — 라이어 주사위는 선언 한 번 +
// 트러스트/더블 찍기뿐이라 상대를 읽을 단서가 전혀 없는 포장된 동전던지기였고, 황금 잔 허세
// 대결은 GOLD를 쥔 쪽은 PUSH가 손해볼 일이 없는 확정 정답이라 절반의 상황에서 진짜 '결정'이
// 없었으며, 허세 배팅은 세 선택지(1/2/3) 중 3이 다른 모든 선택지를 (약)우월하게 지배해서
// "무조건 3"이 정답인 게임이었다(세 게임 모두 "애매하다"는 피드백으로 확인). 세 게임 모두
// 양쪽 모두에게 실제 딜레마가 있는 대체 게임으로 의리 시험(PACT, 죄수의 딜레마형)을 한동안
// 추가했었으나 "이것도 빼. 너무 글이 많아"라는 피드백으로 제외하고, 대신 스페이스바를 꾹
// 누르고 있다가 떼는 순간 눈이 확정되는 순발력/타이밍형 게임인 주사위 누르기(DICE)로
// 교체했다(설명 텍스트가 거의 필요 없다는 게 장점). 확정된 눈은 둘 다에게 공개된다.
// 숫자 패 대결(CARD_DUEL, 1·2·3을 세 자리에 몰래 배치해 겨루는 방식)도 한때 있었으나
// "너무 생각해야 한다"는 피드백으로 제외했다.
const MINIGAME_SEQUENCE = ['NIM', 'HAND', 'REFLEX', 'BOMB', 'PIN', 'SIGIL', 'GUESS_COUNT', 'BANK', 'DICE'];
const MINIGAME_NAMES = {
  NIM: '독배 채우기', HAND: '독 든 손 맞히기', REFLEX: '잔 낚아채기',
  BOMB: '폭탄 눈치 넘기기', PIN: '안전핀 뽑기 배팅',
  SIGIL: '금은동 쟁탈전', GUESS_COUNT: '탁자 위 술잔 개수 세기',
  BANK: '금고 번호 맞추기', DICE: '주사위 누르기',
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
// 금은동 쟁탈전(SIGIL) — "검>독배>방패" 순환 규칙(가위바위보 아류) → "왼쪽/오른쪽 잔 중 하나를
// 짚는 운빨 게임"을 거쳐, 최종적으로 금/은/동 술잔을 정해진 순서(금→은→동)대로 최대한 빨리
// 누르는 순수 반응속도 게임으로 정착했다. 화면에는 금/은/동 술잔이 무작위 개수(1~3개씩,
// itemCounts)만큼 뒤섞여 흩뿌려져 있고, 그중 아직 차례가 안 된 색은 눌러도 그냥 무시된다
// (패널티 없음). 자기 몫의 금 술잔을 전부 다 누른 뒤에야 은, 그다음 동 순서로 넘어가고,
// 셋을 모두 순서대로 먼저 다 끝낸 사람이 그 자리에서 즉시 승리한다.
const MEDAL_ORDER = ['GOLD', 'SILVER', 'BRONZE'];
// 보석(GEM)은 고정된 좌표에 놓이지 않는다 — 독을 심고 남은 칸 중에서 매치마다 무작위 위치로
// 배치되고(finalizeSetup/startMidSetup에서 실제 배치), 본인도 어디 있는지 모른 채 칸을 열다가
// 우연히 발견한다. 모양(동그라미=1칸/긴 것=세로 2칸/네모=2x2 4칸)에 따라 여러 칸에 걸쳐
// 나뉘어 있을 수 있고, 그 조각들은 gemId로 서로 묶인다(placeOneGem 참고).
const CELL_NAMES = { P: '독 술잔', GEM: '보석', A: '해독제', E: '빈 칸' };
const CLUE_CATS = ['P', 'GEM', 'A'];
const CLUE_CAT_NAMES = { P: '독 술잔', GEM: '보석', A: '해독제' };

// [2026-10-01] "암살 긴장감을 더 줘야 한다" — 기존 4종은 전부 "내 처소를 들여다보는" 정찰
// 일변도였다. MARK("협박 표식")를 추가해 처음으로 "상대 처소"에 직접 심리적 흔적을 남기는
// 보상을 넣었다 — 내 칸이 아니라 상대가 아직 안 연 칸 하나를 겨냥해 불안감을 심는다(실제 정체는
// 절대 새지 않음). 공격자도 그 칸의 정체를 모른 채(아는 척) 찍을 수도 있으므로 진짜/허세가 섞인
// 기만 신호가 된다 — handleRewardUse의 MARK 분기, player.threatMarks 참고.
const REWARD_TYPES = ['FLASH_ALL', 'PEEK_CELL', 'ROW_COUNT', 'COL_COUNT', 'MARK'];
const REWARD_NAMES = {
  FLASH_ALL: '철가방 정찰 — 무작위 순간, 내 처소 전체가 뚜껑처럼 확 열렸다가 저절로 잠깐 드러남',
  PEEK_CELL: '한 칸 정찰 — 내 처소 원하는 1칸의 정체 확인',
  ROW_COUNT: '가로줄 정찰 — 내 처소에서 종류 하나를 고르면, 현재 열려 있는 가로줄 전부에 몇 개씩 있는지 확인',
  COL_COUNT: '세로줄 정찰 — 내 처소에서 종류 하나를 고르면, 6개 세로줄 전부에 몇 개씩 있는지 확인',
  MARK: '협박 표식 — 상대 처소의 아직 안 연 칸 하나를 찍어 "누군가 노리고 있다"는 불안감을 심음(실제 정체는 새지 않음)',
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
// 재배포할 때마다 "브라우저가 예전 client.js/style.css를 그대로 캐시해서 들고 있어 새 코드가
// 반영이 안 된 것처럼 보이는" 문제가 반복적으로 발생했다 — 특히 js/css/html 정적 파일에
// 캐시를 꺼서, 새로고침(하드 리프레시 없이도) 시 항상 최신 파일을 받아오게 한다.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(js|css|html)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
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
    for (let c = 0; c < CONFIG.GRID; c++) row.push({ type: null, opened: false, locked: r >= CONFIG.ROWS_FIRST_HALF, cluedType: null, cluedNote: null, gemId: null });
    cells.push(row);
  }
  return cells;
}
function newPlayer(id, name) {
  return {
    id, name, room: makeRoom(),
    // 독은 언제 심어졌는지(1차/2차)에 따라 종료 시 감점이 다르므로 따로 센다 — 합계가 필요한
    // 곳(화면에 늘 보이는 총 독 개수 등)은 poisonTotal(player)로 구한다.
    poisonInitial: 0, poisonMid: 0, antidote: 0, score: 0, finalScore: null,
    // 해독해서 poisonInitial/poisonMid가 줄어들어도 이 값은 절대 줄지 않는다 — "독을 마신 적이
    // 있었는지"(생환 보너스 자격)를 끝까지 판별하기 위한 누적 카운터. endMatchByScore 참고.
    poisonEverFound: 0,
    // 보석 registry — gemId → { size, cells: [{row,col}] }. 완성 여부/찾은 조각 수는 필요할 때마다
    // room의 opened 상태를 기준으로 바로 계산한다(따로 들고 다니지 않아도 항상 정확하다).
    gems: {},
    nextGemId: 1,
    connected: true,
    // 보상 종류별로 "실제로 사용(발동)한" 횟수 — 각 종류 최대 REWARD_USE_LIMIT(3)번까지만 쓸 수
    // 있고, 다 쓴 종류는 이후 보상 후보에서 제외된다(무한정 우려먹지 못하게).
    rewardUses: { FLASH_ALL: 0, PEEK_CELL: 0, ROW_COUNT: 0, COL_COUNT: 0, MARK: 0 },
    // 상대가 "협박 표식"(MARK)을 내 처소 어느 칸에 남겼는지 — [{row,col}] (중복 좌표는 안 쌓임,
    // 이미 연 칸엔 표식을 남길 수 없다). 내 칸의 실제 정체(type)는 전혀 새지 않고, 그 칸이
    // "누군가 주목하고 있다"는 사실만 보여준다 — handleRewardUse의 MARK 분기 참고.
    threatMarks: [],
  };
}
// 보석 하나(size=1|2|4)를 놓을 수 있는 자리를 rowStart~rowEnd(미포함) 구간의, 아직 타입이
// 정해지지 않은(null) 칸들 중에서 찾아 실제로 배치한다 — 1칸(동그라미)은 아무 빈 칸,
// 2칸(긴 것)은 세로로 붙은 빈 칸 한 쌍, 4칸(네모)은 2x2로 붙은 빈 칸 네 개를 찾는다.
// 자리가 전혀 없으면(이 칸 수로는 사실상 발생하지 않음) 조용히 포기한다.
function placeOneGem(player, room, rowStart, rowEnd, size) {
  const cols = CONFIG.GRID;
  const isFree = (r, c) => r >= rowStart && r < rowEnd && c >= 0 && c < cols && room[r][c].type === null;
  let shapeCells = null;
  if (size === 1) {
    const candidates = [];
    for (let r = rowStart; r < rowEnd; r++) for (let c = 0; c < cols; c++) if (isFree(r, c)) candidates.push([{ row: r, col: c }]);
    if (candidates.length) shapeCells = shuffle(candidates)[0];
  } else if (size === 2) {
    const candidates = [];
    for (let r = rowStart; r < rowEnd - 1; r++) for (let c = 0; c < cols; c++) {
      if (isFree(r, c) && isFree(r + 1, c)) candidates.push([{ row: r, col: c }, { row: r + 1, col: c }]);
    }
    if (candidates.length) shapeCells = shuffle(candidates)[0];
  } else if (size === 4) {
    const candidates = [];
    for (let r = rowStart; r < rowEnd - 1; r++) for (let c = 0; c < cols - 1; c++) {
      if (isFree(r, c) && isFree(r + 1, c) && isFree(r, c + 1) && isFree(r + 1, c + 1)) {
        candidates.push([{ row: r, col: c }, { row: r + 1, col: c }, { row: r, col: c + 1 }, { row: r + 1, col: c + 1 }]);
      }
    }
    if (candidates.length) shapeCells = shuffle(candidates)[0];
  }
  if (!shapeCells) return; // 자리가 없으면 포기
  const gemId = player.nextGemId++;
  // 조각 위치 라벨 — 예전 "가문의 문장" 조각 이미지처럼 칸을 열면 전체 보석의 "반쪽/한 조각"만
  // 보이게 하기 위한 것. size1(동그라미)은 조각이 하나뿐이라 라벨이 필요 없고, size2(긴 것)는
  // 세로로 위/아래, size4(네모)는 2x2 배치 순서(TL,BL,TR,BR)를 그대로 라벨로 쓴다.
  const pieceLabels = size === 1 ? ['SOLO'] : size === 2 ? ['TOP', 'BOTTOM'] : ['TL', 'BL', 'TR', 'BR'];
  shapeCells.forEach(({ row, col }, i) => { room[row][col].type = 'GEM'; room[row][col].gemId = gemId; room[row][col].gemPiece = pieceLabels[i]; });
  player.gems[gemId] = { size, cells: shapeCells };
}
function placeGemsInRegion(player, room, rowStart, rowEnd, sizes) {
  for (const size of sizes) placeOneGem(player, room, rowStart, rowEnd, size);
}
// 보석을 다 놓고 남은(아직 null인) 칸 중 일부를 해독제로, 나머지를 빈 칸으로 채운다.
function fillAntidoteAndEmpty(room, rowStart, rowEnd, antidoteCount) {
  const cells = [];
  for (let r = rowStart; r < rowEnd; r++) for (let c = 0; c < CONFIG.GRID; c++) if (room[r][c].type === null) cells.push({ row: r, col: c });
  const shuffled = shuffle(cells);
  shuffled.forEach(({ row, col }, i) => { room[row][col].type = i < antidoteCount ? 'A' : 'E'; });
}
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
    actionForfeited: {}, // 시간 안에 다 못 고른 몫을 "그냥 넘어감" 처리했는지
    actionDeadlineAt: null, // "장고 금지" — 본행동(칸 열기) 라운드가 몇 시에 시간초과되어 자동 진행되는지
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
// 협박 표식(MARK)은 다른 정찰 보상(3회)보다 강력하므로 별도 한도(MARK_USE_LIMIT=2)를 쓴다.
function rewardUseLimitFor(type) { return type === 'MARK' ? CONFIG.MARK_USE_LIMIT : CONFIG.REWARD_USE_LIMIT; }
function poisonTotal(player) { return player.poisonInitial + player.poisonMid; }
function poisonPenaltyTotal(player) { return player.poisonInitial * CONFIG.POISON_PENALTY + player.poisonMid * CONFIG.POISON_PENALTY_MID; }
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
    for (const { row, col } of poisonCells) { room[row][col].type = 'P'; room[row][col].poisonWave = 1; }
  }
  // 2) 보석 배치 — 독이 아닌 전반 24칸 중, 정해진 모양·개수(FIRST_HALF_GEM_SIZES)만큼 흩뿌린다.
  for (const id of match.order) {
    const player = match.players[id];
    placeGemsInRegion(player, player.room, 0, CONFIG.ROWS_FIRST_HALF, CONFIG.FIRST_HALF_GEM_SIZES);
  }
  // 3) 나머지 전반 칸(독·보석을 뺀 칸)을 해독제/빈칸으로 채운다.
  for (const id of match.order) {
    fillAntidoteAndEmpty(match.players[id].room, 0, CONFIG.ROWS_FIRST_HALF, CONFIG.FIRST_HALF_ANTIDOTE_COUNT);
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
// 2개씩 추가로 몰래 심는다. 확장되는 12칸(2×6)의 보석/해독제는 독을 고르기 "전에" 먼저
// 흩뿌려둔다 — 그래야 이미 뭔가 있는 칸을 엑스자로 막아서 보여줄 수 있고(더 이상 독을 몰래
// 심다가 보석을 실수로 덮어버리는 일이 없다), 독 추가 대상은 옛 24칸의 남은 빈 칸(E)과 새
// 12칸의 빈 칸(E)뿐이다.
function startMidSetup() {
  match.phase = 'MID_SETUP';
  match.midSetupSelections = {};
  for (const id of match.order) {
    const player = match.players[id];
    const room = player.room;
    for (let r = CONFIG.ROWS_FIRST_HALF; r < CONFIG.ROWS_TOTAL; r++) {
      for (let c = 0; c < CONFIG.GRID; c++) room[r][c].locked = false;
    }
    placeGemsInRegion(player, room, CONFIG.ROWS_FIRST_HALF, CONFIG.ROWS_TOTAL, CONFIG.SECOND_HALF_GEM_SIZES);
    fillAntidoteAndEmpty(room, CONFIG.ROWS_FIRST_HALF, CONFIG.ROWS_TOTAL, CONFIG.SECOND_HALF_ANTIDOTE_COUNT);
  }
  log(`전반 종료 — 처소가 6×${CONFIG.ROWS_TOTAL}으로 확장됩니다. 상대 왕자의 아직 열리지 않은 빈 칸 중 ${CONFIG.POISON_MID}곳에 독을 추가로 몰래 지정하세요.`);
  broadcastState();
}

function finalizeMidSetup() {
  // 독 추가 배치 — mid_setup:confirm에서 이미 "완전히 빈 칸(E)"만 후보로 허용했으므로,
  // 여기서는 그대로 덮어쓰기만 하면 된다(보석/해독제를 실수로 지우는 일은 이제 없다).
  for (const id of match.order) {
    const victim = otherId(id);
    const victimPlayer = match.players[victim];
    const cells = match.midSetupSelections[id] || [];
    const room = victimPlayer.room;
    for (const { row, col } of cells) {
      room[row][col].type = 'P';
      room[row][col].poisonWave = 2;
    }
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

// "장고 금지" 타이머 — 결정을 안 내리고 시간을 끄는 걸 막기 위해, 미니게임마다 데드라인을
// 하나 걸어둔다. [2026-10-01] "시간이 지나도록 아무것도 안 하면 자동선택 말고 그냥 즉시 패배로
// 하자"는 피드백으로, 시간이 다 되면 더 이상 서버가 대신 무작위로 입력을 채워주지 않는다 — 그
// 차례였던(또는 아직 결정을 안 한) 사람이 그 자리에서 바로 패배 처리된다. 칸 잠금(장고 페널티)도
// "패배 자체가 이미 페널티"라는 이유로 함께 폐지했다(패배 외 추가 처벌 없음). 양쪽이 각자
// 독립적으로 결정하는 미니게임(주사위/금고/촛불개수/잔 낚아채기/금은동쟁탈전)에서 시간이 다
// 되도록 "양쪽 다" 전혀 결판을 못 낸 경우는 어느 한쪽 탓으로 돌릴 수 없으므로 무승부로 처리한다.
// mg.deadlineAt에 찍힌 시각과 실제 예약된 시각(token)이 서로 다르면(그 사이에 다시
// armDecisionTimer가 불려 갱신됐다는 뜻) 낡은 타이머이므로 무시한다.
function armDecisionTimer(mg, ms, onTimeout) {
  mg.deadlineAt = Date.now() + ms;
  const token = mg.deadlineAt;
  setTimeout(() => {
    if (match.minigame !== mg || match.phase !== 'ROUND_MINIGAME' || mg.deadlineAt !== token || mg.result != null) return;
    onTimeout();
  }, ms);
}
function armNimTimer(mg) {
  armDecisionTimer(mg, CONFIG.DECISION_TIMER_MS, () => {
    log(`${match.players[mg.turn].name}이(가) 너무 오래 고민해 시간 초과로 즉시 패배합니다.`);
    endMinigame(otherId(mg.turn));
  });
}
function armPinTimer(mg) {
  armDecisionTimer(mg, CONFIG.DECISION_TIMER_MS, () => {
    log(`${match.players[mg.turn].name}이(가) 너무 오래 고민해 시간 초과로 즉시 패배합니다.`);
    endMinigame(otherId(mg.turn));
  });
}
function armHandTimer(mg) {
  armDecisionTimer(mg, CONFIG.DECISION_TIMER_MS, () => {
    if (mg.hiderPick == null) {
      log(`${match.players[mg.hider].name}이(가) 너무 오래 고민해 시간 초과로 즉시 패배합니다.`);
      endMinigame(mg.guesser);
    } else if (mg.guesserPick == null) {
      log(`${match.players[mg.guesser].name}이(가) 너무 오래 고민해 시간 초과로 즉시 패배합니다.`);
      endMinigame(mg.hider);
    }
  });
}
function armSigilTimer(mg) {
  armDecisionTimer(mg, CONFIG.DECISION_TIMER_MS, () => {
    // 이 타이머가 울렸다는 건 mg.result가 아직 비어있다는 뜻 — 아직 아무도 금·은·동을 순서대로
    // 다 끝내지 못했다. 어느 한쪽이 조금 더 앞서 있었어도 승부를 억지로 가르지 않고 무승부로
    // 처리한다("양쪽 다 시간초과" 경우와 동일하게 취급).
    log('아무도 시간 안에 금·은·동을 다 끝내지 못해 무승부로 처리합니다.');
    endMinigameDraw();
  });
}
function armGuessCountTimer(mg) {
  armDecisionTimer(mg, CONFIG.DECISION_TIMER_MS, () => {
    const [a, b] = match.order;
    const aDone = mg.guesses[a] != null, bDone = mg.guesses[b] != null;
    if (!aDone && !bDone) {
      log('둘 다 시간 안에 추측하지 못해 무승부로 처리합니다.');
      return endMinigameDraw();
    }
    const loser = aDone ? b : a; // 아직 안 고른 쪽이 패배
    log(`${match.players[loser].name}이(가) 너무 오래 고민해 시간 초과로 즉시 패배합니다.`);
    endMinigame(otherId(loser));
  });
}
function armDiceTimer(mg) {
  armDecisionTimer(mg, CONFIG.DECISION_TIMER_MS, () => {
    const [a, b] = match.order;
    const aDone = mg.results[a] != null, bDone = mg.results[b] != null;
    if (!aDone && !bDone) {
      log('둘 다 시간 안에 주사위를 굴리지 못해 무승부로 처리합니다.');
      return endMinigameDraw();
    }
    const loser = aDone ? b : a; // 아직 안 굴린 쪽이 패배
    log(`${match.players[loser].name}이(가) 너무 오래 고민해 시간 초과로 즉시 패배합니다.`);
    endMinigame(otherId(loser));
  });
}
function armReflexTimer(mg) {
  // 신호(goAt)가 뜬 뒤에도 정말로 아예 반응이 없는(완전 잠수) 경우를 위한 안전망이다.
  // 정상적으로 반응하는 플레이어라면 이 데드라인보다 훨씬 먼저 이미 클릭했을 것이므로,
  // 화면에 별도 카운트다운 배지는 띄우지 않는다(신호-반응 몰입감을 해치지 않기 위해).
  armDecisionTimer(mg, CONFIG.DECISION_TIMER_MS, () => {
    const [a, b] = match.order;
    const aDone = !!mg.clicks[a], bDone = !!mg.clicks[b];
    if (!aDone && !bDone) {
      log('둘 다 시간 안에 반응하지 않아 무승부로 처리합니다.');
      return endMinigameDraw();
    }
    const loser = aDone ? b : a; // 아직 반응하지 않은 쪽이 패배
    log(`${match.players[loser].name}이(가) 너무 오래 고민해 시간 초과로 즉시 패배합니다.`);
    endMinigame(otherId(loser));
  });
}
function armBankTimer(mg) {
  armDecisionTimer(mg, CONFIG.BANK_TIMER_MS, () => {
    // 이 타이머가 울렸다는 건 아직 아무도 자기 금고를 못 열었다는 뜻("양쪽 다 시간초과"와
    // 동일한 경우)이므로 무승부로 처리한다.
    log('아무도 시간 안에 금고를 열지 못해 무승부로 처리합니다.');
    endMinigameDraw();
  });
}
// 본행동(칸 열기) 라운드가 시간 안에 안 끝나면: "선택 안 하면 랜덤으로 안 골라졌으면 해" 피드백에
// 따라, 서버가 대신 무작위로 칸을 열어주지 않는다 — 그냥 이번 라운드에 못 연 나머지 칸은 넘어가고
// (그 칸들은 열리지 않은 채로 남아 다음 라운드 이후에도 계속 선택 가능), 라운드만 정상적으로
// 다음으로 진행되게 한다(그래야 한쪽이 고르지 않아도 상대가 계속 묶여 있지 않는다). 철가방
// 정찰(FLASH_ALL)을 고르고도 아직 터뜨리지 않은 상태라면, doAction()이 칸 열기 자체를 막고
// 있으므로 그것만은 예외적으로 대신 터뜨려준다(안 그러면 그 라운드 내내 아예 못 열게 됨).
// [2026-10-01] "둘 다 칸 열기를 마쳐도, 문장 퍼즐 시간이 남았으면 화면이 안 바뀌었으면 해" —
// 이제 이 타이머가 유일하게 ROUND_ACTION을 끝내는 지점이다(checkRoundActionDone()은 더 이상
// 둘 다 마쳤다고 먼저 다음 단계로 넘기지 않음). 그래서 매 라운드는 둘 다 칸을 금방 다 열어도
// 항상 이 타이머(= 문장 퍼즐 타이머와 공유하는 시각)가 다 될 때까지 유지된다.
function armActionTimer() {
  const roundAtArm = match.round;
  match.actionDeadlineAt = Date.now() + CONFIG.ROUND_ACTION_TIMER_MS;
  const deadline = match.actionDeadlineAt;
  setTimeout(() => {
    if (match.phase !== 'ROUND_ACTION' || match.round !== roundAtArm || match.actionDeadlineAt !== deadline) return;
    for (const id of match.order) {
      const player = match.players[id];
      const pr = match.pendingReward;
      if (pr && pr.winnerId === id && pr.type === 'FLASH_ALL' && !pr.used) {
        log(`${player.name}이(가) 너무 오래 고민해 철가방 정찰이 서버에 의해 자동으로 발동됩니다.`);
        fireFlashAll(id);
      }
      const opens = match.actionOpens[id] || 0;
      if (opens >= CONFIG.OPENS_PER_TURN) continue;
      log(`${player.name}이(가) 시간 안에 다 고르지 못해 이번 라운드 나머지 선택을 넘깁니다.`);
      match.actionForfeited[id] = true;
    }
    advanceAfterRoundAction();
  }, CONFIG.ROUND_ACTION_TIMER_MS);
}

function initMinigame(type, roundNo) {
  const [a, b] = match.order;
  const firstIsA = roundNo % 2 === 1; // 라운드마다 선공 교대
  const base = { type, moves: {}, result: null };
  if (type === 'NIM') {
    // 목표치(limit)를 매 판 15~30 사이에서 무작위로 정하고, 클라이언트에는 이 숫자를 노출하지 않는다
    // (publicMinigameView에서 fillRatio로만 시각화 — 술잔이 차오르는 이미지로만 보여준다).
    const mgNim = { ...base, count: 0, turn: firstIsA ? a : b, limit: randInt(CONFIG.NIM_LIMIT_MIN, CONFIG.NIM_LIMIT_MAX) };
    armNimTimer(mgNim);
    return mgNim;
  }
  if (type === 'HAND') {
    const mgHand = { ...base, hider: firstIsA ? a : b, guesser: firstIsA ? b : a, hiderPick: null, guesserPick: null };
    armHandTimer(mgHand);
    return mgHand;
  }
  if (type === 'REFLEX') {
    // 서버가 무작위 시점에 "신호"를 알려주고, 신호 후 가장 먼저 누른 사람이 승리.
    // 신호 전에 누르면 성급하게 움직인 것으로 간주해 그 자리에서 즉시 패배한다.
    const mgReflex = { ...base, goAt: null, clicks: {} };
    const delay = randInt(2000, 5000);
    setTimeout(() => {
      if (match.minigame === mgReflex && match.phase === 'ROUND_MINIGAME') {
        mgReflex.goAt = Date.now();
        armReflexTimer(mgReflex);
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
    const mgPin = { ...base, turn: firstIsA ? a : b, pinCount, bombIndex: randInt(0, pinCount - 1), pulled: Array(pinCount).fill(false), pulls: 0 };
    armPinTimer(mgPin);
    return mgPin;
  }
  if (type === 'SIGIL') {
    // 금/은/동 각각 몇 개가 나올지도 매 판 무작위(1~3개)다 — 두 사람 모두 같은 개수 구성으로
    // 공정하게 겨룬다(위치만 화면마다 알아서 다르게 흩뿌려지고, 개수는 서버가 공유해서 정한다).
    const itemCounts = { GOLD: randInt(1, 3), SILVER: randInt(1, 3), BRONZE: randInt(1, 3) };
    const mgSigil = {
      ...base,
      itemCounts,
      progress: { [a]: { GOLD: 0, SILVER: 0, BRONZE: 0 }, [b]: { GOLD: 0, SILVER: 0, BRONZE: 0 } },
    };
    armSigilTimer(mgSigil);
    return mgSigil;
  }
  if (type === 'GUESS_COUNT') {
    // 너무 쉽다는 피드백 반영: 와인잔 개수 범위를 15~30으로 넓혀(눈으로 정확히 세기 어렵게) 노출 시간도 짧게 준다.
    const mgGuess = { ...base, trueCount: randInt(CONFIG.GUESS_COUNT_MIN, CONFIG.GUESS_COUNT_MAX), guesses: {}, guessOrder: [] };
    armGuessCountTimer(mgGuess);
    return mgGuess;
  }
  if (type === 'BANK') {
    // 하나의 금고를 공유하는 게 아니라, 두 사람이 각자 자신만의 금고(컴퓨터가 무작위로 정한 서로 다른
    // 정답)를 갖고 동시에 독립적으로 숫자야구를 진행한다 — 자기 금고를 먼저 여는 쪽이 승리.
    const mgBank = {
      ...base,
      secrets: { [a]: randomDistinctDigits(CONFIG.BANK_DIGITS), [b]: randomDistinctDigits(CONFIG.BANK_DIGITS) },
      history: { [a]: [], [b]: [] },
    };
    armBankTimer(mgBank);
    return mgBank;
  }
  if (type === 'DICE') {
    // 주사위 누르기 — 스페이스바(또는 버튼)를 꾹 누르고 있으면 눈이 계속 순환하고 있다고
    // 보고, 뗀 순간의 실제 경과시간(서버가 받은 진짜 타임스탬프 기준 — 클라이언트가 스스로
    // 보고하는 숫자는 신뢰하지 않는다)으로 눈(1~6)을 확정한다. 화면에는 누르고 있는 동안
    // 눈이 빠르게 도는 장식용 애니메이션을 보여줄 뿐, 실제 결과는 전적으로 서버 판정이다.
    // 둘 다 확정되면 큰 눈이 승리 — 동점이면 DICE_MAX_TIE_REPLAYS(2)번까지 다시 굴리고, 그래도
    // 계속 동점이면 더 먼저 주사위를 놓은(release가 빠른) 쪽이 승리한다(finalizeDiceResult 참고).
    const mgDice = { ...base, pressAt: {}, results: {}, finalizedAt: {}, tieRound: 0 };
    armDiceTimer(mgDice);
    return mgDice;
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
  // rewardUseLimitFor(t)번을 다 쓴 종류는 후보에서 빠진다 — 한 종류만 무한정 우려먹지 못하게.
  const winner = match.players[winnerId];
  let availableTypes = REWARD_TYPES.filter((t) => (winner.rewardUses[t] || 0) < rewardUseLimitFor(t));
  // 네 종류를 전부 다 써버린 극단적인 경우(이론상 라운드 수가 아주 많아야 가능)에는 선택지가
  // 텅 비는 것보다는, 그냥 모든 종류를 다시 후보로 열어주는 쪽이 안전하다.
  if (availableTypes.length === 0) availableTypes = REWARD_TYPES.slice();
  // 가로줄/세로줄 정찰(ROW_COUNT/COL_COUNT)은 항상 후보에 포함한다. "아직 안 연 칸"의 내용을
  // 그대로 알려주는 정보이긴 하나, handleRewardUse()에서 실제로 활성화된 줄 수만큼만 집계하므로
  // (전반엔 4개 가로줄, 후반엔 6개) 아직 존재하지 않는 줄에 대한 정보가 새는 일은 없다.
  match.pendingReward = {
    winnerId,
    choices: shuffle(availableTypes),
    type: null, // handleRewardChoose에서 채워짐
    used: false,
  };

  // 본행동(칸 열기)은 더 이상 순서 교대가 아니라 두 사람이 동시에 독립적으로 진행한다.
  match.actionOpens = {};
  match.actionForfeited = {}; // 시간 안에 다 못 고른 몫을 "그냥 넘어감" 처리했는지(라운드마다 초기화)
  match.phase = 'ROUND_ACTION';
  log(`미니게임 승리: ${match.players[winnerId].name} → 보상을 직접 고릅니다.`);
  armActionTimer();
  broadcastState();
}

// "둘 다 정답을 맞히지 못함"이나 "둘 다 밀고함" 같은 무승부가 나는 미니게임을 위한 범용 처리 —
// 승자를 억지로 정해 보상까지 챙겨주지 않고, 이번 라운드는 그냥 보상 없이 본행동으로 넘어간다.
function endMinigameDraw() {
  match.minigame.result = 'DRAW';
  match.pendingReward = null;
  match.actionOpens = {};
  match.actionForfeited = {}; // 시간 안에 다 못 고른 몫을 "그냥 넘어감" 처리했는지(라운드마다 초기화)
  match.phase = 'ROUND_ACTION';
  match.streak = { winnerId: null, count: 0 }; // 무승부는 스트릭을 끊는다
  log('무승부 — 이번 라운드는 보상 없이 넘어갑니다.');
  armActionTimer();
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

  // 예전엔 고른 후 0~10초 사이 무작위 순간에 자동으로 터졌지만, "내가 원할 때 스페이스바로 직접
  // 터뜨리고 싶다"는 피드백으로 수동 트리거로 바꿨다 — 실제 발동은 fireFlashAll()에서, 스페이스바
  // (handleRewardUse의 FLASH_ALL 분기) 또는 본행동 타이머가 만료됐을 때의 안전장치로 일어난다.
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
  if (mg.type === 'DICE') return handleDice(id, payload, mg);
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
  armNimTimer(mg); // 다음 사람 차례로 "장고 금지" 데드라인을 새로 건다
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
  if (mg.hiderPick != null && mg.guesserPick == null) armHandTimer(mg); // 이제 지목하는 사람 차례로 데드라인 갱신
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
  armPinTimer(mg); // 다음 사람 차례로 "장고 금지" 데드라인을 새로 건다
  broadcastState();
}

// 6) 금은동 쟁탈전 — 화면에 뜬 금/은/동 버튼을 정해진 순서(금→은→동)대로 최대한 빨리 눌러야
// 한다. 순서를 벗어난 클릭은 그냥 무시되며(패널티 없이 다시 누르면 됨), 셋을 순서대로 먼저 다
// 끝낸 사람이 그 자리에서 즉시 승리한다 — 외울 규칙이 사실상 없는 순수 반응속도 게임이다.
function sigilNeededTier(mg, id) {
  const mine = mg.progress[id];
  for (const t of MEDAL_ORDER) {
    if ((mine[t] || 0) < mg.itemCounts[t]) return t;
  }
  return null; // 이미 금/은/동을 모두 다 끝냈음(상대가 아직 게임 중일 뿐)
}
function handleSigil(id, payload, mg) {
  const neededTier = sigilNeededTier(mg, id);
  if (neededTier == null) return;
  if (payload.tier !== neededTier) return; // 순서를 벗어난(아직 차례가 안 된 색) 클릭은 그냥 무시
  mg.progress[id][neededTier] += 1;
  if (sigilNeededTier(mg, id) == null) {
    log(`${match.players[id].name}이(가) 금·은·동을 순서대로 먼저 다 낚아챘습니다!`);
    broadcastState();
    return endMinigame(id);
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

// 12) 주사위 누르기 — 스페이스바를 꾹 누르고 있다가(PRESS) 떼는(RELEASE) 순간의 실제 경과시간으로
// 눈(1~6)이 확정된다. 큰 눈이 승리, 같으면 무승부. finalizeDiceResult가 실제 확정/승부판정을 맡고,
// armDiceTimer의 강제 타임아웃도 (누르지도 않은 채) 이 함수를 거치지 않고 바로 그걸 호출한다.
function finalizeDiceResult(id, mg, number) {
  mg.pressAt[id] = null;
  mg.results[id] = number;
  mg.finalizedAt[id] = Date.now(); // "동점이면 더 먼저 주사위를 놓은 사람이 승" 판정용 — release(확정) 시각을 기록
  log(`${match.players[id].name}: 주사위 ${number} 확정`);
  const [a, b] = match.order;
  if (mg.results[a] != null && mg.results[b] != null) {
    log(`주사위 공개: ${match.players[a].name}=${mg.results[a]} vs ${match.players[b].name}=${mg.results[b]}`);
    broadcastState();
    if (mg.results[a] === mg.results[b]) {
      mg.tieRound = (mg.tieRound || 0) + 1;
      if (mg.tieRound <= CONFIG.DICE_MAX_TIE_REPLAYS) {
        log(`둘 다 ${mg.results[a]} — 동점! 다시 굴립니다. (재대결 ${mg.tieRound}/${CONFIG.DICE_MAX_TIE_REPLAYS})`);
        io.to(a).emit('popup', { text: `🎲 동점! 다시 굴리세요 (재대결 ${mg.tieRound}/${CONFIG.DICE_MAX_TIE_REPLAYS})`, tone: 'warn' });
        io.to(b).emit('popup', { text: `🎲 동점! 다시 굴리세요 (재대결 ${mg.tieRound}/${CONFIG.DICE_MAX_TIE_REPLAYS})`, tone: 'warn' });
        mg.results = {};
        mg.pressAt = {};
        mg.finalizedAt = {};
        armDiceTimer(mg);
        broadcastState();
        return;
      }
      // 재대결까지 다 써도 여전히 동점 — 더 먼저 주사위를 놓은(release가 빠른) 쪽이 승리
      const winner = mg.finalizedAt[a] <= mg.finalizedAt[b] ? a : b;
      log(`재대결까지도 동점 — 더 먼저 주사위를 놓은 ${match.players[winner].name}의 승리로 처리합니다.`);
      return endMinigame(winner);
    }
    return endMinigame(mg.results[a] > mg.results[b] ? a : b);
  }
  broadcastState();
}
function handleDice(id, payload, mg) {
  if (mg.results[id] != null) return; // 이미 확정됨 — 뒤늦게 오는 메시지 무시
  const action = payload && payload.action;
  if (action === 'PRESS') {
    if (mg.pressAt[id] != null) return; // 이미 누르고 있는 중
    mg.pressAt[id] = Date.now();
    broadcastState(); // 상대에게도 "누르는 중" 실시간 표시를 위해
    return;
  }
  if (action === 'RELEASE') {
    if (mg.pressAt[id] == null) return; // 누른 적 없이 뗄 수는 없음
    const elapsed = Date.now() - mg.pressAt[id];
    const number = 1 + Math.floor(elapsed / CONFIG.DICE_CYCLE_MS) % 6;
    finalizeDiceResult(id, mg, number);
  }
}

// ------------------------------ 본행동(액션) ---------------------------------
// 본행동: 라운드마다 CONFIG.OPENS_PER_TURN(기본 2)번의 행동 예산만큼 내 처소의 칸을 연다.
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
  resolveOpen(id, player, row, col, cell);
  match.actionOpens[id] = opens + 1;
  checkRoundActionDone();
}

function resolveOpen(id, player, row, col, cell) {
  cell.opened = true;
  // 이 칸에 상대가 남겨둔 협박 표식이 있었다면, 더 이상 "안 연 칸"이 아니므로 표식도 함께 지운다.
  if (player.threatMarks && player.threatMarks.length) {
    player.threatMarks = player.threatMarks.filter((m) => !(m.row === row && m.col === col));
  }
  const t = cell.type;
  actionLog(player, `술잔 고르기 → (${row + 1},${col + 1}) = ${CELL_NAMES[t]}`);
  if (t === 'P') {
    // 몇 차(1차/2차) 독인지에 따라 종료 시 감점이 다르지만, 그 사실 자체를 여는 순간 숫자로
    // 알려주면 몇 차 독인지가 그대로 드러나 버린다(같은 칸 위치라도 1차/2차 어느 쪽이든 될 수
    // 있어 원래는 구분할 수 없는 정보다) — 그래서 여기서는 구체적인 감점 액수를 밝히지 않고,
    // 정확한 액수는 게임이 끝났을 때(최종 점수 내역)만 공개한다.
    if (cell.poisonWave === 2) player.poisonMid += 1; else player.poisonInitial += 1;
    player.poisonEverFound += 1;
    actionLog(player, '독배를 마셨습니다... (해독하지 못하면 게임 종료 시 감점 — 몇 점인지는 종료 후 공개)');
    notifyPoisonDrink(id);
    checkNeutralize(id, player);
  } else if (t === 'GEM') {
    resolveGemOpen(player, row, col, cell);
  } else if (t === 'A') {
    player.antidote += 1;
    checkNeutralize(id, player);
  }
}

// 보석 조각 하나를 발견했을 때: 조각당 +GEM_PIECE_PTS는 항상 즉시 받는다. 이 보석이 여러 칸짜리
// (긴 것=2칸/네모=4칸)이고 이번이 그 보석의 "첫 조각"이라면, 아직 안 연 나머지 조각이 방금 연
// 칸을 기준으로 어느 방향에 있는지 바로 알려준다(자기 처소 안 정보라 숨길 이유가 없다). 남은
// 조각이 하나도 없다면(=이번 조각으로 완성) 조각 점수와는 별개로 크기만큼 추가 보너스를 준다.
function resolveGemOpen(player, row, col, cell) {
  const gem = player.gems[cell.gemId];
  player.score += CONFIG.GEM_PIECE_PTS;
  if (!gem) return; // 안전장치 — 있을 수 없는 상태
  const remaining = gem.cells.filter((c) => !player.room[c.row][c.col].opened);
  const foundSoFar = gem.size - remaining.length;
  if (gem.size === 1) {
    actionLog(player, `보석을 발견했습니다! (+${CONFIG.GEM_PIECE_PTS}점)`);
  } else if (foundSoFar === 1) {
    const dirLabel = ({ '-1,0': '위', '1,0': '아래', '0,-1': '왼쪽', '0,1': '오른쪽' });
    const dirs = remaining.map((c) => dirLabel[`${c.row - row},${c.col - col}`] || '근처').join('/');
    actionLog(player, `보석 조각을 발견했습니다! (+${CONFIG.GEM_PIECE_PTS}점, 1/${gem.size}) — 나머지 조각이 이 칸 ${dirs} 방향에 있습니다.`);
  } else {
    actionLog(player, `보석 조각을 발견했습니다! (+${CONFIG.GEM_PIECE_PTS}점, ${foundSoFar}/${gem.size})`);
  }
  if (remaining.length === 0) {
    const bonus = gem.size * CONFIG.GEM_COMPLETE_BONUS_PER_PIECE;
    player.score += bonus;
    actionLog(player, `보석을 완성했습니다! 추가 보너스 +${bonus}점!`);
    log(`${player.name}이(가) 보석(${gem.size}조각)을 완성했습니다!`);
  }
}

function checkNeutralize(id, player) {
  // 해독은 항상 더 비싼(감점이 큰) 2차 독부터 상쇄한다 — 플레이어 입장에서 손해볼 일이 없는
  // 자동 최적 처리이자, "2차 독이 더 아프다"는 설계 의도를 실제로 살려준다.
  while (player.antidote >= CONFIG.ANTIDOTE_NEED && (player.poisonMid > 0 || player.poisonInitial > 0)) {
    if (player.poisonMid > 0) player.poisonMid -= 1; else player.poisonInitial -= 1;
    player.antidote -= CONFIG.ANTIDOTE_NEED;
    actionLog(player, `해독제 ${CONFIG.ANTIDOTE_NEED}개로 독 1개 무효화!`);
    notifyNeutralize(id, CONFIG.ANTIDOTE_NEED);
  }
}

// ------------------------------ 실시간 이벤트 팝업 -----------------------------
// "지금 상황이 계속 팝업으로 떴으면 좋겠다"는 피드백 — 독배를 마시거나 해독하는 순간을 양쪽
// 모두에게 즉시 알려준다. 주의: 이건 기존에 지켜오던 "상대 상태는 게임이 끝나기 전까지 모른다"는
// 히든정보 설계를 일부러 깨는 것이라고 사전에 알렸고, 그래도 실시간 공개를 원한다는 답을 받아
// 반영한 것이다 — GEM/문장 발견처럼 다른 이벤트까지 전부 공개하는 건 아니고 독배/해독제로 범위를
// 좁혔다.
function notifyPoisonDrink(id) {
  const player = match.players[id];
  const oppId = otherId(id);
  io.to(id).emit('popup', { text: '🍷 내가 독배를 마심!', tone: 'bad' });
  if (oppId) io.to(oppId).emit('popup', { text: `🍷 ${player.name}이(가) 독배를 마심!`, tone: 'warn' });
  // [2026-10-01] "암살 긴장감을 더 줘야 한다" — 토스트 문구만으론 약하니, 독을 발견한 바로 그
  // 순간 화면이 직접 반응하는 전용 이벤트를 추가한다('popup'과 별개로, 클라이언트가 화면 전체
  // 플래시/흔들림 연출을 트리거하는 데만 쓴다). 마신 사람은 'self', 지켜보는 상대는 'opp'로
  // 받아 서로 다른(더 약한) 연출을 보여줄 수 있게 구분한다.
  io.to(id).emit('drama', { kind: 'POISON', role: 'self' });
  if (oppId) io.to(oppId).emit('drama', { kind: 'POISON', role: 'opp', name: player.name });
}
function notifyNeutralize(id, count) {
  const player = match.players[id];
  const oppId = otherId(id);
  io.to(id).emit('popup', { text: `💊 해독제 ${count}개 발견으로 독을 해독!`, tone: 'good' });
  if (oppId) io.to(oppId).emit('popup', { text: `💊 상대가 해독제 ${count}개 발견으로 독을 해독!`, tone: 'info' });
}

// 철가방 정찰(FLASH_ALL) 실제 발동 — 스페이스바(handleRewardUse)나 본행동 타이머 만료(안전장치)
// 어느 쪽에서 불려도 완전히 동일하게 동작한다.
function fireFlashAll(id) {
  const pr = match.pendingReward;
  if (!pr || pr.winnerId !== id || pr.type !== 'FLASH_ALL' || pr.used) return;
  pr.used = true;
  const winner = match.players[id];
  winner.rewardUses.FLASH_ALL = (winner.rewardUses.FLASH_ALL || 0) + 1;
  const room = winner.room.map((r) => r.map((cell) => cell.type));
  actionLog(winner, `보상 발동 — 철가방 정찰로 내 처소 전체가 ${(CONFIG.REWARD_FLASH_REVEAL_MS / 1000).toFixed(1)}초간 드러났습니다.`);
  io.to(id).emit('rewardResult', { kind: 'FLASH_ALL', room, revealMs: CONFIG.REWARD_FLASH_REVEAL_MS });
  broadcastState();
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
  if (pr.type === 'FLASH_ALL') {
    // 스페이스바(또는 클릭)를 누른 바로 그 순간 즉시 발동 — 더 이상 무작위 자동 타이머가 아니다.
    return fireFlashAll(id);
  }
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
    // 아직 후반에 열리지 않은 줄은 애초에 집계 대상에서 뺀다 — "아직 안 연 칸" 정보가
    // 0으로라도 섞여 나가지 않도록, 실제로 활성화된 줄 수만큼만 돈다.
    const activeRows = (player.room[CONFIG.ROWS_FIRST_HALF] && player.room[CONFIG.ROWS_FIRST_HALF][0].locked)
      ? CONFIG.ROWS_FIRST_HALF : CONFIG.ROWS_TOTAL;
    const rowN = activeRows, colN = CONFIG.GRID;
    const outerN = axis === 'row' ? rowN : colN;
    const innerN = axis === 'row' ? colN : rowN;
    const matchesTarget = (cell) => cell.type === targetType;
    const counts = [];
    for (let idx = 0; idx < outerN; idx++) {
      let count = 0;
      for (let i = 0; i < innerN; i++) {
        const cell = axis === 'row' ? player.room[idx][i] : player.room[i][idx];
        if (!cell.locked && matchesTarget(cell)) count += 1;
      }
      counts.push(count);
    }
    const axisLabel = axis === 'row' ? '가로줄' : '세로줄';
    actionLog(player, `보상 사용 — 내 처소 각 ${axisLabel}의 ${CLUE_CAT_NAMES[targetType]} 개수 확인 → [${counts.join(', ')}]`);
    io.to(id).emit('rewardResult', { kind: pr.type, targetType, counts });
    broadcastState();
    return;
  }
  // 협박 표식(MARK) — 다른 4종과 반대로 "내 처소"가 아니라 상대 처소의 아직 안 연 칸 하나를
  // 겨냥한다. 공격자도 그 칸의 실제 정체는 전혀 모른 채(기억이나 짐작으로만) 찍는 것이라 진짜
  // 경고일 수도, 순전한 허세일 수도 있다 — 그래서 cell.type은 절대 건드리지 않고 opp.threatMarks
  // 에만 좌표를 추가한다(실제 정체 유출 없음).
  if (pr.type === 'MARK') {
    const row = Number(payload.row), col = Number(payload.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= CONFIG.ROWS_TOTAL || col < 0 || col >= CONFIG.GRID) return;
    const targetCell = opp.room[row] && opp.room[row][col];
    if (!targetCell || targetCell.locked || targetCell.opened) return;
    if (!opp.threatMarks) opp.threatMarks = [];
    if (opp.threatMarks.some((m) => m.row === row && m.col === col)) return; // 이미 표식이 있는 칸은 중복 금지
    pr.used = true;
    player.rewardUses.MARK = (player.rewardUses.MARK || 0) + 1;
    opp.threatMarks.push({ row, col });
    actionLog(player, `보상 사용 — 상대 처소 (${row + 1},${col + 1})에 협박 표식을 남겼습니다.`);
    io.to(id).emit('rewardResult', { kind: 'MARK', row, col });
    const oppId = otherId(id);
    if (oppId) io.to(oppId).emit('popup', { text: '😨 누군가 내 처소 어딘가에 표식을 남겼다...', tone: 'warn' });
    broadcastState();
    return;
  }
}

// ------------------------------ 라운드 진행/종료 -----------------------------
// 처소 열기는 두 사람이 각자 동시에 진행하므로, 한 명이 칸을 열 때마다 이 함수로 상태를 갱신한다.
// [2026-10-01] "둘 다 칸 열기를 마쳐도 문장 퍼즐 시간이 남았으면 화면이 안 바뀌었으면 해" 피드백
// 으로, 더 이상 여기서 "둘 다 마쳤으니 바로 다음 단계로" 넘기지 않는다 — 다음 단계로의 전환은
// armActionTimer()의 타이머가 끝나는 시점(advanceAfterRoundAction())에서만 일어난다. 그래서 이제
// 매 라운드는 둘 다 금방 다 열어도 본행동 타이머(=문장 퍼즐 타이머)가 끝날 때까지 항상 유지된다.
function checkRoundActionDone() {
  broadcastState();
}

// 본행동(ROUND_ACTION) 타이머가 끝나는 시점에만 호출된다 — 이 시점엔 armActionTimer()가 못 다
// 연 나머지를 전부 "포기(forfeit)" 처리해둔 뒤이므로, 두 사람 다 항상 "마쳤거나 포기함" 상태다.
function advanceAfterRoundAction() {
  if (match.phase !== 'ROUND_ACTION') return;
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

// 동점 처리 순서 — 1) 최종 점수, 2) (동점이면) 독을 더 적게 먹은 쪽, 3) (그마저 같으면) 해독을
// 더 많이 한 쪽, 4) (그마저 같으면) 완성한 보석 개수가 더 많은 쪽. 그래도 완전히 같으면 무승부.
function endMatchByScore() {
  const [a, b] = match.order;
  const pa = match.players[a], pb = match.players[b];
  // "완전 해독 생환 보너스" — 독을 한 번이라도 마셨지만(poisonEverFound≥1) 끝까지 전부 해독해
  // 최종 감점이 0이라면, 암살 위기를 넘겼다는 의미로 추가 점수를 준다. 독을 아예 안 마신
  // 경우는 "위기 자체가 없었다"는 뜻이라 지급하지 않는다.
  const survivalBonus = (p) => (p.poisonEverFound > 0 && poisonPenaltyTotal(p) === 0) ? CONFIG.FULL_NEUTRALIZE_BONUS_PTS : 0;
  [pa, pb].forEach((p) => {
    const bonus = survivalBonus(p);
    if (bonus > 0) {
      p.score += bonus;
      log(`${p.name}이(가) 독배를 전부 해독해 완전 해독 생환 보너스 +${bonus}점을 얻었습니다!`);
    }
  });
  const finalize = (p) => p.score - poisonPenaltyTotal(p);
  const fa = finalize(pa), fb = finalize(pb);
  pa.finalScore = fa; pb.finalScore = fb;
  let winner = null, reason;
  if (fa !== fb) {
    winner = fa > fb ? a : b;
    reason = `${CONFIG.ROUNDS_TOTAL}라운드 종료 — 최종 점수 비교 승리 (독배 감점 반영)`;
  } else if (poisonTotal(pa) !== poisonTotal(pb)) {
    // 최종 점수가 완전히 같으면, 무효화하지 못한 독을 더 적게 마신 쪽(더 안전하게 버틴 쪽)이 승리한다.
    winner = poisonTotal(pa) < poisonTotal(pb) ? a : b;
    reason = `${CONFIG.ROUNDS_TOTAL}라운드 종료 — 점수 동률, 독 개수로 승부 판정`;
  } else if ((pa.antidote || 0) !== (pb.antidote || 0)) {
    winner = (pa.antidote || 0) > (pb.antidote || 0) ? a : b;
    reason = `${CONFIG.ROUNDS_TOTAL}라운드 종료 — 점수·독 동률, 해독제 개수로 승부 판정`;
  } else {
    const gemsA = gemSummary(pa).completed, gemsB = gemSummary(pb).completed;
    if (gemsA !== gemsB) {
      winner = gemsA > gemsB ? a : b;
      reason = `${CONFIG.ROUNDS_TOTAL}라운드 종료 — 점수·독·해독 동률, 완성한 보석 개수로 승부 판정`;
    } else {
      reason = `${CONFIG.ROUNDS_TOTAL}라운드 종료 — 점수·독·해독·보석 완전 동률(무승부)`;
    }
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

// 보석 현황 요약 — gemId별로 { size, foundCount, completed }. 아직 하나도 못 찾은 보석은
// 존재 자체가 스포일러이므로 목록에서 아예 뺀다. buildClientState와 buildAdminState가 함께
// 쓰므로 모듈 스코프에 둔다.
function gemSummary(player) {
  const out = {};
  let piecesFound = 0, completed = 0;
  for (const [gemId, gem] of Object.entries(player.gems)) {
    const foundCount = gem.cells.filter((c) => player.room[c.row][c.col].opened).length;
    piecesFound += foundCount;
    const isDone = foundCount === gem.size;
    if (isDone) completed += 1;
    if (foundCount > 0) out[gemId] = { size: gem.size, foundCount, completed: isDone };
  }
  return { gems: out, piecesFound, completed };
}

// ------------------------------ 소켓 -----------------------------------------
function buildClientState(forId) {
  const me = match.players[forId];
  const oppId = otherId(forId);
  const opp = oppId ? match.players[oppId] : null;
  const sanitizeRoom = (ownerPlayer, revealAll) =>
    ownerPlayer.room.map((row, r) => row.map((cell, c) => ({
      opened: cell.opened,
      locked: cell.locked,
      type: cell.opened || revealAll ? cell.type : (cell.cluedType || null),
      note: cell.cluedNote || null,
      // 상대가 남긴 협박 표식 — 실제 정체(type)는 전혀 안 알려주고, "표식이 있다"는 사실만.
      marked: !cell.opened && (ownerPlayer.threatMarks || []).some((m) => m.row === r && m.col === c),
      // 같은 보석의 조각끼리 묶어서 보여주기 위한 id — 실제로 공개된 보석 칸일 때만 내려준다.
      gemId: (cell.opened || revealAll) && cell.type === 'GEM' ? cell.gemId : null,
      // 이 칸이 보석 전체에서 어느 조각(위/아래, 좌상/좌하/우상/우하 등)인지 — 옛 "가문의 문장"
      // 조각 이미지처럼 칸마다 보석의 한 조각만 보이게 그리기 위한 라벨.
      gemPiece: (cell.opened || revealAll) && cell.type === 'GEM' ? cell.gemPiece : null,
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
    // "장고 금지" — 본행동(칸 열기/문장 조립) 라운드가 몇 시에 시간초과되는지. 다 되면 서버가
    // 아직 다 안 연 사람의 나머지 칸을 대신 무작위로 열어준다(armActionTimer).
    actionDeadlineAt: match.phase === 'ROUND_ACTION' ? match.actionDeadlineAt : null,
    // 보상은 승자가 직접 고르는 구조 — type이 아직 null이면 choices 중 하나를 골라야 한다.
    // 철가방(FLASH_ALL)은 이제 스페이스바로 직접 터뜨리는 방식이라 언제 터질지 숨길 이유가 없다.
    myReward: pr && pr.winnerId === forId ? {
      type: pr.type,
      name: pr.type ? REWARD_NAMES[pr.type] : null,
      used: pr.used,
      choices: pr.type ? null : pr.choices.map((t) => ({
        type: t, name: REWARD_NAMES[t],
        usesLeft: rewardUseLimitFor(t) - (me.rewardUses[t] || 0),
      })),
    } : null,
    oppHasReward: !!(pr && pr.winnerId !== forId && !pr.used),
    oppChoosingReward: !!(pr && pr.winnerId !== forId && !pr.type),
    // 미니게임 연승 스트릭 — 긴장감 연출(콤보 배지)용. 누구 스트릭인지와 몇 연승인지만 알려준다.
    streakOwner: match.streak.winnerId == null ? null : (match.streak.winnerId === forId ? 'me' : 'opp'),
    streakCount: match.streak.count,
    // 처소 열기는 두 사람이 동시에 독립적으로 진행 — "내 턴"은 이제 "아직 이번 라운드 몫이 남았는가"를 뜻한다.
    isMyTurn: match.phase === 'ROUND_ACTION' && (match.actionOpens[forId] || 0) < CONFIG.OPENS_PER_TURN && !match.actionForfeited[forId],
    opensRemaining: match.actionForfeited[forId] ? 0 : CONFIG.OPENS_PER_TURN - (match.actionOpens[forId] || 0),
    oppOpensRemaining: oppId ? (match.actionForfeited[oppId] ? 0 : CONFIG.OPENS_PER_TURN - (match.actionOpens[oppId] || 0)) : null,
    // "선택 안 하면 랜덤으로 안 골라졌으면 해" — 시간 초과로 이번 라운드 나머지 선택을 그냥
    // 넘긴 경우를 "다 열었음"과 구분해서 보여주기 위한 플래그.
    myActionForfeited: !!match.actionForfeited[forId],
    oppActionForfeited: oppId ? !!match.actionForfeited[oppId] : false,
    // 협박 표식(MARK) 보상을 고른 뒤, 아직 어느 칸을 찍을지 안 정했을 때만 내려준다 — 상대 처소의
    // "찍을 수 있는 칸"(안 잠기고, 안 열리고, 아직 표식도 없는 칸) 마스크만 알려주고 내용물은
    // 전혀 알려주지 않는다(공격자도 모른 채 찍는 것이 이 보상의 핵심).
    markTargets: (pr && pr.winnerId === forId && pr.type === 'MARK' && !pr.used && opp)
      ? opp.room.map((row, r) => row.map((cell, c) =>
          !cell.locked && !cell.opened && !(opp.threatMarks || []).some((m) => m.row === r && m.col === c)))
      : null,
    // 세트 구조(3세트x4조각) 자체는 이제 공개 정보지만, 어느 칸에 무슨 조각이 있는지는 여전히
    // 비공개다. 독도 마찬가지로, 총 개수(poison)는 계속 보여주지만 1차/2차 내역(poisonInitial/
    // poisonMid — 어느 쪽이 얼마나 더 아픈지)은 게임이 끝나야만 공개한다(몇 차 독인지가 드러나면 안 되므로).
    me: me && {
      name: me.name, poison: poisonTotal(me), antidote: me.antidote, score: me.score, finalScore: me.finalScore,
      poisonInitial: match.phase === 'END' ? me.poisonInitial : null,
      poisonMid: match.phase === 'END' ? me.poisonMid : null,
      gems: gemSummary(me).gems,
      gemsFound: gemSummary(me).piecesFound,
      gemsCompleted: gemSummary(me).completed,
      gemsTotal: CONFIG.GEM_PIECES_TOTAL,
      room: sanitizeRoom(me, match.phase === 'END'),
      history: me.history || [],
    },
    // 상대의 독/해독제/처소는 게임이 끝나기 전까지 서버도 클라이언트에 내려주지 않는다
    // (콘솔로 훔쳐보기 방지). 4대 분리 모드에서도 "고르기" 화면은 이제 본인 처소만 보여주므로,
    // 레거시 2인 모드와 동일하게 상대 처소는 계속 비공개다 — "서로 뭘 골랐는지"는 화면을
    // 소프트웨어로 합쳐 보여주는 대신, 컴퓨터를 마주보게 배치하는 물리적 방식으로 해결한다.
    // MID_SETUP 동안만은 예외로, 상대 처소의 "이미 열렸는지 여부/이미 뭔가 있는지"만(내용은 여전히
    // 비공개) 알려줘야 중반 독 추가 설치에서 고를 수 없는 칸을 화면에서 걸러줄 수 있다.
    // 단, 점수(score)는 상단 점수판 요청에 따라 예외적으로 실시간 공개한다 — 독/해독제/처소
    // 내용은 여전히 비공개이므로 "패를 읽는" 추리 재미 자체는 유지된다.
    opp: opp && (match.phase === 'END'
      ? { name: opp.name, poison: poisonTotal(opp), poisonInitial: opp.poisonInitial, poisonMid: opp.poisonMid, antidote: opp.antidote, score: opp.score, finalScore: opp.finalScore, gems: gemSummary(opp).gems, gemsFound: gemSummary(opp).piecesFound, gemsCompleted: gemSummary(opp).completed, gemsTotal: CONFIG.GEM_PIECES_TOTAL, connected: opp.connected, room: sanitizeRoom(opp, true) }
      : { name: opp.name, connected: opp.connected, room: null, score: opp.score }),
    oppOpenedMask: (match.phase === 'MID_SETUP' && opp) ? opp.room.map((row) => row.map((cell) => cell.opened)) : null,
    // 상대 처소에서 "이미 뭔가 있어(독/보석/해독제) 중반 독 추가 대상이 될 수 없는 칸"까지 함께
    // 알려준다 — 내용물이 무엇인지는 여전히 비공개, 오직 "고를 수 없다"는 사실만.
    oppBlockedMask: (match.phase === 'MID_SETUP' && opp) ? opp.room.map((row) => row.map((cell) => cell.opened || cell.type !== 'E')) : null,
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
    return { fillRatio: Math.min(1, mg.count / mg.limit), myTurn: mg.turn === forId, deadlineAt: mg.deadlineAt || null };
  }
  if (mg.type === 'HAND') {
    const role = mine(mg.hider) ? 'hider' : mine(mg.guesser) ? 'guesser' : null;
    return { role, waitingForMe: (role === 'hider' && mg.hiderPick == null) || (role === 'guesser' && mg.hiderPick != null && mg.guesserPick == null), hiderDone: mg.hiderPick != null, deadlineAt: mg.deadlineAt || null };
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
    return { pinCount: mg.pinCount, pulled: mg.pulled.slice(), myTurn: mg.turn === forId, bombIndex: mg.result != null ? mg.bombIndex : null, deadlineAt: mg.deadlineAt || null };
  }
  if (mg.type === 'SIGIL') {
    return {
      itemCounts: mg.itemCounts,
      myProgress: mg.progress[forId],
      oppProgress: mg.progress[otherId(forId)],
      deadlineAt: mg.deadlineAt || null,
    };
  }
  if (mg.type === 'GUESS_COUNT') {
    const myGuess = mg.guesses[forId] ?? null;
    // 상대의 추측값은 나도 이미 추측을 마친 뒤에만(라운드가 끝난 뒤 결과 확인용으로) 내려준다.
    const oppGuess = myGuess != null ? (mg.guesses[otherId(forId)] ?? null) : null;
    return { trueCount: mg.trueCount, myGuess, oppGuess, waitingForMe: mg.guesses[forId] == null, deadlineAt: mg.deadlineAt || null };
  }
  if (mg.type === 'BANK') {
    // "상대 것은 볼 필요 없다"는 피드백으로, 더 이상 상대의 시도 내역을 보여주지 않는다 —
    // 각자 자신의 금고만 붙잡고 푸는 순수 독립 문제다.
    return {
      digits: CONFIG.BANK_DIGITS,
      myGuesses: (mg.history[forId] || []).map((h) => ({ guess: h.guess, strikes: h.strikes, balls: h.balls, marks: h.marks })),
      deadlineAt: mg.deadlineAt || null,
    };
  }
  if (mg.type === 'DICE') {
    return {
      myPressed: mg.pressAt[forId] != null, oppPressed: mg.pressAt[otherId(forId)] != null,
      myResult: mg.results[forId] ?? null,
      revealed: mg.result != null ? { myResult: mg.results[forId], oppResult: mg.results[otherId(forId)] } : null,
      deadlineAt: mg.deadlineAt || null,
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
  if (type === 'SIGIL') return { 개수구성: mg.itemCounts, 진행현황: byName(mg.progress) };
  if (type === 'GUESS_COUNT') return { 실제개수: mg.trueCount, 추측현황: byName(mg.guesses) };
  if (type === 'BANK') return {
    각자의정답: byName(mg.secrets, (v) => v.join('')),
    시도횟수: byName(mg.history, (v) => v.length),
  };
  if (type === 'DICE') return { 누른상태: byName(mg.pressAt, (v) => (v != null ? '누르는 중' : '뗌')), 확정된눈: byName(mg.results) };
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
      const gs = gemSummary(p);
      return {
        name: p.name,
        connected: p.connected,
        poison: poisonTotal(p), poisonInitial: p.poisonInitial, poisonMid: p.poisonMid, antidote: p.antidote, score: p.score, finalScore: p.finalScore,
        gems: gs.gems, gemsFound: gs.piecesFound, gemsCompleted: gs.completed, gemsTotal: CONFIG.GEM_PIECES_TOTAL,
        opens: match.actionOpens[id] || 0,
        threatMarks: p.threatMarks || [],
        // 관리자 화면의 목적은 "서로 어떤 걸 선택하고 있는지"만 보여주는 것 — 아직 열지 않은 칸의
        // 정체까지 미리 다 보여주면 그 취지를 벗어나므로, 실제로 연(선택한) 칸만 종류를 공개한다.
        room: p.room.map((row) => row.map((cell) => ({
          type: cell.opened ? cell.type : null, opened: cell.opened, locked: cell.locked,
          gemId: cell.opened && cell.type === 'GEM' ? cell.gemId : null,
          gemPiece: cell.opened && cell.type === 'GEM' ? cell.gemPiece : null,
        }))),
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

  // 중반 독 추가 설치 — 대상은 상대 처소에서 "완전히 빈 칸(E)"만 가능하다(옛 24칸의 남은 빈
  // 칸 + 새로 열리는 12칸의 빈 칸). 이미 연 칸은 물론, 이미 보석/해독제/독이 자리잡은 칸도
  // 화면에서 엑스자로 막혀 있어 애초에 고를 수 없다 — 서버도 동일한 기준으로 다시 검증한다.
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
      if (victimRoom[cell.row][cell.col].type !== 'E')
        return socket.emit('error', { message: '이미 뭔가 있는 칸에는 독을 심을 수 없습니다.' });
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
