// 4대 분리 모드: /game/A, /pick/A, /game/B, /pick/B 같은 고정 주소로 접속하면 여기서
// 역할(APP_ROLE: 'game'|'pick')과 슬롯(APP_SLOT: 'A'|'B')을 읽어낸다. 그 외 주소('/'로 접속한
// 기존 방식)는 APP_ROLE이 null로 남아 예전 동작(2인 단일화면)을 한 글자도 안 건드리고 그대로 쓴다.
const ROUTE_MATCH = location.pathname.match(/^\/(game|pick)\/([AB])\/?$/);
const APP_ROLE = ROUTE_MATCH ? ROUTE_MATCH[1] : null; // 'game' | 'pick' | null
const APP_SLOT = ROUTE_MATCH ? ROUTE_MATCH[2] : null; // 'A' | 'B' | null
const socket = APP_SLOT ? io({ query: { slot: APP_SLOT } }) : io();
const app = document.getElementById('app');
const statusBar = document.getElementById('statusBar');
const scoreBar = document.getElementById('scoreBar');
const logBox = document.getElementById('log');

let lastState = null;
let lastRenderedPhase = null; // "#app이 스크롤된 채로 화면이 바뀌어 새 화면 위쪽이 잘려 보인다"는
// 피드백 대응용 — #app은 내용이 넘칠 때 자체적으로 스크롤되는데(overflow-y:auto), 매 상태 갱신마다
// innerHTML을 통째로 다시 그려도 scrollTop은 그대로 남아있어서, 이전 화면에서 아래로 스크롤해둔
// 채로 "라운드 종료" 같은 짧은 새 화면으로 넘어가면 그 화면의 위쪽이 스크롤에 가려 안 보이는
// 문제가 있었다. 페이즈가 실제로 바뀔 때만(같은 페이즈 안에서 상대 행동 등으로 재렌더될 때는
// 사용자가 보던 스크롤 위치를 그대로 유지하도록) #app을 맨 위로 되돌린다.
let setupSelection = []; // [{row,col}]
let midSetupSelection = []; // 중반 독 추가 설치: [{row,col}]
let guessCountRound = null;
let guessCountRevealUntil = 0;
let guessCountTransitioned = false; // 공개→입력 화면 전환을 딱 한 번만 하기 위한 플래그
let guessCountEntry = ''; // 탁자 위 술잔 개수 세기: 숫자 키패드로 입력 중인 값
let guessCountScene = []; // 화면에 흩뿌려 놓을 술잔 위치(라운드당 한 번만 계산 — 매번 다시 그릴 때 위치가 흔들리지 않도록)
let sigilRound = null;
let sigilLayout = null; // { GOLD:[{x,y}], SILVER:[...], BRONZE:[...] } — 라운드당 한 번만 계산(재렌더 시 안 흔들리도록)
// "내가 누른 술잔이 안 사라지고 엉뚱한 다른 잔이 사라진다"는 피드백 — 예전엔 진행도(done) 개수만큼
// 레이아웃 배열 앞에서부터 slice해 숨겼는데, 그러면 실제로 클릭한 위치와 무관하게 "목록상 순서가
// 빠른" 잔이 사라져버렸다. 이제 각 잔마다 레이아웃 인덱스를 고유 id로 들고 있다가, 클릭한 바로 그
// 인덱스만 즉시(서버 응답을 기다리지 않고) 숨긴다.
let sigilConsumed = { GOLD: new Set(), SILVER: new Set(), BRONZE: new Set() };
let bankDigits = []; // 금고 번호 맞추기: 자릿수별 칸에 입력 중인 값([null,'5',null] 형태)
let bankFocusIndex = 0; // 지금 숫자를 채울 칸(자동으로 다음 빈 칸으로 이동)
let bankRound = null;
let bombTicking = false; // 폭탄 눈치 넘기기: 실시간 남은시간 표시용 rAF 루프가 이미 돌고 있는지
let diceHeld = false; // 주사위 누르기: 지금 내가 스페이스바/버튼을 누르고 있는 중인지(서버에 이미 PRESS를 보냈는지)
let diceFace = 1; // 누르고 있는 동안 화면에 보여줄 장식용 눈(1~6) — 실제 결과는 서버가 판정
let diceFaceTicking = false; // 위 눈 순환용 setInterval이 이미 돌고 있는지
let diceHoldStartedAt = null; // 로컬에서 누르기 시작한 시각(장식용 애니메이션 계산용, 실제 판정에는 안 쓰임)
let flashRoom = null; // 섬광 정찰 보상: 잠깐 전체 공개할 내 처소 타입 배열
let peekCell = null; // 한 칸 정찰 보상: 잠깐 불이 들어왔다 꺼지는 느낌으로 보여줄 좌표/종류 { row, col, type }
let seenSeq = null; // 서버의 match.seq — 값이 바뀌면(재대전 포함) 새 매치이므로 화면/입력 상태를 초기화
let lastRewardResult = null; // 보상으로 획득한 정찰 결과 텍스트 — #log(숨김)만으로는 안 보이므로 화면에 계속 띄워둔다
let lastRewardResultRound = null;
let activeTab = 'GAME'; // '게임 화면'(미니게임/본행동/보상)과 '6×6 화면'(내 처소)을 탭으로 분리 — 'GAME' | 'ROOM'
let lastPhaseForTab = null; // 페이즈가 "바뀌는 순간"에만 자동으로 알맞은 탭으로 전환하기 위한 추적값
let roundOpenSummary = []; // 이번 라운드에 내가 새로 연 칸들 [{row,col,type}] — ROUND_DONE 화면에서 "방금 뭘 열었는지" 보여주는 용도
let roundOpenSummaryRound = null; // roundOpenSummary가 몇 라운드 것인지(라운드가 바뀌면 초기화)
// 미니게임 모달이 "이미 떠 있던 채로" 다시 그려지는 것인지 추적 — render()는 상대의 움직임이나
// 내 입력 하나하나에도 화면 전체를 다시 그리므로, 매번 모달을 새로 마운트하면 등장 애니메이션이
// (본인이 만든 변화가 아니어도) 계속 재생되어 화면이 깜빡이는 것처럼 보인다. 직전 프레임에도
// 모달이 열려 있었다면 이번엔 애니메이션 없이 조용히 갱신한다.
let modalOpenPrev = false;

// ---------------------------- 실시간 이벤트 팝업(토스트) ----------------------------
// "지금 상황이 계속 팝업으로 떴으면 좋겠다"는 피드백 — 독배를 마시거나 해독하는 순간을 화면
// 한쪽에 토스트로 띄운다. 서버가 'popup' 이벤트로 { text, tone }을 보내주면 그대로 쌓아서
// 보여주고, 몇 초 뒤 스스로 사라진다(여러 개가 거의 동시에 와도 위에서부터 차례로 쌓임).
const toastContainer = document.createElement('div');
toastContainer.id = 'toastContainer';
document.body.appendChild(toastContainer);
function showToast(text, tone) {
  const t = document.createElement('div');
  t.className = 'toast toast-' + (tone || 'info');
  t.textContent = text;
  toastContainer.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toastShow'));
  setTimeout(() => {
    t.classList.remove('toastShow');
    setTimeout(() => t.remove(), 300);
  }, 2600);
}
socket.on('popup', ({ text, tone }) => showToast(text, tone));

// 철가방(FLASH_ALL) 스페이스바 트리거 — 선택했지만 아직 안 터뜨렸을 때, 스페이스바를 누르면
// 그 즉시 발동한다("게임" 화면은 애초에 보상 UI를 안 보여주는 화면이라 제외). 페이지 스크롤을
// 막기 위해 preventDefault, 입력창에 포커스가 가 있을 때는 무시(이 게임엔 텍스트 입력이 없지만
// 혹시 몰라 방어적으로 체크).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || APP_ROLE === 'game') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!lastState || lastState.phase !== 'ROUND_ACTION') return;
  const r = lastState.myReward;
  if (r && r.type === 'FLASH_ALL' && !r.used) {
    e.preventDefault();
    socket.emit('reward:use', {});
    return;
  }
});

// 미니게임 키보드 단축키 — 버튼 하나만 누르면 되는 미니게임(폭탄 넘기기/잔 낚아채기)은
// 스페이스바로도 똑같이 동작하게 하고, 독배 채우기(NIM)는 1~3 숫자 키로 바로 채울 수 있게 한다.
// 매번 마우스로 정확히 버튼을 조준할 필요 없이 빠르게 반응할 수 있게 하기 위함.
window.addEventListener('keydown', (e) => {
  if (!lastState || lastState.phase !== 'ROUND_MINIGAME' || !lastState.minigame) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const mg = lastState.minigame.public;
  const type = lastState.minigame.type;
  if (!mg) return;
  if (e.code === 'Space') {
    if (type === 'REFLEX' && !mg.myClicked) {
      e.preventDefault();
      socket.emit('minigame:move', { action: 'CLICK' });
    } else if (type === 'BOMB' && mg.myTurn) {
      e.preventDefault();
      socket.emit('minigame:move', { action: 'PASS' });
    } else if (type === 'DICE' && mg.myResult == null) {
      e.preventDefault();
      if (!e.repeat) startDiceHold(); // repeat: 누르고 있는 동안 OS가 반복 발생시키는 keydown은 무시
    }
    return;
  }
  if (type === 'NIM' && mg.myTurn) {
    const n = Number(e.key);
    if (n === 1 || n === 2 || n === 3) {
      e.preventDefault();
      socket.emit('minigame:move', { n });
    }
  }
});
// 스페이스바를 뗀 순간 주사위 결과를 확정한다 — keydown과 분리된 keyup 이벤트라 별도 리스너로 둔다.
window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  if (!lastState || lastState.phase !== 'ROUND_MINIGAME' || !lastState.minigame || lastState.minigame.type !== 'DICE') return;
  releaseDiceHold();
});

// ---------------------------- 임팩트 연출(화면 셰이크/플래시) ----------------------------
// "아케이드감이 덜 산다"는 피드백에 따라 추가한 순수 시각 연출 레이어. 사운드 없이, 지금의
// 어둡고 묵직한 톤(금색/진홍) 안에서 승패·위험 순간에만 화면이 반응하도록 짧고 절제된 효과만 쓴다.
let shakeTimer = null;
function screenShake(strength = 'md') {
  const target = document.body;
  target.classList.remove('shake-sm', 'shake-md', 'shake-lg');
  // 같은 프레임에 다시 트리거해도 애니메이션이 재시작되도록 강제로 리플로우시킨다.
  void target.offsetWidth;
  target.classList.add(`shake-${strength}`);
  clearTimeout(shakeTimer);
  shakeTimer = setTimeout(() => target.classList.remove(`shake-${strength}`), 420);
}
function flashScreen(kind = 'neutral') {
  const el2 = document.createElement('div');
  el2.className = `screenFlash screenFlash-${kind}`;
  document.body.appendChild(el2);
  el2.addEventListener('animationend', () => el2.remove());
  // 혹시 animationend가 안 걸리는 브라우저 대비 안전망
  setTimeout(() => el2.remove(), 900);
}
// 승패/처소 오픈 결과에 따른 임팩트를 한 곳에서 관리 — 무슨 일이 있었는지에 맞는 조합(플래시+셰이크 강도)을 고른다.
function impactFor(kind) {
  if (kind === 'win') { flashScreen('gold'); }
  else if (kind === 'lose') { flashScreen('crimson'); screenShake('md'); }
  else if (kind === 'lose-strong') { flashScreen('crimson'); screenShake('lg'); }
  else if (kind === 'draw') { flashScreen('neutral'); }
  else if (kind === 'poison') { flashScreen('crimson'); screenShake('sm'); }
  else if (kind === 'antidote') { flashScreen('teal'); }
  else if (kind === 'treasure') { flashScreen('gold'); }
}

const CELL_NAME = { P: '독', GEM: '보석', A: '해독', E: '' };
const CELL_EMOJI = { P: '☠️', GEM: '💎', A: '💊', E: '' }; // 로그 등 순수 텍스트 자리에서만 사용

// 독배/해독제/빈 칸은 실사 이미지(public/icons/*.png)를 그대로 보여주는 발광 아이콘.
// 그리드 칸(및 종료 화면 공개칸)에서 이모지 대신 실제 DOM에 그려 넣는다.
// 절대경로(/icons/..., /gems/...)로 써야 한다 — 이 화면은 /game/A, /pick/B 등 다양한 경로에서
// 열리므로, 상대경로를 쓰면 현재 주소 기준으로 잘못 풀려 이미지가 깨진다.
const ITEM_IMAGES = {
  P: { src: '/icons/poison.png', w: 438, h: 512 }, // 독배 — 해골이 떠오른 붉은 잔
  A: { src: '/icons/potion.png', w: 418, h: 483 }, // 해독제 — 초록 약병
};
// 빈 칸(E)도 "이미 열어본 술잔"답게 금잔/은잔 두 가지를 칸 좌표로 번갈아 보여준다(한쪽으로만
// 쏠리지 않도록 단순 홀짝 대신 좌표를 섞어서 분산). 빈 칸은 아무 정보가 없는 칸이라 어느 잔을
// 보여주는지는 순수 장식일 뿐 의미는 없다.
const EMPTY_CUP_IMAGES = [
  { src: '/icons/gold_cup.png', w: 409, h: 498 },
  { src: '/icons/silver_cup.png', w: 379, h: 475 },
];
function emptyCupVariant(seed) {
  const n = Number(seed) || 0;
  return EMPTY_CUP_IMAGES[Math.abs(n * 2654435761 >> 0) % EMPTY_CUP_IMAGES.length];
}
function imageIconSVG(type, src, w, h) {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="cellIcon cellIcon-${type}" aria-hidden="true">
    <image href="${src}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none"/>
  </svg>`;
}
function cellIconSVG(type, seed) {
  if (!type) return '';
  if (type === 'E') {
    const { src, w, h } = emptyCupVariant(seed);
    return imageIconSVG('E', src, w, h);
  }
  if (ITEM_IMAGES[type]) {
    const { src, w, h } = ITEM_IMAGES[type];
    return imageIconSVG(type, src, w, h);
  }
  return '';
}
// 보석은 실사 이미지(public/gems/*.png)를 쓴다. 옛 "가문의 문장" 조각 방식과 같은 원리로,
// 칸을 열면 보석 전체가 아니라 그 칸에 해당하는 "한 조각/반쪽"만 보이게 한다 — 큰 이미지 하나를
// 같은 좌표계(viewBox)로 잘라서 보여주는 방식이라, 인접한 칸들을 나란히 열면 자연스럽게 하나의
// 그림처럼 이어져 보인다. 1조각 보석(SOLO)은 왕관/인장 중 하나를 통째로 보여주고(같은 보석이면
// 항상 같은 쪽으로 — gemId로 고정), 2조각 보석(TOP/BOTTOM)은 검 이미지를 위/아래로 나눠 쓴다.
const GEM_IMAGES = {
  CROWN: { src: '/gems/crown.png', w: 475, h: 551 }, // 1조각 보석 — 왕관
  SEAL: { src: '/gems/seal.png', w: 438, h: 547 },   // 1조각 보석 — 인장
  SWORD: { src: '/gems/sword.png', w: 512, h: 839 }, // 2조각 보석 — 검(위: 손잡이, 아래: 칼날)
};
// preserveAspectRatio="none"으로 뷰박스를 칸(정사각형) 전체에 강제로 늘려 채운다 — 기본값인
// "meet"을 쓰면 뷰박스와 칸의 가로세로 비율이 달라(특히 세로로 긴 검 조각) 여백이 생겨서
// 인접한 칸의 조각과 딱 맞붙지 않고 틈이 남는다. "none"으로 늘리면 같은 원본에서 나온 두 조각이
// 항상 같은 비율로 늘어나므로(가로/세로 늘어난 비율이 조각마다 동일) 약간의 비율 왜곡은 있어도
// 이어붙는 경계선은 항상 정확히 맞아떨어진다 — 이어져 보이는 것이 실제 비율 유지보다 우선.
function gemFragmentSVG(gemPiece, gemId) {
  if (!gemPiece || gemPiece === 'SOLO') {
    const variant = (Math.abs(Number(gemId) || 0) % 2 === 0) ? GEM_IMAGES.CROWN : GEM_IMAGES.SEAL;
    const { src, w, h } = variant;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="cellIcon cellIcon-GEM" aria-hidden="true">
      <image href="${src}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none"/>
    </svg>`;
  }
  const { src, w, h } = GEM_IMAGES.SWORD;
  const half = h / 2;
  const vb = gemPiece === 'TOP' ? `0 0 ${w} ${half}` : `0 ${half} ${w} ${half}`;
  return `<svg viewBox="${vb}" preserveAspectRatio="none" class="cellIcon cellIcon-GEM" aria-hidden="true">
    <image href="${src}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none"/>
  </svg>`;
}
function cellVisualHTML(type, gemPiece, gemId) {
  if (type === 'GEM') return gemFragmentSVG(gemPiece, gemId);
  return cellIconSVG(type, gemId);
}
// 처소 패널 안에 "보석 발견 현황"을 보여주는 위젯. 조립/드래그 없이 순수 읽기 전용 —
// 조각을 몇 개 찾았는지, 완성됐는지만 배지로 보여준다. 하나도 못 찾은 보석은 존재 자체가
// 스포일러이므로 서버가 애초에 내려주지 않는다(gemSummary가 foundCount>0인 것만 담아 보냄).
function gemStatusWidget(state) {
  const me = state.me;
  const gems = me.gems || {};
  const gemIds = Object.keys(gems);
  if (gemIds.length === 0) return null;
  const wrap = el('div', 'gemStatusWrap');
  wrap.appendChild(el('h3', null, `보석 발견 현황 (${me.gemsFound || 0} / ${me.gemsTotal || '?'}조각, 완성 ${me.gemsCompleted || 0}개)`));
  const row = el('div', 'gemStatusRow');
  gemIds.forEach((gemId) => {
    const g = gems[gemId];
    const badge = el('div', 'gemStatusBadge' + (g.completed ? ' complete' : ''),
      `${g.size}조각 보석: ${g.foundCount}/${g.size}${g.completed ? ' ✓' : ''}`);
    row.appendChild(badge);
  });
  wrap.appendChild(row);
  return wrap;
}
// 셋업 화면에서 "이 칸에 독을 심겠다"고 표시만 하는 노란색 마커 — 실제 독 술잔(P) 아이콘과는
// 색을 분리해 상대에게 아직 확정되지 않은 임시 선택임을 구분한다.
function selectionMarkSVG() {
  return `<svg viewBox="0 0 32 32" class="cellIcon cellIcon-SEL" aria-hidden="true">
    <ellipse class="rim" cx="16" cy="8" rx="11.6" ry="2.2"/>
    <path class="bowl" d="M4.4,8.4 L27.6,8.4 L18.2,22 L13.8,22 Z"/>
    <path class="stem" d="M16,22 L16,26.8"/>
    <ellipse class="base" cx="16" cy="27.6" rx="6.2" ry="1.6"/>
    <path class="drip" d="M6.4,15 C5.4,17 5.5,18.8 6.6,18.8 C7.7,18.8 7.4,17 6.4,15 Z"/>
    <circle class="glyph" cx="16" cy="14" r="3.3"/>
    <ellipse class="cut" cx="14.4" cy="13.2" rx="0.8" ry="1"/>
    <ellipse class="cut" cx="17.6" cy="13.2" rx="0.8" ry="1"/>
    <rect class="cut" x="14.7" y="15.5" width="2.6" height="0.9" rx="0.3"/>
  </svg>`;
}
// 탁자 위 술잔 개수 세기 미니게임에서 흩뿌려 놓는 작은 술잔 아이콘(중립 금색 — 독/금/은 의미 없음).
function sceneCupSVG() {
  return `<svg viewBox="0 0 32 32" class="sceneCup" aria-hidden="true">
    <ellipse class="rim" cx="16" cy="8" rx="9.5" ry="1.9"/>
    <path class="bowl" d="M6.5,8.3 L25.5,8.3 L17.8,19.5 L14.2,19.5 Z"/>
    <path class="stem" d="M16,19.5 L16,23.6"/>
    <ellipse class="base" cx="16" cy="24.2" rx="5.2" ry="1.3"/>
  </svg>`;
}
// 매 라운드 한 번만 계산되는, 겹치지 않게 격자를 살짝 흔든 무작위 배치(너무 가지런해 보이지 않게).
function computeGuessCountScene(count) {
  const cols = 6, rows = 4; // 24칸 — 최대 20개까지 안전하게 배치 가능
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ r, c });
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  return cells.slice(0, count).map(({ r, c }) => ({
    x: (c + 0.5) / cols * 100 + (Math.random() * 10 - 5),
    y: (r + 0.5) / rows * 100 + (Math.random() * 14 - 7),
    rot: Math.random() * 50 - 25,
    scale: 0.85 + Math.random() * 0.4,
  }));
}
// 금은동 쟁탈전(SIGIL)용 술잔 아이콘 — sceneCupSVG와 같은 모양을 색(금/은/동)만 바꿔 재사용한다.
function medalCupIconSVG(tierClass, extraClass) {
  return `<svg viewBox="0 0 32 32" class="medalCupIcon ${tierClass}${extraClass ? ' ' + extraClass : ''}" aria-hidden="true">
    <ellipse class="rim" cx="16" cy="8" rx="9.5" ry="1.9"/>
    <path class="bowl" d="M6.5,8.3 L25.5,8.3 L17.8,19.5 L14.2,19.5 Z"/>
    <path class="stem" d="M16,19.5 L16,23.6"/>
    <ellipse class="base" cx="16" cy="24.2" rx="5.2" ry="1.3"/>
  </svg>`;
}
// 금/은/동 술잔을 한 화면에 겹치지 않게 무작위로 흩뿌려 놓을 위치 — 라운드당 한 번만 계산한다.
function computeSigilLayout(itemCounts) {
  const cols = 5, rows = 4; // 20칸 — 최대 9개(금·은·동 각 3개)까지 겹치지 않게 배치 가능
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ r, c });
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  const toPoints = (arr) => arr.map(({ r, c }) => ({
    x: (c + 0.5) / cols * 100 + (Math.random() * 8 - 4),
    y: (r + 0.5) / rows * 100 + (Math.random() * 10 - 5),
  }));
  let idx = 0;
  const layout = {};
  ['GOLD', 'SILVER', 'BRONZE'].forEach((tier) => {
    const n = itemCounts[tier] || 0;
    layout[tier] = toPoints(cells.slice(idx, idx + n));
    idx += n;
  });
  return layout;
}
// 독배 채우기(NIM) 미니게임: 정확한 숫자 대신, 잔이 얼마나 차올랐는지를 술잔 안에 차오르는
// 액체로 보여준다. ratio(0~1)만 받아서 그린다 — 정확한 누적/한계 수치는 서버가 아예 내려주지 않음.
const NIM_LIQUID_TOP_Y = 8.4, NIM_LIQUID_BOT_Y = 22;
function nimLiquidGeom(ratio) {
  const r = Math.max(0, Math.min(1, ratio || 0));
  const h = NIM_LIQUID_BOT_Y - NIM_LIQUID_TOP_Y;
  const liquidTop = NIM_LIQUID_BOT_Y - r * h;
  return { liquidTop, liquidH: NIM_LIQUID_BOT_Y - liquidTop };
}
function nimGobletSVG(ratio) {
  const { liquidTop, liquidH } = nimLiquidGeom(ratio);
  // id="nimLiquidRect"를 고정해 두면, 전체 화면이 다시 그려져도(재렌더) 다음 애니메이션 프레임에서
  // getElementById로 같은 엘리먼트를 다시 찾아 y/height를 직접 바꿀 수 있다 — "확확" 튀지 않고
  // "찔끔찔끔" 부드럽게 차오르게 하기 위한 장치(자세한 애니메이션 루프는 startNimAnimLoop 참고).
  return `<svg viewBox="0 0 32 32" class="nimGoblet" aria-hidden="true">
    <defs><clipPath id="nimClip"><path d="M4.4,8.4 L27.6,8.4 L18.2,22 L13.8,22 Z"/></clipPath></defs>
    <rect id="nimLiquidRect" class="liquid" x="0" y="${liquidTop.toFixed(2)}" width="32" height="${liquidH.toFixed(2)}" clip-path="url(#nimClip)"/>
    <ellipse class="rim" cx="16" cy="8" rx="11.6" ry="2.2"/>
    <path class="bowl" d="M4.4,8.4 L27.6,8.4 L18.2,22 L13.8,22 Z"/>
    <path class="stem" d="M16,22 L16,26.8"/>
    <ellipse class="base" cx="16" cy="27.6" rx="6.2" ry="1.6"/>
  </svg>`;
}
// 술잔이 목표 눈금까지 한 번에 "확" 차오르는 대신 매 프레임 조금씩만 다가가도록(찔끔찔끔) 보간한다.
// 전체 화면 재렌더와 무관하게 동작해야 하므로, DOM을 매번 getElementById로 새로 찾아 직접 수정한다.
let nimDisplayedRatio = 0;
let nimTargetRatio = 0;
let nimRound = null;
function nimAnimStep() {
  if (Math.abs(nimTargetRatio - nimDisplayedRatio) > 0.0015) {
    nimDisplayedRatio += (nimTargetRatio - nimDisplayedRatio) * 0.09;
    const rect = document.getElementById('nimLiquidRect');
    if (rect) {
      const { liquidTop, liquidH } = nimLiquidGeom(nimDisplayedRatio);
      rect.setAttribute('y', liquidTop.toFixed(2));
      rect.setAttribute('height', liquidH.toFixed(2));
    }
  }
  requestAnimationFrame(nimAnimStep);
}
requestAnimationFrame(nimAnimStep);

// 폭탄 눈치 넘기기 / 안전핀 뽑기 배팅 버튼에 쓰는 일러스트풍 아이콘(기존 손그림 SVG와 같은 화법).
function bombIconSVG() {
  return `<svg viewBox="0 0 32 32" class="mgIcon mgIcon-bomb" aria-hidden="true">
    <path class="fuse" d="M17.5,8.5 C18.5,5.6 21.3,3.6 24.5,3.6"/>
    <path class="spark" d="M24.5,1.6 L24.5,3.2 M22.7,3.9 L23.9,4.9 M26.6,3.9 L25.4,4.9 M26.5,1.9 L25.3,3.6"/>
    <circle class="body" cx="15.5" cy="19.5" r="10.8"/>
    <path class="shine" d="M9,14.5 C10.2,11.8 13,10.2 15.8,10.4"/>
  </svg>`;
}
function pinIconSVG() {
  return `<svg viewBox="0 0 32 32" class="mgIcon mgIcon-pin" aria-hidden="true">
    <circle class="ring" cx="11" cy="8.5" r="5.4"/>
    <path class="shaft" d="M11,13.9 L11,19.5"/>
    <path class="leg1" d="M11,19.5 Q7,23.5 5,29"/>
    <path class="leg2" d="M11,19.5 Q15.5,23.5 18,29"/>
  </svg>`;
}
// 주사위 누르기 — 실제 주사위처럼 눈(점) 개수로 1~6을 그린다. 각 눈의 점 배치는 표준 주사위 배열.
const DICE_PIP_LAYOUTS = {
  1: [[16, 16]],
  2: [[9, 9], [23, 23]],
  3: [[9, 9], [16, 16], [23, 23]],
  4: [[9, 9], [23, 9], [9, 23], [23, 23]],
  5: [[9, 9], [23, 9], [16, 16], [9, 23], [23, 23]],
  6: [[9, 8], [23, 8], [9, 16], [23, 16], [9, 24], [23, 24]],
};
function diceFaceSVG(n, cls) {
  const pips = (DICE_PIP_LAYOUTS[n] || DICE_PIP_LAYOUTS[1]).map(([x, y]) => `<circle class="pip" cx="${x}" cy="${y}" r="2.6"/>`).join('');
  return `<svg viewBox="0 0 32 32" class="mgIcon mgIcon-dice ${cls || ''}" aria-hidden="true">
    <rect class="face" x="2" y="2" width="28" height="28" rx="6"/>
    ${pips}
  </svg>`;
}

function addLog(msg) {
  const div = document.createElement('div');
  div.textContent = msg;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

socket.on('log', ({ msg }) => addLog(msg));
socket.on('error', ({ message }) => addLog('⚠ ' + message));
// "이미 자리가 찼다"는 메시지는 대부분 예전 접속(테스트 중 남은 연결 등)이 장남/차남 자리를
// 차지하고 있어서 뜬다 — 실제 정원 초과가 아니라 자리 정리가 필요한 경우가 대부분이므로,
// 화면 아래 "게임 재시작" 버튼(이 화면 안에도 계속 남아있음)으로 바로 풀 수 있다는 걸 안내한다.
socket.on('full', () => {
  app.innerHTML = '<div class="panel center"><p>이미 장남·차남 자리가 모두 차 있습니다.</p>'
    + '<p class="hint">예전 접속이 자리를 차지하고 있는 경우가 많습니다 — 아래(화면 하단) "게임 재시작" 버튼을 누르면 모두 새로 접속한 것처럼 정리됩니다.</p></div>';
});
// 누군가 "게임 재시작"을 누르면 서버가 완전히 새 상태로 초기화하고 모든 접속자에게 새로고침을 지시한다.
// (방이 꽉 차서 막혀 있던 화면도 이걸로 확실히 풀린다.)
socket.on('reload', () => { location.reload(); });

socket.on('rewardResult', (payload) => {
  if (payload.kind === 'FLASH_ALL') {
    flashRoom = payload.room;
    const revealMs = payload.revealMs || 500;
    addLog(`⚡ 섬광 정찰 — 내 처소 전체가 ${(revealMs / 1000).toFixed(1)}초간 드러났습니다.`);
    render(lastState);
    setTimeout(() => { flashRoom = null; render(lastState); }, revealMs);
    return;
  }
  if (payload.kind === 'PEEK_CELL') {
    const text = `🔎 한 칸 정찰 결과: 내 처소 (${payload.row + 1},${payload.col + 1}) = ${CELL_EMOJI[payload.type] || ''} ${CELL_NAME[payload.type] || ''}`;
    addLog(text);
    lastRewardResult = text;
    lastRewardResultRound = lastState ? lastState.round : null;
    // "사용하면 그 칸에 들어온 불이 꺼지는 느낌" — 해당 칸에 잠깐 불이 들어왔다가(정체 공개)
    // 저절로 다시 꺼지는 것처럼 보여준다. 실제로 칸을 연 것은 아니므로 잠시 후 다시 안 연 상태로 되돌아간다.
    const PEEK_REVEAL_MS = 1400;
    peekCell = { row: payload.row, col: payload.col, type: payload.type };
    render(lastState);
    setTimeout(() => { peekCell = null; render(lastState); }, PEEK_REVEAL_MS);
    return;
  }
  if (payload.kind === 'ROW_COUNT' || payload.kind === 'COL_COUNT') {
    const axisLabel = payload.kind === 'ROW_COUNT' ? '가로줄' : '세로줄';
    const catName = (lastState && lastState.clueCatNames && lastState.clueCatNames[payload.targetType]) || payload.targetType;
    const breakdown = payload.counts.map((c, i) => `${i + 1}번 ${c}개`).join(' · ');
    const text = `🔎 정찰 결과: 내 처소 각 ${axisLabel}의 ${catName} 개수 — ${breakdown}`;
    addLog(text);
    lastRewardResult = text;
    lastRewardResultRound = lastState ? lastState.round : null;
  }
  render(lastState);
});

// 이전 프레임과 diff해서 "방금 막 일어난 일"을 감지하고 그에 맞는 임팩트 연출을 트리거한다.
// 서버는 결과가 이미 반영된 최종 상태만 내려주므로, 클라이언트가 직접 "null→값이 생김"
// 전환 순간을 잡아야 한다. 새 매치가 막 시작된 프레임(prev==null 또는 seq가 바뀐 경우)에는
// 절대 트리거하지 않는다 — 안 그러면 접속하자마자 이전 판의 잔상으로 오작동한다.
function detectImpacts(prev, next) {
  if (!prev) return;
  const prevResult = prev.minigame && prev.minigame.result;
  const nextResult = next.minigame && next.minigame.result;
  if (!prevResult && nextResult) {
    if (nextResult === 'me') impactFor('win');
    else if (nextResult === 'opp') impactFor(next.minigame.type === 'BOMB' ? 'lose-strong' : 'lose');
    else if (nextResult === 'draw') impactFor('draw');
  }
  if (prev.me && next.me && Array.isArray(prev.me.room) && Array.isArray(next.me.room)) {
    let revealed = null; // 우선순위: 독 > 해독제 > 보석
    for (let r = 0; r < next.me.room.length; r++) {
      for (let c = 0; c < next.me.room[r].length; c++) {
        const before = prev.me.room[r] && prev.me.room[r][c];
        const after = next.me.room[r][c];
        if (before && !before.opened && after.opened) {
          if (after.type === 'P') revealed = 'P';
          else if (after.type === 'A' && revealed !== 'P') revealed = 'A';
          else if (after.type === 'GEM' && !revealed) revealed = 'GEM';
          // "칸을 열자마자 바로 다음으로 넘어가 뭘 열었는지 놓친다"는 피드백 — 이번 라운드에
          // 새로 연 칸을 전부 기록해뒀다가, ROUND_DONE(5초 대기) 화면에서 한눈에 보여준다.
          if (next.round !== roundOpenSummaryRound) { roundOpenSummary = []; roundOpenSummaryRound = next.round; }
          roundOpenSummary.push({ row: r, col: c, type: after.type, gemId: after.gemId || null, gemPiece: after.gemPiece || null });
        }
      }
    }
    if (revealed === 'P') impactFor('poison');
    else if (revealed === 'A') impactFor('antidote');
    else if (revealed === 'GEM') impactFor('treasure');
  }
}

socket.on('state', (state) => {
  if (state.seq !== seenSeq) {
    // 새 매치 시작(최초 접속 또는 재대전) — 지난 판에서 남은 화면/입력 상태를 전부 초기화
    seenSeq = state.seq;
    setupSelection = [];
    midSetupSelection = [];
    guessCountRound = null;
    guessCountRevealUntil = 0;
    guessCountTransitioned = false;
    guessCountEntry = '';
    guessCountScene = [];
    sigilRound = null;
    sigilLayout = null;
    sigilConsumed = { GOLD: new Set(), SILVER: new Set(), BRONZE: new Set() };
    bankDigits = [];
    bankFocusIndex = 0;
    bankRound = null;
    flashRoom = null;
    peekCell = null;
    lastRewardResult = null;
    lastRewardResultRound = null;
    nimDisplayedRatio = 0;
    nimTargetRatio = 0;
    nimRound = null;
    activeTab = 'GAME';
    lastPhaseForTab = null;
    roundOpenSummary = [];
    roundOpenSummaryRound = null;
    lastState = state; // 새 매치 프레임은 diff 기준으로 삼지 않는다
    render(state);
    return;
  }
  detectImpacts(lastState, state);
  lastState = state;
  render(state);
});

document.getElementById('btnReset').onclick = () => { if (confirm('게임을 재시작할까요? (두 플레이어 모두 다시 접속해야 할 수 있습니다)')) socket.emit('admin:reset'); };

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

// 숫자 입력이 필요한 미니게임(촛불 개수 맞히기 / 금고 번호 맞추기)에서 공용으로 쓰는 화면 키패드.
// 예전에는 <input type=number>를 썼는데, 서버 상태가 자주 갱신될 때마다 화면 전체가 다시 그려지며
// 입력하던 값이 통째로 지워지는 문제가 있었다("갯수입력이 잘 안되네"). 값을 DOM이 아니라 JS 변수에
// 저장하고 버튼 클릭으로만 값을 바꾸는 방식으로 바꿔서, 다시 그려져도 값이 유지되게 했다.
function numKeypad(opts) {
  const wrap = el('div', 'numpadWrap');
  if (opts.wrapId) wrap.id = opts.wrapId;
  const display = el('div', 'numpadDisplay', opts.get() || '&nbsp;');
  wrap.appendChild(display);
  const refreshDisplay = () => { display.textContent = opts.get() || ' '; };
  const pad = el('div', 'numpad');
  const appendDigit = (d) => {
    const cur = opts.get();
    if (cur.length >= opts.maxLen) return;
    if (opts.allowDigit && !opts.allowDigit(d, cur)) return;
    opts.set(cur + d);
    refreshDisplay();
  };
  for (let n = 1; n <= 9; n++) {
    const b = el('button', 'numkey', String(n));
    b.onclick = () => appendDigit(String(n));
    pad.appendChild(b);
  }
  const back = el('button', 'numkey numkeyFn', '⌫');
  back.onclick = () => { opts.set(opts.get().slice(0, -1)); refreshDisplay(); };
  pad.appendChild(back);
  const zero = el('button', 'numkey', '0');
  zero.onclick = () => appendDigit('0');
  pad.appendChild(zero);
  const submit = el('button', 'numkey numkeyFn primary', opts.submitLabel || '제출');
  submit.onclick = () => {
    const ok = opts.onSubmit(opts.get());
    if (ok !== false) { opts.set(''); refreshDisplay(); }
  };
  pad.appendChild(submit);
  wrap.appendChild(pad);
  return wrap;
}

// 금고 번호 맞추기 전용 — "이어붙여 입력"이 아니라 자릿수별 칸을 하나씩 채우는 입력판.
// 칸을 직접 클릭해 옮겨갈 수도 있고, 숫자를 누르면 자동으로 다음 빈 칸으로 넘어간다.
// 숫자를 누를 때마다 화면 전체(render(lastState))를 다시 그리면, 미니게임이 팝업 모달로 떠
// 있는 동안 그 모달의 등장 애니메이션(페이드인+팝인)이 매번 처음부터 재생되어 화면이 깜빡이는
// 것처럼 보인다 — 숫자 입력 자체는 서버와 무관한 순수 로컬 UI이므로, 이 칸들만 제자리에서
// 다시 그린다(전체 화면 재렌더 없이).
function digitCellsInput(opts) {
  const wrap = el('div', 'digitCellsWrap');
  if (opts.wrapId) wrap.id = opts.wrapId;
  const cellsRow = el('div', 'digitCellsRow');
  wrap.appendChild(cellsRow);

  const renderCells = () => {
    cellsRow.innerHTML = '';
    const digits = opts.digits();
    for (let i = 0; i < opts.len; i++) {
      const cell = el('div', 'digitCell input' + (opts.focusIndex() === i ? ' focused' : ''), digits[i] != null ? String(digits[i]) : '');
      cell.onclick = () => { opts.setFocusIndex(i); renderCells(); };
      cellsRow.appendChild(cell);
    }
  };
  renderCells();

  const appendDigit = (d) => {
    const cur = opts.digits();
    if (cur.includes(d)) return; // 서로 다른 숫자만 허용
    const idx = opts.focusIndex();
    const next = cur.slice();
    next[idx] = d;
    opts.setDigits(next);
    const nextEmpty = next.findIndex((v, i2) => i2 > idx && v == null);
    opts.setFocusIndex(nextEmpty >= 0 ? nextEmpty : Math.min(idx + 1, opts.len - 1));
    renderCells();
  };
  const pad = el('div', 'numpad');
  for (let n = 1; n <= 9; n++) {
    const b = el('button', 'numkey', String(n));
    b.onclick = () => appendDigit(n);
    pad.appendChild(b);
  }
  const back = el('button', 'numkey numkeyFn', '⌫');
  back.onclick = () => {
    const cur = opts.digits().slice();
    const idx = opts.focusIndex();
    if (cur[idx] != null) { cur[idx] = null; opts.setDigits(cur); }
    else {
      const prevIdx = Math.max(0, idx - 1);
      cur[prevIdx] = null;
      opts.setDigits(cur);
      opts.setFocusIndex(prevIdx);
    }
    renderCells();
  };
  pad.appendChild(back);
  const zero = el('button', 'numkey', '0');
  zero.onclick = () => appendDigit(0);
  pad.appendChild(zero);
  const submit = el('button', 'numkey numkeyFn primary', opts.submitLabel || '제출');
  submit.onclick = () => {
    const cur = opts.digits();
    if (cur.some((v) => v == null)) { addLog('⚠ 모든 칸을 채워주세요.'); return; }
    const ok = opts.onSubmit(cur.slice());
    // 제출은 서버로 실제 시도를 보내는 진짜 상태 변화라서, 서버가 새 state를 내려주면 그때
    // 화면 전체가 자연히 다시 그려진다 — 여기서는 로컬 입력칸만 비워 다음 시도를 준비한다.
    if (ok !== false) { opts.setDigits(Array(opts.len).fill(null)); opts.setFocusIndex(0); renderCells(); }
  };
  pad.appendChild(submit);
  wrap.appendChild(pad);
  return wrap;
}

// 금고 시도 기록 한 줄 — 칸 자체를 스트라이크(초록)/볼(노랑)/미스(기본)로 물들여 표시한다.
function bankHistoryRow(h) {
  const row = el('div', 'digitCellsRow bankHistoryRow');
  h.guess.forEach((d, i) => {
    const mark = (h.marks && h.marks[i]) || 'X';
    const cls = mark === 'S' ? 'strike' : mark === 'B' ? 'ball' : 'miss';
    row.appendChild(el('div', 'digitCell result ' + cls, String(d)));
  });
  return row;
}

// 폭탄 눈치 넘기기 — 남은 시간을 00:00.00(분:초.센티초) 형식으로 표시.
function formatCountdownClock(ms) {
  const clamped = Math.max(0, ms);
  const totalCenti = Math.floor(clamped / 10);
  const mm = Math.floor(totalCenti / 6000);
  const ss = Math.floor((totalCenti % 6000) / 100);
  const cc = totalCenti % 100;
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(mm)}:${pad2(ss)}.${pad2(cc)}`;
}
// 남은 시간이 10초 이하로 들어가면 정확히 몇 초 남았는지 감춘다 — "정확히 언제 터질지 모른다"는
// 긴장감을 주기 위해, 시계 숫자 대신 흔들리는 경고 문구만 보여준다.
function bombTimerText(ms) {
  if (ms > 0 && ms <= 10000) return '💣 곧 터집니다...';
  return formatCountdownClock(ms);
}
function tickBombTimer() {
  if (!lastState || lastState.phase !== 'ROUND_MINIGAME' || !lastState.minigame || lastState.minigame.type !== 'BOMB') { bombTicking = false; return; }
  const timerEl = document.getElementById('bombTimer');
  const remaining = lastState.minigame.public.expiresAt - Date.now();
  if (timerEl) {
    timerEl.textContent = bombTimerText(remaining);
    timerEl.classList.toggle('bombHidden', remaining <= 10000 && remaining > 0);
    // 남은시간 5초 이하 — 위험구간 펄스로 긴장감을 끌어올린다.
    timerEl.classList.toggle('bombDanger', remaining <= 5000 && remaining > 0);
  }
  requestAnimationFrame(tickBombTimer);
}
// "장고 금지" 공통 타이머 — REFLEX/BOMB을 제외한 나머지 미니게임 타입 전부가 mg.deadlineAt을
// 내려주므로, 종류에 상관없이 같은 배지 하나로 남은 시간을 보여준다. 시간이 다 되면 결정하지
// 않은 쪽이 그 자리에서 즉시 패배(또는 양쪽 다 안 했으면 무승부) 처리되므로, 여기서는 그냥
// 숫자만 보여주면 된다(0 밑으로는 내려가지 않게).
let decisionTicking = false;
function tickDecisionTimer() {
  const mg = lastState && lastState.minigame && lastState.minigame.public;
  if (!lastState || lastState.phase !== 'ROUND_MINIGAME' || !mg || !mg.deadlineAt) { decisionTicking = false; return; }
  const timerEl = document.getElementById('decisionTimer');
  const remaining = mg.deadlineAt - Date.now();
  if (timerEl) {
    timerEl.textContent = `⏱ ${Math.max(0, Math.ceil(remaining / 1000))}초`;
    timerEl.classList.toggle('timerLow', remaining <= 5000 && remaining > 0);
  }
  requestAnimationFrame(tickDecisionTimer);
}
// 본행동(칸 열기) "장고 금지" 타이머 — ROUND_ACTION 동안 계속 보여준다. 시간이 다 되면 서버가
// 아직 다 안 연 사람의 나머지 칸을 대신 무작위로 열어준다(armActionTimer).
let actionTimerTicking = false;
function tickActionTimer() {
  if (!lastState || lastState.phase !== 'ROUND_ACTION' || !lastState.actionDeadlineAt) { actionTimerTicking = false; return; }
  const timerEl = document.getElementById('actionTimer');
  const remaining = lastState.actionDeadlineAt - Date.now();
  if (timerEl) {
    timerEl.textContent = `⏱ ${Math.max(0, Math.ceil(remaining / 1000))}초`;
    timerEl.classList.toggle('timerLow', remaining <= 8000 && remaining > 0);
  }
  requestAnimationFrame(tickActionTimer);
}

// 주사위 누르기 — 누르고 있는 동안 장식용 눈을 실시간으로 계속 바꿔 보여준다(실제 결과는 서버가
// 뗀 시점의 진짜 경과시간으로 판정하므로, 이 화면은 순전히 보여주기용이다). 키보드(스페이스바)와
// 화면의 버튼 둘 다 이 두 함수를 공유해서 호출한다 — 상태가 서로 어긋나지 않도록.
function startDiceHold() {
  if (diceHeld) return;
  if (!lastState || lastState.phase !== 'ROUND_MINIGAME' || !lastState.minigame || lastState.minigame.type !== 'DICE') return;
  const mg = lastState.minigame.public;
  if (!mg || mg.myResult != null) return;
  diceHeld = true;
  diceHoldStartedAt = Date.now();
  socket.emit('minigame:move', { action: 'PRESS' });
  const btn = document.getElementById('diceHoldBtn');
  if (btn) { btn.classList.add('held'); btn.textContent = '누르는 중... 떼면 확정!'; }
  if (!diceFaceTicking) { diceFaceTicking = true; requestAnimationFrame(tickDiceFace); }
}
function releaseDiceHold() {
  if (!diceHeld) return;
  diceHeld = false;
  socket.emit('minigame:move', { action: 'RELEASE' });
  const btn = document.getElementById('diceHoldBtn');
  if (btn) { btn.classList.remove('held'); btn.textContent = '꾹 눌러서 굴리기 (스페이스바 가능)'; }
}
function tickDiceFace() {
  if (!diceHeld) { diceFaceTicking = false; return; }
  const cycleMs = (lastState && lastState.config && lastState.config.DICE_CYCLE_MS) || 220;
  const elapsed = Date.now() - diceHoldStartedAt;
  diceFace = 1 + Math.floor(elapsed / cycleMs) % 6;
  const holder = document.getElementById('diceFaceHolder');
  if (holder) holder.innerHTML = diceFaceSVG(diceFace, 'spinning');
  requestAnimationFrame(tickDiceFace);
}

// 방금 끝난 미니게임의 승패(+ 와인잔 개수처럼 실제 정답이 궁금한 경우 정답 공개)를 ROUND_ACTION
// 동안 잠깐 보여주는 패널. match.minigame은 다음 라운드 카운트다운이 시작되기 전까지 서버에
// 그대로 남아있으므로, 그 값을 그대로 읽어서 보여주면 된다.
function renderLastMinigameRecap(state) {
  const mg = state.minigame;
  if (!mg || !mg.result) return null;
  const p = el('div', 'panel mgRecapPanel');
  const label = mg.result === 'me' ? '🏆 미니게임 승리!' : mg.result === 'opp' ? '😵 미니게임 패배' : '🤝 무승부 — 이번 라운드는 보상 없음';
  p.appendChild(el('h2', null, `지난 미니게임: ${mg.name}`));
  p.appendChild(el('div', 'desc', label));
  if (mg.type === 'GUESS_COUNT' && mg.public) {
    const { trueCount, myGuess, oppGuess } = mg.public;
    p.appendChild(el('div', 'hint',
      `실제 와인잔 개수: <b>${trueCount}개</b> · 내 추측: ${myGuess ?? '-'}개${oppGuess != null ? ` · 상대 추측: ${oppGuess}개` : ''}`));
  }
  if (mg.type === 'PIN' && mg.public && mg.public.bombIndex != null) {
    p.appendChild(el('div', 'hint', `폭탄은 <b>${mg.public.bombIndex + 1}번째</b> 안전핀이었습니다.`));
  }
  return p;
}

// 상단 정중앙 점수판 — 내 점수·상대 점수를 항상 실시간으로 보여준다. 로비(아직 me가 없는 상태)
// 에서는 표시할 점수가 없으므로 비워둔다.
// [2026-10-01] "암살 긴장감을 더 줘야 한다" — 점수가 벌어져 있으면 안심하고 쫄리지 않는다는
// 피드백으로, 점수 차가 좁을 때(TENSE_SCORE_GAP 이하)는 점수판 자체가 붉게 박동하도록 긴장
// 신호를 추가했다. 양쪽 다 긴장할 만큼 가까우면 같은 신호를 둘 다에게 보여준다.
const TENSE_SCORE_GAP = 3;
function renderScoreBar(state) {
  if (!scoreBar) return;
  if (!state.me) { scoreBar.innerHTML = ''; scoreBar.classList.remove('tense'); return; }
  const myScore = state.me.score ?? 0;
  const oppScore = state.opp && state.opp.score != null ? state.opp.score : 0;
  scoreBar.innerHTML = `
    <span class="scLabel">나</span><span class="scNum mine">${myScore}</span>
    <span class="scSep">:</span>
    <span class="scNum opp">${oppScore}</span><span class="scLabel">상대</span>
  `;
  scoreBar.classList.toggle('tense', Math.abs(myScore - oppScore) <= TENSE_SCORE_GAP);
}

// 독배를 마시는 순간의 리빌 연출 — 서버의 'drama' 이벤트('popup'과 별개)를 받아, 화면 전체가
// 짧게 번쩍이고 흔들리게 한다. 마신 사람 본인(self)은 더 강하게, 지켜보는 상대(opp)는 더
// 약하게 — "내가 암살당했다"와 "상대가 뭔가 마셨다"는 체감이 달라야 한다는 설계 의도.
function triggerPoisonDrama(role) {
  document.body.classList.remove('poisonFlashSelf', 'poisonFlashOpp');
  // 같은 클래스를 바로 다시 붙여도 CSS 애니메이션이 재생되도록 한 프레임 쉬고 붙인다.
  requestAnimationFrame(() => {
    document.body.classList.add(role === 'self' ? 'poisonFlashSelf' : 'poisonFlashOpp');
    setTimeout(() => document.body.classList.remove('poisonFlashSelf', 'poisonFlashOpp'), 650);
  });
}
socket.on('drama', ({ kind, role }) => { if (kind === 'POISON') triggerPoisonDrama(role); });

function render(state) {
  if (!state) return;
  renderStatusBar(state);
  renderScoreBar(state);
  const phaseChanged = state.phase !== lastRenderedPhase;
  if (phaseChanged) {
    lastRenderedPhase = state.phase;
    app.scrollTop = 0;
    // 일부 브라우저의 스크롤 앵커링이 방금 되돌린 scrollTop을 다음 레이아웃에서 다시 덮어쓰는
    // 경우를 대비해(위 #app의 overflow-anchor:none이 주 방어, 이건 이중 안전장치), 새 내용이
    // 실제로 그려지고 난 다음 프레임에 한 번 더 맨 위로 되돌린다.
    requestAnimationFrame(() => { app.scrollTop = 0; });
  }
  app.innerHTML = '';
  if (state.phase === 'LOBBY') return renderLobby(state);
  if (state.phase === 'SETUP_DONE') return renderSetupDone(state);
  if (state.phase === 'MID_SETUP_DONE') return renderMidSetupDone(state);
  if (state.phase === 'ROUND_DONE') return renderRoundDone(state);
  if (state.phase === 'ROUND_COUNTDOWN') return renderCountdown(state);
  if (state.phase === 'END') return renderEnd(state);
  // "고르기" 화면(APP_ROLE === 'pick')은 4대 분리 모드 전용 — 이 화면이 담당하는 건 오직
  // "라운드 중 6×6 처소 칸 열기"뿐이다. SETUP/MID_SETUP(독 설치)과 미니게임은 여전히 "게임"
  // 화면에서 진행하므로, 그 단계들에서는 안내 문구만 보여주고 실제 UI는 게임 화면 쪽에만 그린다.
  if (APP_ROLE === 'pick') {
    if (state.phase === 'SETUP') return renderPickWaiting('🧪 독 설치는 게임 화면에서 진행합니다.');
    if (state.phase === 'MID_SETUP') return renderPickWaiting('🧪 중반 독 추가 설치는 게임 화면에서 진행합니다.');
    if (state.phase === 'ROUND_MINIGAME') return renderPickWaiting('🎲 미니게임이 게임 화면에서 진행 중입니다...');
    if (state.phase === 'ROUND_ACTION') return renderPickView(state);
    return renderPickWaiting('대기 중...');
  }
  if (state.phase === 'SETUP') return renderSetup(state);
  if (state.phase === 'MID_SETUP') return renderMidSetup(state);
  return renderMain(state);
}

// ---------------------------- 셋업 완료 안내(SETUP_DONE) ----------------------------
// "독배 설치를 끝내자마자 바로 게임으로 넘어가서 상황 인지가 어렵다"는 피드백 — 설치가 끝났다는
// 걸 잠깐 보여준 뒤(숫자 카운트다운 없이, 완료 메시지만) 원래 있던 1라운드 3-2-1 카운트다운으로
// 넘어간다. 정확히 몇 초 남았는지는 보여주지 않고, 그냥 곧 시작한다는 것만 알려준다.
function renderSetupDone(state) {
  const p = el('section', 'panel center countdownPanel');
  p.appendChild(el('h2', null, '🍷 양쪽 모두 독배 설치를 완료했습니다'));
  p.appendChild(el('p', 'hint', '잠시 후 본게임이 시작됩니다 — 마음의 준비를 하세요!'));
  app.appendChild(p);
}

// 매 라운드 양쪽 다 칸을 다 연 직후에도 SETUP_DONE과 같은 이유로 같은 방식의 완료 안내를 보여준다 —
// "칸을 열자마자 바로 다음 라운드로 넘어가서 상황 인지가 어렵다"는 피드백. 여기서 한 발 더 나아가,
// 방금 이번 라운드에 내가 연 칸이 각각 뭐였는지(문장/보석/독/해독제/빈칸)를 5초 동안 직접 보여줘서
// "마지막 선택 후 그게 뭔지 확인할 시간 없이 바로 다음으로 넘어간다"는 문제를 해결한다.
function renderRoundDone(state) {
  const p = el('section', 'panel center countdownPanel');
  p.appendChild(el('h2', null, `✅ ${state.round} / ${state.roundsTotal} 라운드 종료`));
  const summary = roundOpenSummaryRound === state.round ? roundOpenSummary : [];
  if (summary.length) {
    p.appendChild(el('p', 'hint', '이번 라운드에 내가 연 칸:'));
    const row = el('div', 'roundOpenSummaryRow');
    summary.forEach(({ row: r, col: c, type, gemId, gemPiece }) => {
      const item = el('div', 'roundOpenSummaryItem');
      const icon = el('div', 'roundOpenSummaryIcon' + (type === 'E' ? '' : ' cellIcon-' + type));
      icon.innerHTML = cellVisualHTML(type, gemPiece, gemId != null ? gemId : r * 6 + c);
      item.appendChild(icon);
      item.appendChild(el('div', 'roundOpenSummaryLabel', `(${r + 1},${c + 1}) ${type === 'E' ? '빈 칸' : CELL_NAME[type]}`));
      row.appendChild(item);
    });
    p.appendChild(row);
  }
  p.appendChild(el('p', 'hint', '잠시 후 다음 라운드가 시작됩니다 — 마음의 준비를 하세요!'));
  app.appendChild(p);
}

// ---------------------------- 라운드 시작 전 3-2-1 카운트다운 ----------------------------
// "게임이 무지성으로 시작한다"는 피드백에 따라, 매 라운드 미니게임이 시작되기 직전에 3초짜리
// 카운트다운과 다음 미니게임 이름을 미리 보여준다. 서버는 countdownEndsAt(끝나는 시각) 한 번만
// 내려주고, 그 뒤로는 화면이 다시 그려지지 않으므로 클라이언트가 직접 매 프레임 남은 시간을 계산한다.
let countdownTicking = false;
function tickCountdown() {
  if (!lastState || lastState.phase !== 'ROUND_COUNTDOWN' || !lastState.countdownEndsAt) { countdownTicking = false; return; }
  const numEl = document.getElementById('countdownNum');
  if (numEl) {
    const remaining = lastState.countdownEndsAt - Date.now();
    numEl.textContent = String(Math.max(1, Math.ceil(remaining / 1000)));
  }
  requestAnimationFrame(tickCountdown);
}
function renderCountdown(state) {
  // 마지막 라운드는 "결전"이라는 걸 시각적으로 확실히 차별화한다 — 승부처라는 긴장감.
  const isFinal = state.round === state.roundsTotal;
  const p = el('section', 'panel center countdownPanel' + (isFinal ? ' finalRound' : ''));
  if (isFinal) p.appendChild(el('div', 'finalRoundBanner', '⚔ 마지막 라운드 — 결전'));
  p.appendChild(el('h2', null, `${state.round} / ${state.roundsTotal} 라운드 준비`));
  if (state.nextMinigameName) p.appendChild(el('div', 'countdownNext', `다음 미니게임: <b>${state.nextMinigameName}</b>`));
  const numEl = el('div', 'countdownNum', '3');
  numEl.id = 'countdownNum';
  p.appendChild(numEl);
  p.appendChild(el('p', 'hint', '마음의 준비를 하세요!'));
  app.appendChild(p);
  if (!countdownTicking) { countdownTicking = true; requestAnimationFrame(tickCountdown); }
}

// 섬광 정찰 보상 연출 — 옛날 예능의 "철가방(배달통)" 개그처럼, 뚜껑이 확 열렸다가 순식간에
// 다시 닫히는 느낌. "내 처소" 6×6 그리드가 있는 자리에 정확히 겹치는 오버레이로 뜬다 —
// 라벨/여백 없이 그리드 그 자체가 원래 칸들 위에 그대로 "덮어쓰기"되도록, 위치·크기를 원본
// 그리드와 동일하게 맞춘다. 시간이 지나면 사라져 원래 그리드가 다시 보인다.
function renderFlashOverlay(room) {
  const p = el('div', 'flashOverlay boxOpenAnim');
  const grid = el('div', 'grid6');
  for (let r = 0; r < room.length; r++) {
    for (let c = 0; c < room[r].length; c++) {
      grid.appendChild(el('div', 'cell opened ' + room[r][c], cellVisualHTML(room[r][c], 'SOLO', r * 6 + c)));
    }
  }
  p.appendChild(grid);
  return p;
}

function renderStatusBar(state) {
  // 미니게임 2연승 이상일 때만 배지를 띄운다 — 1승은 아직 "스트릭"이라 부를 정도가 아니라서.
  let streakHtml = '';
  if (state.streakOwner && state.streakCount >= 2) {
    streakHtml = state.streakOwner === 'me'
      ? `<span class="streakBadge mine">🔥 ${state.streakCount}연승</span>`
      : `<span class="streakBadge opp">⚠ 상대 ${state.streakCount}연승</span>`;
  }
  // 4대 분리 모드에서 지금 이 화면이 "게임"용인지 "고르기"용인지 한눈에 알 수 있도록 배지를 단다.
  const roleHtml = APP_ROLE ? `<span class="roleBadge">${APP_ROLE === 'game' ? '🎲 게임 화면' : '🚪 고르기 화면'} · ${APP_SLOT}</span>` : '';
  statusBar.innerHTML = `
    ${roleHtml}
    <span>나: <b>${state.me ? state.me.name : '-'}</b></span>
    <span>상대: <b>${state.opp ? state.opp.name : '대기 중'}</b></span>
    <span>라운드: <b>${state.round || 0} / ${state.roundsTotal || '-'}</b>${streakHtml}</span>
  `;
}

function renderLobby(state) {
  const p = el('section', 'panel center');
  p.appendChild(el('p', null, state.playersConnected < 2
    ? `플레이어 접속 대기 중... (${state.playersConnected}/2)<br/><span class="hint">두 대의 컴퓨터에서 같은 주소로 접속하세요.</span>`
    : '게임을 준비하고 있습니다...'));
  app.appendChild(p);
}

// ---------------------------- SETUP ----------------------------
// 전반은 6×ROWS_FIRST_HALF(기본 4줄 = 24칸)만 사용한다. 가문의 문장은 이 시점엔 아직 어디에도
// 배치되지 않은 상태다(독을 다 심은 뒤, 서버가 몰래 무작위로 5~6개를 흩뿌린다) — 그래서 이
// 화면에는 문장 표시가 전혀 없다. 몇 개가 어디에 들어갈지는 두 사람 모두, 심지어 본인조차 모른다.
function renderSetup(state) {
  const p = el('section', 'panel');
  // 설명이 너무 길어 읽기 부담스럽다는 피드백 — 제목/부연 설명 다 빼고 핵심 한 줄만 남긴다.
  p.appendChild(el('h2', null, `독을 심을 칸 ${state.config.POISON_INITIAL}개를 고르세요`));

  const already = state.setupDone.me;
  const grid = el('div', 'grid6');
  grid.style.gridTemplateRows = `repeat(${state.config.ROWS_FIRST_HALF}, 1fr)`;
  for (let r = 0; r < state.config.ROWS_FIRST_HALF; r++) {
    for (let c = 0; c < state.config.GRID; c++) {
      const cell = el('div', 'cell');
      const isSel = setupSelection.some((s) => s.row === r && s.col === c);
      if (isSel) cell.classList.add('selected');
      if (!already) {
        cell.classList.add('pickable');
        cell.onclick = () => {
          const idx = setupSelection.findIndex((s) => s.row === r && s.col === c);
          if (idx >= 0) setupSelection.splice(idx, 1);
          else if (setupSelection.length < state.config.POISON_INITIAL) setupSelection.push({ row: r, col: c });
          // 관리자 화면에서 실시간으로 "누가 어디를 찍고 있는지" 보이도록, 확정 전에도 매번 미리보기를 보낸다.
          socket.emit('setup:preview', { cells: setupSelection });
          render(lastState);
        };
      }
      cell.innerHTML = isSel ? selectionMarkSVG() : '';
      grid.appendChild(cell);
    }
  }
  p.appendChild(grid);

  const info = el('p', 'hint', `선택됨: ${setupSelection.length} / ${state.config.POISON_INITIAL}`);
  p.appendChild(info);

  if (!already) {
    const btn = el('button', 'action primary', '독 설치 확정');
    btn.disabled = setupSelection.length !== state.config.POISON_INITIAL;
    btn.onclick = () => socket.emit('setup:confirm', { cells: setupSelection });
    p.appendChild(btn);
  } else {
    p.appendChild(el('p', 'hint', '✅ 설치 완료. 상대방을 기다리는 중...'));
  }

  const statusP = el('p', 'hint', `나: ${state.setupDone.me ? '완료' : '진행 중'} · 상대: ${state.setupDone.opp ? '완료' : '진행 중'}`);
  p.appendChild(statusP);

  app.appendChild(p);
}

// ---------------------------- MID_SETUP (전반 종료 → 중반 독 추가 설치) ----------------------------
// 처소가 6×4에서 6×6으로 확장되는 시점 — 서로 상대 처소에서 "아직 안 연 칸" 중 2곳을 골라
// 추가로 독을 심는다. 이미 연 칸(내용이 드러난 칸)은 대상이 될 수 없으므로 회색으로 막아둔다.
function renderMidSetup(state) {
  const p = el('section', 'panel');
  p.appendChild(el('h2', null, '중반 재설치 — 처소가 6×6으로 확장됩니다'));
  p.appendChild(el('p', 'hint', `상대(${state.opp ? state.opp.name : '상대'})의 처소에서 아직 열리지 않았고 아무것도 없는 빈 칸 중 ${state.config.POISON_MID}곳을 골라 독을 추가로 몰래 심으세요. 회색 칸은 이미 열렸거나, 이미 보석·해독제·독이 자리잡고 있어 대상이 될 수 없습니다.`));

  // oppBlockedMask는 "이미 열렸거나 이미 뭔가(보석/해독제/독) 있는 칸"까지 함께 걸러준다.
  // 구버전 서버와의 호환을 위해 없으면 oppOpenedMask로 대체한다.
  const blockedMask = state.oppBlockedMask || state.oppOpenedMask || [];
  const already = state.midSetupDone && state.midSetupDone.me;
  const grid = el('div', 'grid6');
  for (let r = 0; r < state.config.ROWS_TOTAL; r++) {
    for (let c = 0; c < state.config.GRID; c++) {
      const cell = el('div', 'cell');
      const isBlocked = !!(blockedMask[r] && blockedMask[r][c]);
      const isSel = midSetupSelection.some((s) => s.row === r && s.col === c);
      if (isBlocked) cell.classList.add('blockedSpot');
      if (isSel) cell.classList.add('selected');
      if (!already && !isBlocked) {
        cell.classList.add('pickable');
        cell.onclick = () => {
          const idx = midSetupSelection.findIndex((s) => s.row === r && s.col === c);
          if (idx >= 0) midSetupSelection.splice(idx, 1);
          else if (midSetupSelection.length < state.config.POISON_MID) midSetupSelection.push({ row: r, col: c });
          render(lastState);
        };
      }
      cell.innerHTML = isSel ? selectionMarkSVG() : (isBlocked ? '<span class="emptyMark">✕</span>' : '');
      grid.appendChild(cell);
    }
  }
  p.appendChild(grid);

  const info = el('p', 'hint', `선택됨: ${midSetupSelection.length} / ${state.config.POISON_MID}`);
  p.appendChild(info);

  if (!already) {
    const btn = el('button', 'action primary', '중반 독 추가 설치 확정');
    btn.disabled = midSetupSelection.length !== state.config.POISON_MID;
    btn.onclick = () => socket.emit('mid_setup:confirm', { cells: midSetupSelection });
    p.appendChild(btn);
  } else {
    p.appendChild(el('p', 'hint', '✅ 설치 완료. 상대방을 기다리는 중...'));
  }

  const statusP = el('p', 'hint', `나: ${state.midSetupDone && state.midSetupDone.me ? '완료' : '진행 중'} · 상대: ${state.midSetupDone && state.midSetupDone.opp ? '완료' : '진행 중'}`);
  p.appendChild(statusP);

  app.appendChild(p);
}

// 중반 재설치(독 추가 + 처소 확장) 완료 안내 — SETUP_DONE/ROUND_DONE과 같은 패턴.
function renderMidSetupDone(state) {
  const p = el('section', 'panel center countdownPanel');
  p.appendChild(el('h2', null, '🏰 처소가 6×6으로 확장되었습니다'));
  p.appendChild(el('p', 'hint', '잠시 후 후반전이 시작됩니다 — 마음의 준비를 하세요!'));
  app.appendChild(p);
}

// ---------------------------- MAIN (미니게임 + 액션) ----------------------------
// "게임 화면"(미니게임/본행동/보상)과 "6×6 화면"(내 처소)이 한 화면에 좌우로 같이 떠 있으면
// 복잡하다는 피드백에 따라, 탭으로 오가며 한 번에 하나만 보도록 분리했다. 통계 패널만은
// 두 화면 어디서든 자주 확인하고 싶은 요약 정보라 탭 밖에 항상 고정해 둔다.
function renderMain(state) {
  // 페이즈가 "바뀌는 순간"에만 자동으로 알맞은 탭으로 전환한다 — 매번 다시 그릴 때마다
  // 강제로 되돌리면 플레이어가 일부러 다른 탭을 보고 있어도 자꾸 튕겨나가 버리기 때문에,
  // phase 전환 자체를 감지했을 때만 한 번 전환한다. 미니게임은 이제 탭과 무관하게 화면 위에
  // 팝업으로 뜨므로, ROUND_ACTION으로 넘어갈 때만 "내 처소" 탭으로 자동 전환하면 충분하다.
  if (state.phase !== lastPhaseForTab) {
    lastPhaseForTab = state.phase;
    if (state.phase === 'ROUND_ACTION') activeTab = 'ROOM';
  }

  // "내 차례/상대 차례" 텍스트만으로는 눈에 잘 안 띈다는 피드백 — 실제로 열 수 있는 차례일
  // 때는 게임 박스 테두리 전체가 은은하게 빛나도록 해서 누가 봐도 확실히 알아채게 한다.
  const wrap = el('div', 'mainView' + (activeTab === 'ROOM' ? ' wide' : '') + (state.isMyTurn ? ' myTurnGlow' : ''));
  wrap.appendChild(renderStatsPanel(state));
  wrap.appendChild(renderTabBar(state));

  // 보상(=내 처소를 들여다보는 정찰) 관련 패널은 더 이상 이 자리(탭 위쪽)에 띄우지 않는다 —
  // 갑자기 나타났다 사라지며 화면 높이가 출렁이던 문제 때문에, 이제 "내 처소" 탭 안 처소
  // 그리드 오른쪽 칸에 고정해서 보여준다(renderMyRoomPanel 참고). 4대 분리 모드의 "게임"
  // 화면에서는 애초에 각 처소 상황을 전혀 안 보여주므로(전부 "고르기" 화면 몫) 그대로 없다.
  const recap = state.phase === 'ROUND_ACTION' ? renderLastMinigameRecap(state) : null;
  if (recap) wrap.appendChild(recap);

  if (activeTab === 'ROOM') {
    wrap.appendChild(renderMyRoomPanel(state));
  } else {
    if (state.phase === 'ROUND_ACTION') wrap.appendChild(renderActionPanel(state));
  }

  app.appendChild(wrap);

  // "미니게임은 팝업처럼 열리도록" — 어느 탭을 보고 있든 놓치지 않도록, 화면 전체를 덮는
  // 모달로 띄운다. 탭 안쪽 내용과는 별개로 항상 최상단에 뜬다.
  if (state.phase === 'ROUND_MINIGAME' && state.minigame) {
    const modal = renderMinigameModal(state);
    // 직전 프레임에도 모달이 열려 있었다면(예: 상대가 방금 움직여서 다시 그려진 것뿐이라면)
    // 등장 애니메이션을 또 재생하지 않는다 — 진짜로 "새로 열릴 때"만 팝인/페이드인을 보여준다.
    if (modalOpenPrev) modal.classList.add('modalNoAnim');
    app.appendChild(modal);
    modalOpenPrev = true;
  } else {
    modalOpenPrev = false;
  }
}

function renderMinigameModal(state) {
  const overlay = el('div', 'modalOverlay');
  const box = el('div', 'modalBox');
  box.appendChild(renderMinigamePanel(state));
  overlay.appendChild(box);
  return overlay;
}

function renderTabBar(state) {
  const bar = el('div', 'tabBar');
  // 지금 당장 뭔가 할 일이 있는데 다른 탭을 보고 있으면 놓치기 쉬우므로, 그럴 때만 점 표시를 띄운다.
  // 미니게임 팝업과 보상 선택/사용/리캡 패널은 이제 탭과 무관하게 항상 보이므로, 여기서는
  // "내 처소" 탭에서만 할 수 있는 칸 열기만 체크하면 된다.
  const needsRoom = state.phase === 'ROUND_ACTION' && state.isMyTurn && state.opensRemaining > 0;

  const gameBtn = el('button', 'tabBtn' + (activeTab === 'GAME' ? ' active' : ''), '🎲 미니게임 · 행동');
  gameBtn.onclick = () => { activeTab = 'GAME'; render(lastState); };
  bar.appendChild(gameBtn);

  const roomBtn = el('button', 'tabBtn' + (activeTab === 'ROOM' ? ' active' : ''),
    `🚪 내 처소 (${roomDimsLabel(state)})` + (needsRoom && activeTab !== 'ROOM' ? '<span class="tabDot"></span>' : ''));
  roomBtn.onclick = () => { activeTab = 'ROOM'; render(lastState); };
  bar.appendChild(roomBtn);

  return bar;
}

// 보상 선택/사용/결과 패널 + "상대가 고르는 중" 안내를 한데 모아 붙이는 헬퍼.
// 레거시(단일 화면) 모드와 4대 분리 모드의 "고르기" 화면이 공유해서 쓴다 — "내 처소를
// 들여다보는" 행위는 전부 이 화면들에서만 이뤄지고, 4대 분리 모드의 "게임" 화면에는 아예
// 나타나지 않는다.
function appendRewardPanels(wrap, state) {
  // 보상 선택/사용은 "내 처소" 관련 진행 상황이 곧장 보여야 하므로, 탭 전환과 무관하게 항상 노출한다.
  if (state.phase === 'ROUND_ACTION' && state.myReward && !state.myReward.type) wrap.appendChild(renderRewardChoicePanel(state));
  if (state.phase === 'ROUND_ACTION' && state.myReward && state.myReward.type && !state.myReward.used) wrap.appendChild(renderRewardPanel(state));
  if (state.phase === 'ROUND_ACTION' && state.oppChoosingReward) wrap.appendChild(el('div', 'panel hint', '⚠ 상대가 미니게임에서 이겨 보상을 고르는 중입니다...'));
  // 보상(정찰)으로 무엇을 알아냈는지는 숨겨진 #log에만 남던 것을 화면에 계속 보이게 한다.
  if (lastRewardResult && lastRewardResultRound === state.round) wrap.appendChild(renderRewardResultPanel());
}

// 미니게임 승자에게 보상 후보 중 하나를 직접 고르게 하는 패널.
function renderRewardChoicePanel(state) {
  const p = el('div', 'panel rewardBanner');
  p.appendChild(el('h2', null, '🎁 보상을 고르세요'));
  p.appendChild(el('div', 'hint', '미니게임에서 승리했습니다 — 아래 후보 중 하나를 고르면 바로 적용됩니다.'));
  const list = el('div', 'rewardChoiceList');
  (state.myReward.choices || []).forEach((c) => {
    const label = c.usesLeft != null ? `${c.name} (${c.usesLeft}번 남음)` : c.name;
    const b = el('button', 'rewardChoiceBtn', label);
    b.onclick = () => socket.emit('reward:choose', { type: c.type });
    list.appendChild(b);
  });
  p.appendChild(list);
  return p;
}

// 보상(정찰)으로 획득한 정보를 라운드가 끝날 때까지 계속 보이게 하는 패널.
function renderRewardResultPanel() {
  const p = el('div', 'panel rewardResultPanel');
  p.appendChild(el('h2', null, '🔎 정찰 결과'));
  p.appendChild(el('div', 'desc', lastRewardResult));
  return p;
}

function renderHistoryPanel(state) {
  const p = el('div', 'panel historyPanel');
  p.appendChild(el('h2', null, '내 행동 기록'));
  const hist = state.me.history || [];
  if (hist.length === 0) {
    p.appendChild(el('p', 'hint', '아직 이번 판에서 한 행동이 없습니다. 상대방은 이 기록을 볼 수 없습니다.'));
    return p;
  }
  const list = el('div', 'historyList');
  hist.slice().reverse().forEach((h) => {
    list.appendChild(el('div', 'historyItem', h.msg));
  });
  p.appendChild(list);
  return p;
}

function renderStatsPanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, '상태'));
  const wrap = el('div', 'cols');

  const mine = el('div', 'col');
  mine.appendChild(el('h3', null, `내 처소 (${state.me.name})`));
  mine.appendChild(statGrid(state.me, state.config));
  wrap.appendChild(mine);

  // 상대의 독/해독제 현황(그리고 이 패널의 세부 점수 내역)은 게임이 끝나기 전까지 비공개 —
  // 서로의 패를 못 보게 하는 것이 이 게임의 핵심 재미이므로, 세부 내용은 실시간으로 보여주지
  // 않는다(최종 결과 화면에서만 공개). 단, 점수 "총점"만은 상단 점수판에 예외적으로 실시간 노출된다.
  if (state.opp) {
    const opp = el('div', 'col');
    opp.appendChild(el('h3', null, `상대 (${state.opp.name}) ${state.opp.connected ? '' : '<span class="hint">(연결 끊김)</span>'}`));
    opp.appendChild(el('p', 'hint', '상대의 점수·독·해독제 현황은 게임이 끝날 때까지 비공개입니다.'));
    wrap.appendChild(opp);
  }
  p.appendChild(wrap);
  return p;
}

// END 화면에서만 쓰는, 1차/2차 독 감점 내역을 풀어 보여주는 문구 — 게임 중에는 poisonInitial/
// poisonMid 자체가 서버에서 null로 내려오므로(END에서만 채워짐) 자연히 이 함수도 END에서만 호출된다.
function poisonBreakdownText(p, config) {
  if (p.poisonInitial == null || p.poisonMid == null) {
    return `술잔 점수 ${p.score} − 독 ${p.poison}개`;
  }
  const initPenalty = p.poisonInitial * config.POISON_PENALTY;
  const midPenalty = p.poisonMid * config.POISON_PENALTY_MID;
  return `술잔 점수 ${p.score} − 1차 독 ${p.poisonInitial}개×${config.POISON_PENALTY}(-${initPenalty}) − 2차 독 ${p.poisonMid}개×${config.POISON_PENALTY_MID}(-${midPenalty})`;
}

function statGrid(p, config) {
  const g = el('div', 'statgrid');
  // 독이 2개 이상 쌓이면 위험하다는 긴장감을 시각적으로 준다. 1차/2차 독의 정확한 감점 액수는
  // 서로 달라서(2차가 더 아픔) 게임이 끝나야 공개되므로, 여기서는 구체적 숫자 없이 뭉뚱그려 표시한다.
  g.appendChild(statBox('poison', p.poison, '독 (종료 시 감점 — 2차 독이 더 아픔)', p.poison >= 2));
  g.appendChild(statBox('antidote', p.antidote, '해독제'));
  g.appendChild(statBox('score', p.score, '점수'));
  if (p.gemsFound != null) {
    const total = (config && config.GEM_PIECES_TOTAL) || p.gemsTotal || '?';
    g.appendChild(statBox('gem', `${p.gemsFound} / ${total}`, '보석 조각'));
  }
  if (p.gemsCompleted != null) {
    g.appendChild(statBox('gemSet', p.gemsCompleted, '완성한 보석'));
  }
  return g;
}
function statBox(cls, v, label, danger) {
  const d = el('div', 'stat ' + cls + (danger ? ' dangerPulse' : ''));
  d.appendChild(el('div', 'v', v));
  d.appendChild(el('div', 'l', label));
  return d;
}

// 전반(6×4)인지 후반(6×6)인지 화면 라벨용으로 판별한다 — state.me.room의 후반 전용 줄이
// 아직 잠겨 있으면 전반, 아니면 후반으로 본다.
function roomDimsLabel(state) {
  const room = state && state.me && state.me.room;
  const cfg = state && state.config;
  if (!room || !cfg) return '6×6';
  const firstLockedRow = room[cfg.ROWS_FIRST_HALF];
  const stillFirstHalf = firstLockedRow && firstLockedRow[0] && firstLockedRow[0].locked;
  return stillFirstHalf ? `6×${cfg.ROWS_FIRST_HALF}` : `6×${cfg.ROWS_TOTAL}`;
}

// 6×6 그리드 하나를 그린다 — "내 처소"(게임 화면·고르기 화면 모두)와 고르기 화면의
// "상대 처소"(보기 전용) 양쪽에서 재사용하는 공용 빌더.
// opts.pickMode: 안 연 칸을 클릭 가능하게 할지. opts.onOpen(row,col): 클릭 시 호출.
// opts.flashRoom: 섬광 정찰(철가방) 오버레이용 배열(내 처소에서만 쓰임).
function buildRoomGrid(room, opts) {
  opts = opts || {};
  const gridHolder = el('div', 'roomGridHolder');
  const grid = el('div', 'grid6');
  for (let r = 0; r < room.length; r++) {
    for (let c = 0; c < room[r].length; c++) {
      const data = room[r][c];
      const cell = el('div', 'cell');
      if (data.locked) {
        // 후반에야 열리는 줄 — 전반 동안은 존재 자체를 아직 알 수 없는 잠긴 구역으로 표시한다.
        cell.classList.add('lockedSpot');
        cell.innerHTML = '<span class="lockedMark">🔒</span>';
      } else if (data.opened) {
        cell.classList.add('opened', data.type);
        // 빈 칸(E)도 이제 금잔/은잔 이미지로 "이미 열어봤음"을 보여준다(칸 좌표로 변형 고정).
        cell.innerHTML = cellVisualHTML(data.type, data.gemPiece, data.gemId != null ? data.gemId : r * 6 + c);
      } else if (opts.peekCell && opts.peekCell.row === r && opts.peekCell.col === c) {
        // 한 칸 정찰 보상: 실제로 연 것은 아니지만, 잠깐 불이 들어와 정체가 보였다가 저절로
        // 꺼지는 느낌을 준다 — CSS 애니메이션이 밝게 켜진 상태에서 원래의 어두운 모습으로 페이드된다.
        cell.classList.add('peekLit', opts.peekCell.type);
        cell.innerHTML = cellVisualHTML(opts.peekCell.type, 'SOLO', r * 6 + c);
      } else {
        cell.textContent = '';
      }
      if (opts.pickMode && !data.opened && !data.locked) {
        cell.classList.add('pickable');
        cell.onclick = () => opts.onOpen(r, c);
      }
      grid.appendChild(cell);
    }
  }
  gridHolder.appendChild(grid);
  if (opts.flashRoom) gridHolder.appendChild(renderFlashOverlay(opts.flashRoom));
  return gridHolder;
}

function renderMyRoomPanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, `내 처소 (${roomDimsLabel(state)})`));
  // 4대 분리 모드의 "게임" 화면에서는 각 처소의 실제 상황(그리드·보상 결과 등)을 전혀
  // 보여주지 않는다 — 전부 "고르기" 화면에서만 확인·진행한다.
  if (APP_ROLE === 'game') {
    p.appendChild(el('p', 'hint', '👉 칸 열기와 보상(정찰) 확인은 모두 "고르기" 화면에서 진행하세요.'));
    return p;
  }
  if (state.actionDeadlineAt) {
    const t = el('span', 'actionTimerBadge');
    t.id = 'actionTimer';
    p.appendChild(t);
    if (!actionTimerTicking) { actionTimerTicking = true; requestAnimationFrame(tickActionTimer); }
  }
  // 섬광 정찰(FLASH_ALL)을 골랐다면 실제로 번쩍이는 순간을 먼저 겪어야 칸을 열 수 있다 —
  // 서버도 doAction()에서 똑같이 막지만, 클릭해도 안 먹히는 것처럼 보이지 않도록 미리 잠근다.
  const waitingForFlash = !!(state.myReward && state.myReward.type === 'FLASH_ALL' && !state.myReward.used);
  const pickMode = state.isMyTurn && state.opensRemaining > 0 && !waitingForFlash;

  // 처소 그리드(왼쪽)는 항상 고정된 자리를 지키고, 보상 패널·보석 현황은 오른쪽 칸에 모아둔다 —
  // 보상 패널이 위쪽에 갑자기 나타났다 사라지며 화면 높이가 출렁이는 문제를 막기 위함.
  const split = el('div', 'roomCrestSplit');

  const left = el('div', 'roomCrestLeft');
  left.appendChild(buildRoomGrid(state.me.room, { pickMode, onOpen: (r, c) => socket.emit('action:open', { row: r, col: c }), flashRoom, peekCell }));
  if (pickMode) left.appendChild(el('p', 'hint', `열고 싶은 칸을 클릭하세요. (이번 턴에 ${state.opensRemaining}개 더 열 수 있습니다)`));
  else if (waitingForFlash) left.appendChild(el('p', 'hint', '🍱 스페이스바를 누르면 그 자리에서 바로 철가방이 열립니다 — 번쩍인 뒤에 칸을 열 수 있습니다.'));
  split.appendChild(left);

  const right = el('div', 'roomCrestRight');
  appendRewardPanels(right, state);
  const gemWidget = gemStatusWidget(state);
  if (gemWidget) right.appendChild(gemWidget);
  if (right.children.length) split.appendChild(right);

  p.appendChild(split);
  return p;
}

// ---------------------------- 고르기 화면(APP_ROLE === 'pick') ----------------------------
// 4대 분리 모드 전용 — "내 처소"와 관련된 모든 것(칸 열기 + 보상 선택/사용/결과)을 이 화면
// 하나에서 담당한다. 상대 처소는 보여주지 않는다 — 서로 무엇을 골랐는지는 컴퓨터를 마주보게
// 배치해 직접 보도록 한 물리적 배치의 몫으로 남겨둔다(소프트웨어로 합쳐 보여주지 않는다).
function renderPickWaiting(msg) {
  const p = el('section', 'panel center');
  p.appendChild(el('p', 'hint', msg));
  app.appendChild(p);
}

function renderPickView(state) {
  const waitingForFlash = !!(state.myReward && state.myReward.type === 'FLASH_ALL' && !state.myReward.used);
  const pickMode = state.isMyTurn && state.opensRemaining > 0 && !waitingForFlash;
  // "고르기" 화면도 실제로 칸을 여는 화면이므로, 내 차례일 때 게임 박스가 빛나야 하는 건 여기도 동일.
  const wrap = el('div', 'mainView wide' + (state.isMyTurn ? ' myTurnGlow' : ''));

  const mine = el('div', 'panel');
  mine.appendChild(el('h2', null, `내 처소 (${state.me.name})`));
  if (state.actionDeadlineAt) {
    const t = el('span', 'actionTimerBadge');
    t.id = 'actionTimer';
    mine.appendChild(t);
    if (!actionTimerTicking) { actionTimerTicking = true; requestAnimationFrame(tickActionTimer); }
  }

  // 처소 그리드(왼쪽)는 항상 고정된 자리를 지키고, 보상 패널·보석 현황은 전부 오른쪽 칸에
  // 모아둔다 — 예전에는 보상 패널이 처소 위쪽에 갑자기 나타났다 사라지면서 화면 전체 높이가
  // 출렁여 스크롤이 위아래로 튀는 문제가 있었다("갑자기 위로 올라가서 불편하다"는 피드백).
  // 오른쪽 칸의 내용물이 늘고 줄어도 왼쪽 처소 그리드의 위치는 흔들리지 않는다.
  const split = el('div', 'roomCrestSplit');

  const left = el('div', 'roomCrestLeft');
  left.appendChild(buildRoomGrid(state.me.room, { pickMode, onOpen: (r, c) => socket.emit('action:open', { row: r, col: c }), flashRoom, peekCell }));
  if (pickMode) left.appendChild(el('p', 'hint', `열고 싶은 칸을 클릭하세요. (이번 턴에 ${state.opensRemaining}개 더 열 수 있습니다)`));
  else if (waitingForFlash) left.appendChild(el('p', 'hint', '🍱 스페이스바를 누르면 그 자리에서 바로 철가방이 열립니다.'));
  else if (!state.isMyTurn) {
    // [2026-10-01] "둘 다 칸 열기를 마쳐도 문장 퍼즐 시간이 남았으면 화면이 안 바뀌었으면 해" —
    // 이제 둘 다 마쳐도 곧바로 다음 라운드로 넘어가지 않고, 본행동 타이머(=문장 퍼즐 타이머)가
    // 다 될 때까지 이 화면 그대로 유지된다.
    let msg;
    if (state.myActionForfeited) msg = '⏱ 시간 안에 다 고르지 못해 이번 라운드 나머지 선택을 넘겼습니다.';
    else if (state.oppOpensRemaining > 0) msg = '✅ 이번 라운드 몫을 다 열었습니다. 상대를 기다리는 중...';
    else msg = '✅ 양쪽 모두 완료 — 라운드 시간이 끝날 때까지 잠시만 기다려주세요.';
    left.appendChild(el('p', 'hint', msg));
  }
  split.appendChild(left);

  const right = el('div', 'roomCrestRight');
  appendRewardPanels(right, state);
  const gemWidget = gemStatusWidget(state);
  if (gemWidget) right.appendChild(gemWidget);
  if (right.children.length) split.appendChild(right);

  mine.appendChild(split);
  wrap.appendChild(mine);

  app.appendChild(wrap);
}

// -------- 미니게임 UI --------
function renderMinigamePanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, `미니게임: ${state.minigame.name}`));
  const box = el('div', 'mgBox');
  const mg = state.minigame.public;
  const type = state.minigame.type;

  if (type === 'NIM') {
    if (nimRound !== state.round) { nimRound = state.round; nimDisplayedRatio = 0; }
    nimTargetRatio = mg.fillRatio;
    box.appendChild(el('div', 'desc', '번갈아 1~3씩 채우세요(숫자키 가능). 넘치면 집니다.'));
    const gobletWrap = el('div', 'nimGobletWrap');
    // 목표치(mg.fillRatio)가 아니라 지금까지 보간되어 온 nimDisplayedRatio로 그려서, 전체
    // 화면이 다시 그려져도 액체가 갑자기 목표 눈금까지 튀지 않고 이어서 서서히 차오르게 한다.
    gobletWrap.innerHTML = nimGobletSVG(nimDisplayedRatio);
    box.appendChild(gobletWrap);
    const row = el('div', 'btnRow');
    [1, 2, 3].forEach((n) => {
      const b = el('button', 'action', `${n}칸 채우기`);
      b.disabled = !mg.myTurn;
      b.onclick = () => socket.emit('minigame:move', { n });
      row.appendChild(b);
    });
    box.appendChild(row);
    box.appendChild(turnBadge(mg.myTurn));
  } else if (type === 'HAND') {
    box.appendChild(el('div', 'desc', '한 명이 독 든 손을 숨기고, 상대가 맞힙니다.'));
    if (mg.role === 'hider') {
      box.appendChild(el('div', 'desc', mg.waitingForMe ? '독을 숨길 손을 고르세요.' : '상대가 맞히는 중입니다...'));
      const row = el('div', 'btnRow');
      ['L', 'R'].forEach((h) => {
        const b = el('button', 'action', h === 'L' ? '왼손에 숨기기' : '오른손에 숨기기');
        b.disabled = !mg.waitingForMe;
        b.onclick = () => socket.emit('minigame:move', { hand: h });
        row.appendChild(b);
      });
      box.appendChild(row);
    } else {
      box.appendChild(el('div', 'desc', mg.hiderDone ? '어느 손에 독이 있을지 고르세요.' : '상대가 손을 숨기는 중입니다...'));
      const row = el('div', 'btnRow');
      ['L', 'R'].forEach((h) => {
        const b = el('button', 'action', h === 'L' ? '왼손 지목' : '오른손 지목');
        b.disabled = !mg.waitingForMe;
        b.onclick = () => socket.emit('minigame:move', { hand: h });
        row.appendChild(b);
      });
      box.appendChild(row);
    }
  } else if (type === 'REFLEX') {
    // 완전히 암전된 화면이었다가, 무작위 순간에 잔이 환하게 밝혀지면 그때 가장 먼저 누르는 사람이 승리.
    // 어두울 때 누르면 성급하게 움직인 것으로 간주되어 그 자리에서 즉시 패배한다.
    box.appendChild(el('div', 'desc', '밝아지면 클릭/스페이스로 먼저 누르세요. 미리 누르면 즉시 패배.'));
    const stage = el('div', 'reflexStage' + (mg.goFired ? ' lit' : ''));
    stage.innerHTML = mg.goFired
      ? `<div class="reflexGoblet">${sceneCupSVG()}</div><div class="reflexCta">지금 클릭!</div>`
      : '<div class="reflexDark">잔이 어둠 속에 있습니다...</div>';
    if (!mg.myClicked) stage.onclick = () => socket.emit('minigame:move', { action: 'CLICK' });
    else stage.classList.add('done');
    box.appendChild(stage);
    if (mg.myClicked) box.appendChild(el('div', 'hint', '상대의 반응을 기다리는 중...'));
  } else if (type === 'BOMB') {
    box.appendChild(el('div', 'desc', '터지기 전에 넘기세요(스페이스 가능). 막판 10초는 안 보임.'));
    const bombRemainingNow = mg.expiresAt - Date.now();
    const timerEl = el('div', 'bombTimer' + (bombRemainingNow <= 10000 && bombRemainingNow > 0 ? ' bombHidden' : ''), bombTimerText(bombRemainingNow));
    timerEl.id = 'bombTimer';
    box.appendChild(timerEl);
    if (!bombTicking) { bombTicking = true; requestAnimationFrame(tickBombTimer); }
    const b = el('button', 'iconBtn danger' + (mg.myTurn ? '' : ' waiting'), `${bombIconSVG()}<span>폭탄 넘기기</span>`);
    b.disabled = !mg.myTurn;
    b.onclick = () => socket.emit('minigame:move', { action: 'PASS' });
    box.appendChild(b);
    box.appendChild(turnBadge(mg.myTurn, '지금 내가 들고 있음'));
  } else if (type === 'PIN') {
    box.appendChild(el('div', 'desc', `${mg.pinCount}개 중 폭탄 하나 — 번갈아 뽑아 걸리면 집니다.`));
    const grid = el('div', 'pinGrid');
    // 항상 2줄로 나누되, 윗줄/아랫줄 개수가 최대한 비슷하도록 열 개수를 그때그때 계산한다
    // (예: 12개 → 6+6, 10개 → 5+5, 9개 → 5+4) — 고정 6열로 두면 개수가 6의 배수가 아닐 때
    // 아랫줄만 짧게 남아 줄이 안 맞아 보였다.
    const pinCols = Math.ceil(mg.pinCount / 2);
    grid.style.gridTemplateColumns = `repeat(${pinCols}, 1fr)`;
    grid.style.maxWidth = `${pinCols * 46 + (pinCols - 1) * 8}px`;
    for (let i = 0; i < mg.pinCount; i++) {
      const pulled = mg.pulled[i];
      const isBomb = mg.bombIndex === i;
      const cell = el('div', 'pinCell' + (pulled ? (isBomb ? ' bomb' : ' safe') : '') + (!pulled && mg.myTurn ? ' pickable' : ''),
        pulled && isBomb ? '💥' : pinIconSVG());
      if (!pulled && mg.myTurn) cell.onclick = () => socket.emit('minigame:move', { action: 'PICK', index: i });
      grid.appendChild(cell);
    }
    box.appendChild(grid);
    box.appendChild(turnBadge(mg.myTurn));
  } else if (type === 'SIGIL') {
    if (sigilRound !== state.round) {
      sigilRound = state.round;
      sigilLayout = computeSigilLayout(mg.itemCounts);
      sigilConsumed = { GOLD: new Set(), SILVER: new Set(), BRONZE: new Set() };
    }
    const TIERS = [['GOLD', 'gold'], ['SILVER', 'silver'], ['BRONZE', 'bronze']];
    let neededTier = null;
    for (const [key] of TIERS) {
      if ((mg.myProgress[key] || 0) < (mg.itemCounts[key] || 0)) { neededTier = key; break; }
    }

    const guide = el('div', 'medalOrderGuide');
    TIERS.forEach(([key, cls], i) => {
      const doneAll = (mg.myProgress[key] || 0) >= (mg.itemCounts[key] || 0);
      const extra = doneAll ? 'done' : (key === neededTier ? 'active' : '');
      guide.appendChild(el('span', 'medalGuideItem', medalCupIconSVG(cls, extra)));
      if (i < TIERS.length - 1) guide.appendChild(el('span', 'medalArrow', '→'));
    });
    box.appendChild(guide);

    const area = el('div', 'medalScatterArea');
    TIERS.forEach(([key, cls]) => {
      const allPositions = (sigilLayout && sigilLayout[key]) || [];
      const consumed = sigilConsumed[key];
      // 새로고침/재접속 등으로 로컬 기록 없이 서버 진행도(done)만 더 앞서 있는 경우를 대비한
      // 안전망 — 그럴 땐 어차피 "내가 어느 걸 눌렀는지"를 구분할 수 없으니, 앞에서부터 채워
      // 맞춰준다(정상적인 클릭 흐름에서는 done이 항상 consumed.size와 같이 늘어나므로 영향 없음).
      const done = mg.myProgress[key] || 0;
      for (let i = 0; consumed.size < done && i < allPositions.length; i++) {
        if (!consumed.has(i)) consumed.add(i);
      }
      const isActive = key === neededTier;
      allPositions.forEach((pos, idx) => {
        if (consumed.has(idx)) return; // 이미 내가 누른(또는 서버가 반영한) 잔은 바로 숨긴다
        const b = el('button', 'medalCupBtn', medalCupIconSVG(cls, isActive ? 'active' : ''));
        b.style.left = pos.x + '%';
        b.style.top = pos.y + '%';
        b.disabled = !isActive;
        b.dataset.sigilTier = key;
        b.dataset.sigilIdx = idx;
        b.onclick = () => {
          // 서버 응답(다음 state)을 기다리지 않고 내가 누른 바로 이 잔을 즉시 숨긴다 — 예전엔
          // 진행도 개수만큼 레이아웃 앞에서부터 잘라 숨기는 방식이라, 클릭한 잔과 실제로 사라지는
          // 잔이 서로 달라 보이는 문제가 있었다.
          consumed.add(idx);
          socket.emit('minigame:move', { tier: key });
        };
        area.appendChild(b);
      });
    });
    box.appendChild(area);

    const infoRow = el('div', 'sigilInfoRow');
    const totalItems = TIERS.reduce((s, [k]) => s + (mg.itemCounts[k] || 0), 0);
    const myDone = TIERS.reduce((s, [k]) => s + Math.min(mg.myProgress[k] || 0, mg.itemCounts[k] || 0), 0);
    const oppDone = TIERS.reduce((s, [k]) => s + Math.min(mg.oppProgress[k] || 0, mg.itemCounts[k] || 0), 0);
    infoRow.appendChild(el('span', 'sigilInfoBadge', `나 ${myDone}/${totalItems}`));
    infoRow.appendChild(el('span', 'sigilInfoBadge', `상대 ${oppDone}/${totalItems}`));
    box.appendChild(infoRow);
  } else if (type === 'GUESS_COUNT') {
    if (guessCountRound !== state.round) {
      guessCountRound = state.round;
      guessCountRevealUntil = Date.now() + 2000;
      guessCountTransitioned = false;
      guessCountEntry = '';
      guessCountScene = computeGuessCountScene(mg.trueCount);
    }
    const remaining = guessCountRevealUntil - Date.now();
    if (remaining > 0 && mg.myGuess == null) {
      box.appendChild(el('div', 'desc', '탁자 위에 놓인 술잔을 잘 세어두세요 — 잠시 후 사라집니다.'));
      const scene = el('div', 'guessScene');
      guessCountScene.forEach((pos) => {
        const cup = el('div', 'guessSceneItem', sceneCupSVG());
        cup.style.left = pos.x + '%';
        cup.style.top = pos.y + '%';
        cup.style.transform = `translate(-50%, -50%) rotate(${pos.rot.toFixed(1)}deg) scale(${pos.scale.toFixed(2)})`;
        scene.appendChild(cup);
      });
      box.appendChild(scene);
      box.appendChild(el('div', 'hint', `${Math.max(1, Math.ceil(remaining / 1000))}초 후 가려집니다`));
    } else if (mg.myGuess == null) {
      const maxGuess = state.config.GUESS_COUNT_MAX;
      box.appendChild(el('div', 'desc', '몇 개였을까요? 가장 가깝게 맞히는 쪽이 이깁니다.'));
      box.appendChild(numKeypad({
        get: () => guessCountEntry,
        set: (v) => { guessCountEntry = v; },
        maxLen: 2,
        allowDigit: (d, cur) => Number(cur + d) <= maxGuess,
        submitLabel: '추측 제출',
        onSubmit: (entry) => {
          const n = Number(entry);
          if (!entry || !Number.isInteger(n) || n < 0 || n > maxGuess) { addLog(`⚠ 0~${maxGuess} 사이의 숫자를 입력하세요.`); return false; }
          socket.emit('minigame:move', { guess: n });
          return true;
        },
      }));
    } else {
      box.appendChild(el('div', 'desc', `내 추측: ${mg.myGuess}개 — 상대 추측을 기다리는 중...`));
    }
  } else if (type === 'BANK') {
    // 각자 자신만의 금고(컴퓨터가 무작위로 정한 서로 다른 정답)를 갖고 독립적으로 숫자야구를 진행한다.
    // "상대 것은 볼 필요 없다"는 피드백에 따라 더 이상 상대의 시도 내역은 보여주지 않고 내 금고에만
    // 집중한다. 입력도 한 번에 이어붙이던 키패드 대신, 자릿수별 칸을 하나씩 채우고 그 칸 자체를
    // 스트라이크(초록)/볼(노랑)로 물들여 가시성을 높였다.
    if (bankRound !== state.round) { bankRound = state.round; bankDigits = Array(mg.digits).fill(null); bankFocusIndex = 0; }
    box.appendChild(el('div', 'desc', `숫자야구 — 0~9 중 서로 다른 ${mg.digits}자리를 추리하세요. <span class="strikeText">초록</span>=스트라이크, <span class="ballText">노랑</span>=볼.`));

    const history = el('div', 'bankHistory');
    if ((mg.myGuesses || []).length === 0) {
      history.appendChild(el('div', 'hint', '아직 시도한 적이 없습니다.'));
    }
    (mg.myGuesses || []).slice().reverse().forEach((h) => {
      history.appendChild(bankHistoryRow(h));
    });
    box.appendChild(history);

    box.appendChild(el('div', 'hint', '아래 칸을 채워 금고 번호를 추리하세요 (몇 번이든 시도 가능).'));
    box.appendChild(digitCellsInput({
      len: mg.digits,
      digits: () => bankDigits,
      setDigits: (v) => { bankDigits = v; },
      focusIndex: () => bankFocusIndex,
      setFocusIndex: (i) => { bankFocusIndex = i; },
      wrapId: 'bankNumpadWrap',
      submitLabel: '번호 불러보기',
      onSubmit: (digits) => {
        socket.emit('minigame:move', { guess: digits });
        return true;
      },
    }));
  } else if (type === 'DICE') {
    box.appendChild(el('div', 'desc', '스페이스바(또는 버튼)를 꾹 눌렀다 떼면 눈이 나옵니다. 큰 눈이 승리, 같으면 무승부.'));
    const stage = el('div', 'diceStage');
    const already = mg.myResult != null;
    const faceHolder = el('div', 'diceFaceHolder');
    faceHolder.id = 'diceFaceHolder';
    faceHolder.innerHTML = diceFaceSVG(already ? mg.myResult : diceFace, already ? 'settled' : (mg.myPressed ? 'spinning' : ''));
    stage.appendChild(faceHolder);
    if (!already) {
      const btn = el('button', 'action diceHoldBtn' + (mg.myPressed ? ' held' : ''), mg.myPressed ? '누르는 중... 떼면 확정!' : '꾹 눌러서 굴리기 (스페이스바 가능)');
      btn.id = 'diceHoldBtn';
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); startDiceHold(); });
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); startDiceHold(); });
      btn.addEventListener('mouseup', (e) => { e.preventDefault(); releaseDiceHold(); });
      btn.addEventListener('mouseleave', () => releaseDiceHold());
      btn.addEventListener('touchend', (e) => { e.preventDefault(); releaseDiceHold(); });
      stage.appendChild(btn);
    } else {
      stage.appendChild(el('div', 'hint', `내 눈: ${mg.myResult}`));
    }
    box.appendChild(stage);
    if (mg.oppPressed && !mg.revealed) box.appendChild(el('div', 'hint', '상대가 누르고 있습니다...'));
    if (mg.revealed) {
      const revealRow = el('div', 'diceRevealRow');
      revealRow.innerHTML = `${diceFaceSVG(mg.revealed.myResult, 'mini')}<span class="diceVs">VS</span>${diceFaceSVG(mg.revealed.oppResult, 'mini')}`;
      box.appendChild(revealRow);
    } else if (already) {
      box.appendChild(el('div', 'hint', '상대의 결과를 기다리는 중...'));
    }
  }
  // "장고 금지" 타이머 — REFLEX/BOMB은 이미 각자의 실시간 연출(신호/폭탄 퓨즈)이 있으므로 제외하고,
  // 나머지 타입은 전부 mg.deadlineAt을 공통으로 받으므로 한 곳에서 배지 하나로 통일해서 보여준다.
  if (mg && mg.deadlineAt && type !== 'REFLEX' && type !== 'BOMB') {
    const t = el('span', 'decisionTimer');
    t.id = 'decisionTimer';
    box.appendChild(t);
    if (!decisionTicking) { decisionTicking = true; requestAnimationFrame(tickDecisionTimer); }
  }
  p.appendChild(box);
  return p;
}
function turnBadge(myTurn, label) {
  const b = el('span', 'badge ' + (myTurn ? 'turn' : 'wait'), myTurn ? (label || '내 차례') : '상대 차례');
  return b;
}

// -------- 액션 UI --------
// 본행동은 별도 모드 선택 없이, 왼쪽 "내 처소" 그리드에서 바로 칸을 클릭해 여는 것뿐이다
// (아이템/단서 획득은 없음 — 정찰은 미니게임 보상으로만 얻는다).
function renderActionPanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, '본행동'));
  if (state.actionDeadlineAt) {
    const t = el('span', 'actionTimerBadge');
    t.id = 'actionTimer';
    p.appendChild(t);
    if (!actionTimerTicking) { actionTimerTicking = true; requestAnimationFrame(tickActionTimer); }
  }
  // 처소 열기는 두 사람이 동시에 각자 진행한다 — 서로 기다릴 필요 없이 바로 열면 된다.
  if (!state.isMyTurn) {
    // "선택 안 하면 랜덤으로 안 골라짐" — 시간 초과로 그냥 넘긴 경우를 "다 열었음"과 구분해서 보여준다.
    p.appendChild(el('p', 'badge', state.myActionForfeited ? '⏱ 시간 안에 다 고르지 못해 이번 라운드 나머지 선택을 넘겼습니다.' : '✅ 이번 라운드 몫을 다 열었습니다.'));
    p.appendChild(el('p', 'hint', state.oppOpensRemaining > 0 ? `상대는 아직 ${state.oppOpensRemaining}칸 더 열어야 합니다...` : '상대도 완료했습니다 — 라운드 시간이 끝날 때까지 잠시만 기다려주세요.'));
    return p;
  }
  p.appendChild(el('p', 'badge turn', `왼쪽 "내 처소"에서 열고 싶은 칸 ${state.opensRemaining}개를 고르세요 (상대와 동시에 진행됩니다)`));
  return p;
}

// -------- 보상 사용 UI --------
function renderRewardPanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, '🎁 보상 사용'));
  const box = el('div', 'mgBox');
  const r = state.myReward;

  if (r.type === 'FLASH_ALL') {
    // 예전엔 0~10초 사이 무작위 순간에 자동으로 터졌지만, "내가 원할 때 스페이스바로 직접
    // 터뜨리고 싶다"는 피드백으로 수동 트리거로 바꿨다 — 원하는 타이밍에 스페이스바(또는 버튼)를
    // 누르면 그 즉시 내 처소 그 자리에 그대로 철가방이 열리는 연출이 나온다.
    box.appendChild(el('div', 'desc', '🍱 철가방 정찰 — 원할 때 스페이스바를 누르면 그 즉시 내 처소 전체의 뚜껑이 확 열렸다가 저절로 잠깐 드러납니다.'));
    const b = el('button', 'action primary', '🍱 지금 터뜨리기 (Space)');
    b.onclick = () => socket.emit('reward:use', {});
    box.appendChild(b);
  } else if (r.type === 'PEEK_CELL') {
    box.appendChild(el('div', 'desc', '내 처소에서 확인할 칸 1개를 고르세요 (아래는 내 처소의 좌표판입니다).'));
    const grid = el('div', 'grid6 pickerGrid');
    // 후반에 열리는 줄(잠긴 칸)은 정찰 대상이 될 수 없으므로 좌표판에서도 제외한다.
    const activeRows = (state.me.room[state.config.ROWS_FIRST_HALF] && state.me.room[state.config.ROWS_FIRST_HALF][0].locked)
      ? state.config.ROWS_FIRST_HALF : state.config.ROWS_TOTAL;
    for (let rr = 0; rr < activeRows; rr++) {
      for (let cc = 0; cc < state.config.GRID; cc++) {
        const cell = el('div', 'cell pickable');
        cell.onclick = () => socket.emit('reward:use', { row: rr, col: cc });
        grid.appendChild(cell);
      }
    }
    box.appendChild(grid);
  } else if (r.type === 'ROW_COUNT' || r.type === 'COL_COUNT') {
    const axisLabel = r.type === 'ROW_COUNT' ? '가로줄' : '세로줄';
    // 가로줄 개수는 전반/후반에 따라 4개 또는 6개로 달라진다(세로줄은 늘 6개) — 아직 후반에
    // 열리지 않은 줄은 집계 자체에서 빠지므로 실제로 활성화된 줄 수만 안내한다.
    const activeRows = (state.me.room[state.config.ROWS_FIRST_HALF] && state.me.room[state.config.ROWS_FIRST_HALF][0].locked)
      ? state.config.ROWS_FIRST_HALF : state.config.ROWS_TOTAL;
    const axisCount = r.type === 'ROW_COUNT' ? activeRows : state.config.GRID;
    box.appendChild(el('div', 'desc', `내 처소에서 확인할 술잔 종류를 고르세요 — ${axisCount}개 ${axisLabel} 전부에 몇 개씩 있는지 한 번에 알려드립니다.`));
    const typeRow = el('div', 'btnRow');
    Object.keys(state.clueCatNames).forEach((cat) => {
      const b = el('button', 'action', state.clueCatNames[cat]);
      b.onclick = () => socket.emit('reward:use', { targetType: cat });
      typeRow.appendChild(b);
    });
    box.appendChild(typeRow);
  }
  p.appendChild(box);
  return p;
}

// ---------------------------- END ----------------------------
// 라운드별 요약 표 — 라운드마다 미니게임 승자/받은 보상/그 시점 누적 점수를 보여주고,
// 점수 선두(앞서가는 쪽)가 라운드별로 어떻게 바뀌었는지("선점")까지 함께 표시한다.
function buildRoundHistoryPanel(state) {
  const hist = state.roundHistory || [];
  if (!hist.length) return null;
  const panel = el('div', 'panel');
  panel.appendChild(el('h3', null, '📜 라운드별 요약'));
  const oppName = state.opp ? state.opp.name : '상대';
  let leadOwner = null; // 지금까지(이 라운드까지) 앞서고 있는 쪽 — 'me' | 'opp' | null(동점)
  let leadChanges = 0;
  let firstLead = null;
  const rows = hist.map((h) => {
    const cur = h.myScore === h.oppScore ? null : (h.myScore > h.oppScore ? 'me' : 'opp');
    let leadBadge = '';
    if (cur && cur !== leadOwner) {
      leadChanges += 1;
      if (!firstLead) firstLead = cur;
      leadOwner = cur;
      leadBadge = `<span class="leadBadge ${cur}">${cur === 'me' ? '내가 선두' : `${oppName} 선두`}</span>`;
    }
    const winnerLabel = h.winner === 'draw' ? '무승부'
      : h.winner === 'me' ? `나 (${state.me.name})`
      : h.winner === 'opp' ? oppName
      : '-';
    const rewardLabel = h.rewardName
      ? `${h.rewardName} <span class="rewardOwnerTag">(${h.rewardOwner === 'me' ? '나' : oppName})</span>`
      : '-';
    return `<tr>
      <td>${h.round}</td>
      <td>${h.minigameName || '-'}</td>
      <td>${winnerLabel}</td>
      <td>${rewardLabel}</td>
      <td class="scoreCell">${h.myScore} : ${h.oppScore}</td>
      <td>${leadBadge}</td>
    </tr>`;
  }).join('');
  const table = el('table', 'roundHistoryTable', `
    <thead><tr><th>R</th><th>미니게임</th><th>승자</th><th>보상</th><th>점수(나:상대)</th><th>선점</th></tr></thead>
    <tbody>${rows}</tbody>
  `);
  panel.appendChild(table);
  panel.appendChild(el('p', 'hint', leadChanges > 0
    ? `경기 중 선두가 총 ${leadChanges}번 바뀌었습니다 (처음 앞서간 쪽: ${firstLead === 'me' ? '나' : oppName}).`
    : '경기 내내 선두가 한 번도 바뀌지 않았습니다.'));
  return panel;
}

function renderEnd(state) {
  const cls = state.winner === 'me' ? 'win' : state.winner === 'opp' ? 'lose' : 'draw';
  const title = state.winner === 'me' ? '👑 왕위를 차지했습니다' : state.winner === 'opp' ? '⚰️ 왕위를 넘겨주었습니다' : '무승부 — 두 왕자의 점수가 같습니다';
  const p = el('div', 'panel');
  const banner = el('div', 'endBanner ' + cls);
  banner.appendChild(el('h2', null, title));
  banner.appendChild(el('p', null, state.endReason || ''));
  p.appendChild(banner);

  const historyPanel = buildRoundHistoryPanel(state);
  if (historyPanel) p.appendChild(historyPanel);

  const cols = el('div', 'cols');
  const mine = el('div', 'col');
  mine.appendChild(el('h3', null, `내 처소 최종 (${state.me.name})`));
  mine.appendChild(statGrid(state.me, state.config));
  mine.appendChild(el('p', 'hint', `최종 점수: <b>${state.me.finalScore}</b> (${poisonBreakdownText(state.me, state.config)})`));
  mine.appendChild(buildRevealGrid(state.me.room));
  cols.appendChild(mine);

  if (state.opp) {
    const opp = el('div', 'col');
    opp.appendChild(el('h3', null, `상대 처소 최종 (${state.opp.name})`));
    opp.appendChild(statGrid(state.opp, state.config));
    opp.appendChild(el('p', 'hint', `최종 점수: <b>${state.opp.finalScore}</b> (${poisonBreakdownText(state.opp, state.config)})`));
    if (state.opp.room) opp.appendChild(buildRevealGrid(state.opp.room));
    cols.appendChild(opp);
  }
  p.appendChild(cols);
  app.appendChild(p);
  app.appendChild(renderRematchPanel(state));
}

function renderRematchPanel(state) {
  const p = el('div', 'panel center');
  p.appendChild(el('h2', null, '다시 하기'));
  const rr = state.rematchReady || { me: false, opp: false };
  if (rr.me) {
    p.appendChild(el('p', 'badge ' + (rr.opp ? 'win' : 'wait'), rr.opp ? '양측 준비 완료 — 새 게임을 시작합니다...' : '✅ 준비 완료 — 상대방을 기다리는 중...'));
  } else {
    const btn = el('button', 'action primary', '🔁 다시 하기');
    btn.onclick = () => { socket.emit('rematch:ready'); btn.disabled = true; btn.textContent = '대기 중...'; };
    p.appendChild(btn);
    if (rr.opp) p.appendChild(el('p', 'hint', '상대방은 이미 다시 하기를 신청했습니다.'));
  }
  p.appendChild(el('p', 'hint', '같은 두 사람이 곧바로 다시 대전합니다. 아예 새로 시작하려면(예: 다른 사람과 교체) 아래 "전체 초기화"를 사용하세요.'));
  return p;
}

function buildRevealGrid(room) {
  const grid = el('div', 'grid6');
  for (let r = 0; r < room.length; r++) {
    for (let c = 0; c < room[r].length; c++) {
      const data = room[r][c];
      const cell = el('div', 'cell opened ' + data.type, cellVisualHTML(data.type, data.gemPiece, data.gemId != null ? data.gemId : r * 6 + c));
      grid.appendChild(cell);
    }
  }
  return grid;
}

setInterval(() => {
  if (!lastState) return;
  // 촛불 개수 맞히기: 공개 시간이 지나면 새 서버 상태 없이도 "추측 입력" 화면으로 딱 한 번 전환한다.
  // (전환 후에는 계속 다시 그리지 않음 — 숫자 키패드 입력 중에 화면이 계속 다시 그려지면 입력이 씹히던 문제의 재발을 막기 위함)
  if (!guessCountTransitioned && lastState.phase === 'ROUND_MINIGAME' && lastState.minigame && lastState.minigame.type === 'GUESS_COUNT'
      && lastState.minigame.public.myGuess == null && guessCountRevealUntil && Date.now() >= guessCountRevealUntil) {
    guessCountTransitioned = true;
    render(lastState);
  }
}, 300);
