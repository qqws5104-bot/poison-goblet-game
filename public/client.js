// 4대 분리 모드: /game/A, /pick/A, /game/B, /pick/B 같은 고정 주소로 접속하면 여기서
// 역할(APP_ROLE: 'game'|'pick')과 슬롯(APP_SLOT: 'A'|'B')을 읽어낸다. 그 외 주소('/'로 접속한
// 기존 방식)는 APP_ROLE이 null로 남아 예전 동작(2인 단일화면)을 한 글자도 안 건드리고 그대로 쓴다.
const ROUTE_MATCH = location.pathname.match(/^\/(game|pick)\/([AB])\/?$/);
const APP_ROLE = ROUTE_MATCH ? ROUTE_MATCH[1] : null; // 'game' | 'pick' | null
const APP_SLOT = ROUTE_MATCH ? ROUTE_MATCH[2] : null; // 'A' | 'B' | null
const socket = APP_SLOT ? io({ query: { slot: APP_SLOT } }) : io();
const app = document.getElementById('app');
const statusBar = document.getElementById('statusBar');
const logBox = document.getElementById('log');

let lastState = null;
let setupSelection = []; // [{row,col}]
let midSetupSelection = []; // 중반 독 추가 설치: [{row,col}]
let guessCountRound = null;
let guessCountRevealUntil = 0;
let guessCountTransitioned = false; // 공개→입력 화면 전환을 딱 한 번만 하기 위한 플래그
let guessCountEntry = ''; // 탁자 위 술잔 개수 세기: 숫자 키패드로 입력 중인 값
let guessCountScene = []; // 화면에 흩뿌려 놓을 술잔 위치(라운드당 한 번만 계산 — 매번 다시 그릴 때 위치가 흔들리지 않도록)
let bankDigits = []; // 금고 번호 맞추기: 자릿수별 칸에 입력 중인 값([null,'5',null] 형태)
let bankFocusIndex = 0; // 지금 숫자를 채울 칸(자동으로 다음 빈 칸으로 이동)
let bankRound = null;
let bombTicking = false; // 폭탄 눈치 넘기기: 실시간 남은시간 표시용 rAF 루프가 이미 돌고 있는지
let flashRoom = null; // 섬광 정찰 보상: 잠깐 전체 공개할 내 처소 타입 배열
let peekCell = null; // 한 칸 정찰 보상: 잠깐 불이 들어왔다 꺼지는 느낌으로 보여줄 좌표/종류 { row, col, type }
let seenSeq = null; // 서버의 match.seq — 값이 바뀌면(재대전 포함) 새 매치이므로 화면/입력 상태를 초기화
let lastRewardResult = null; // 보상으로 획득한 정찰 결과 텍스트 — #log(숨김)만으로는 안 보이므로 화면에 계속 띄워둔다
let lastRewardResultRound = null;
let activeTab = 'GAME'; // '게임 화면'(미니게임/본행동/보상)과 '6×6 화면'(내 처소)을 탭으로 분리 — 'GAME' | 'ROOM'
let lastPhaseForTab = null; // 페이즈가 "바뀌는 순간"에만 자동으로 알맞은 탭으로 전환하기 위한 추적값
let roundOpenSummary = []; // 이번 라운드에 내가 새로 연 칸들 [{row,col,type}] — ROUND_DONE 화면에서 "방금 뭘 열었는지" 보여주는 용도
let roundOpenSummaryRound = null; // roundOpenSummary가 몇 라운드 것인지(라운드가 바뀌면 초기화)
let cardDuelPicks = []; // 숫자 패 대결: 지금까지 클릭한 순서대로 쌓인 배치([1~3의 순열이 되기 전까지])
let cardDuelRound = null; // cardDuelPicks가 몇 라운드 것인지(라운드가 바뀌면 초기화)
// 미니게임 모달이 "이미 떠 있던 채로" 다시 그려지는 것인지 추적 — render()는 상대의 움직임이나
// 내 입력 하나하나에도 화면 전체를 다시 그리므로, 매번 모달을 새로 마운트하면 등장 애니메이션이
// (본인이 만든 변화가 아니어도) 계속 재생되어 화면이 깜빡이는 것처럼 보인다. 직전 프레임에도
// 모달이 열려 있었다면 이번엔 애니메이션 없이 조용히 갱신한다.
let modalOpenPrev = false;

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

const CELL_NAME = { P: '독', GEM: '보석', A: '해독', E: '', C: '문장' };
const CELL_EMOJI = { P: '☠️', GEM: '💎', A: '💊', E: '', C: '🐉' }; // 로그 등 순수 텍스트 자리에서만 사용

// 독/금/은 술잔은 잔 모양 + 안쪽 표식, 해독제는 병 모양으로 그리는 발광 SVG 아이콘.
// 그리드 칸(및 종료 화면 공개칸)에서 이모지 대신 실제 DOM에 그려 넣는다.
function cellIconSVG(type) {
  if (!type || type === 'E') return '';
  if (type === 'A') {
    return `<svg viewBox="0 0 32 32" class="cellIcon cellIcon-A" aria-hidden="true">
      <rect class="cork" x="12.5" y="1.5" width="7" height="4" rx="1.5"/>
      <rect class="neck" x="13.5" y="5" width="5" height="4.5"/>
      <path class="bowl" d="M9,10 C9,9 11,9.2 13,9.2 L19,9.2 C21,9.2 23,9 23,10 L24,20.5 C24,25.5 20.2,28.5 16,28.5 C11.8,28.5 8,25.5 8,20.5 Z"/>
      <path class="leaf" d="M16,13.2 C13.2,14.2 13.2,18.6 16,20 C18.8,18.6 18.8,14.2 16,13.2 Z M16,13.4 L16,19.8"/>
    </svg>`;
  }
  if (type === 'C') {
    // 가문의 문장 — 술잔이 아니라 방패 모양 문장(휘장)으로 그려 다른 칸과 뚜렷이 구분한다.
    return `<svg viewBox="0 0 32 32" class="cellIcon cellIcon-C" aria-hidden="true">
      <path class="bowl" d="M16,2.5 L27,6.5 L27,16.5 C27,23.5 22,28 16,29.8 C10,28 5,23.5 5,16.5 L5,6.5 Z"/>
      <path class="glyph" d="M16,9.5 L20,15.5 L16,22.5 L12,15.5 Z"/>
    </svg>`;
  }
  const inner = type === 'P'
    ? `<circle class="glyph" cx="16" cy="14" r="3.3"/><ellipse class="cut" cx="14.4" cy="13.2" rx="0.8" ry="1"/><ellipse class="cut" cx="17.6" cy="13.2" rx="0.8" ry="1"/><rect class="cut" x="14.7" y="15.5" width="2.6" height="0.9" rx="0.3"/>`
    : `<path class="glyph" d="M16,10.2 L17.1,13.4 L20.4,14 L17.1,14.6 L16,17.8 L14.9,14.6 L11.6,14 L14.9,13.4 Z"/>`;
  const drip = type === 'P' ? '<path class="drip" d="M6.4,15 C5.4,17 5.5,18.8 6.6,18.8 C7.7,18.8 7.4,17 6.4,15 Z"/>' : '';
  return `<svg viewBox="0 0 32 32" class="cellIcon cellIcon-${type}" aria-hidden="true">
    <ellipse class="rim" cx="16" cy="8" rx="11.6" ry="2.2"/>
    <path class="bowl" d="M4.4,8.4 L27.6,8.4 L18.2,22 L13.8,22 Z"/>
    <path class="stem" d="M16,22 L16,26.8"/>
    <ellipse class="base" cx="16" cy="27.6" rx="6.2" ry="1.6"/>
    ${drip}
    ${inner}
  </svg>`;
}
// 가문의 문장(C) 칸은 실제로 "연" 순간부터는 범용 방패 아이콘 대신, 서버가 함께 내려준 조각
// 번호(1~9)에 해당하는 실제 이미지 조각(/crest/{gold|silver}_{1..9}.png)을 보여준다 — 9조각을
// 다 모으면 원본 그림 한 장이 완성되는 구조. 장남은 금색, 차남은 은색 문장을 쓴다(추천안대로
// 서로 다른 이미지). 아직 열지 않았거나(정찰로 살짝 엿본 것뿐인) 서버가 조각 번호를 내려주지
// 않은 경우엔 기존 방패 아이콘으로 대체한다(정찰은 "문장이 있다"는 정보만 주고, 정확히 몇 번
// 조각인지는 실제로 열어야만 알 수 있게 해 정찰의 가치를 낮추지 않는다).
function crestFamilyFor(name) { return name === '장남' ? 'gold' : 'silver'; }
function crestTileImgHTML(piece, family) {
  return `<img class="crestTile" src="/crest/${family}_${piece}.png" alt="가문의 문장 조각 ${piece}/9"/>`;
}
function cellVisualHTML(type, piece, family) {
  if (type === 'C' && piece && family) return crestTileImgHTML(piece, family);
  return cellIconSVG(type);
}
// 처소 그리드 한쪽(9칸 중 지금까지 실제로 연 문장 조각들)을 3x3 조립판으로 보여준다 — 아직
// 못 찾은 조각은 물음표로, 저격당해 영영 못 찾는 조각도 그냥 물음표로 남는다(본인은 그게
// 저격당한 건지 아직 안 나온 건지 구분할 수 없다 — 히든정보 원칙 유지).
function crestAssemblyWidget(room, family) {
  const collected = {};
  for (const row of room) for (const cell of row) {
    if (cell.opened && cell.type === 'C' && cell.piece) collected[cell.piece] = true;
  }
  const wrap = el('div', 'crestAssembly');
  wrap.appendChild(el('h3', null, `가문의 문장 조각 (${Object.keys(collected).length}/9)`));
  const grid = el('div', 'crestAssemblyGrid');
  for (let i = 1; i <= 9; i++) {
    const slot = el('div', 'crestAssemblySlot' + (collected[i] ? ' filled' : ''));
    slot.innerHTML = collected[i] ? crestTileImgHTML(i, family) : '<span class="crestSlotQ">?</span>';
    grid.appendChild(slot);
  }
  wrap.appendChild(grid);
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
    let revealed = null; // 우선순위: 독 > 해독제 > 문장 > 보석
    for (let r = 0; r < next.me.room.length; r++) {
      for (let c = 0; c < next.me.room[r].length; c++) {
        const before = prev.me.room[r] && prev.me.room[r][c];
        const after = next.me.room[r][c];
        if (before && !before.opened && after.opened) {
          if (after.type === 'P') revealed = 'P';
          else if (after.type === 'A' && revealed !== 'P') revealed = 'A';
          else if (after.type === 'C' && !revealed) revealed = 'C';
          else if (after.type === 'GEM' && !revealed) revealed = 'GEM';
          // "칸을 열자마자 바로 다음으로 넘어가 뭘 열었는지 놓친다"는 피드백 — 이번 라운드에
          // 새로 연 칸을 전부 기록해뒀다가, ROUND_DONE(5초 대기) 화면에서 한눈에 보여준다.
          if (next.round !== roundOpenSummaryRound) { roundOpenSummary = []; roundOpenSummaryRound = next.round; }
          roundOpenSummary.push({ row: r, col: c, type: after.type, piece: after.piece || null });
        }
      }
    }
    if (revealed === 'P') impactFor('poison');
    else if (revealed === 'A') impactFor('antidote');
    else if (revealed === 'C' || revealed === 'GEM') impactFor('treasure');
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
    cardDuelPicks = [];
    cardDuelRound = null;
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

function render(state) {
  if (!state) return;
  renderStatusBar(state);
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
    const myFamily = state.me ? crestFamilyFor(state.me.name) : null;
    summary.forEach(({ row: r, col: c, type, piece }) => {
      const item = el('div', 'roundOpenSummaryItem');
      const icon = el('div', 'roundOpenSummaryIcon' + (type === 'E' ? '' : ' cellIcon-' + type));
      icon.innerHTML = type === 'E' ? '<span class="emptyMark">✕</span>' : cellVisualHTML(type, piece, myFamily);
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
      grid.appendChild(el('div', 'cell opened ' + room[r][c], cellIconSVG(room[r][c])));
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
  p.appendChild(el('h2', null, '셋업 — 상대 왕자의 처소에 독 술잔을 몰래 지정하세요'));
  p.appendChild(el('p', 'hint', `아래 그리드는 상대(${state.opp ? state.opp.name : '상대'})의 빈 처소(전반 6×${state.config.ROWS_FIRST_HALF}칸)입니다. 독을 심을 칸 ${state.config.POISON_INITIAL}개를 고른 뒤 확정하세요. 확정 후에는 바꿀 수 없습니다. 가문의 문장은 독 설치가 끝난 뒤 무작위 자리에 몰래 흩뿌려지므로, 본인도 어디에 몇 개나 있는지 알 수 없습니다.`));

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
  p.appendChild(el('p', 'hint', `상대(${state.opp ? state.opp.name : '상대'})의 처소에서 아직 열리지 않은 칸 중 ${state.config.POISON_MID}곳을 골라 독을 추가로 몰래 심으세요. 회색 칸은 상대가 이미 연 칸이라 대상이 될 수 없습니다. 후반에 새로 열리는 문장 조각도 이 배치가 끝난 뒤에 무작위로 흩뿌려집니다.`));

  const openedMask = state.oppOpenedMask || [];
  const already = state.midSetupDone && state.midSetupDone.me;
  const grid = el('div', 'grid6');
  for (let r = 0; r < state.config.ROWS_TOTAL; r++) {
    for (let c = 0; c < state.config.GRID; c++) {
      const cell = el('div', 'cell');
      const isOpened = !!(openedMask[r] && openedMask[r][c]);
      const isSel = midSetupSelection.some((s) => s.row === r && s.col === c);
      if (isOpened) cell.classList.add('blockedSpot');
      if (isSel) cell.classList.add('selected');
      if (!already && !isOpened) {
        cell.classList.add('pickable');
        cell.onclick = () => {
          const idx = midSetupSelection.findIndex((s) => s.row === r && s.col === c);
          if (idx >= 0) midSetupSelection.splice(idx, 1);
          else if (midSetupSelection.length < state.config.POISON_MID) midSetupSelection.push({ row: r, col: c });
          render(lastState);
        };
      }
      cell.innerHTML = isSel ? selectionMarkSVG() : (isOpened ? '<span class="emptyMark">✕</span>' : '');
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

  const wrap = el('div', 'mainView');
  wrap.appendChild(renderStatsPanel(state));
  wrap.appendChild(renderTabBar(state));

  // 4대 분리 모드의 "게임" 화면에서는 보상(=내 처소를 들여다보는 정찰) 관련 패널을 전혀
  // 띄우지 않는다 — 각 처소 상황은 이제 전부 "고르기" 화면에서 보고 진행한다. 레거시
  // (단일 화면 2인 모드) 모드에서는 예전처럼 그대로 이 자리에 보여준다.
  if (APP_ROLE !== 'game') appendRewardPanels(wrap, state);
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
  mine.appendChild(statGrid(state.me));
  wrap.appendChild(mine);

  // 상대의 점수/독/해독제 현황은 게임이 끝나기 전까지 비공개 — 서로의 패를 못 보게 하는 것이
  // 이 게임의 핵심 재미이므로, 실시간으로 다 보여주지 않는다(최종 결과 화면에서만 공개).
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

function statGrid(p) {
  const g = el('div', 'statgrid');
  // 독이 2개 이상 쌓이면 위험하다는 긴장감을 시각적으로 준다. 1차/2차 독의 정확한 감점 액수는
  // 서로 달라서(2차가 더 아픔) 게임이 끝나야 공개되므로, 여기서는 구체적 숫자 없이 뭉뚱그려 표시한다.
  g.appendChild(statBox('poison', p.poison, '독 (종료 시 감점 — 2차 독이 더 아픔)', p.poison >= 2));
  g.appendChild(statBox('antidote', p.antidote, '해독제'));
  g.appendChild(statBox('score', p.score, '점수'));
  if (p.crestOpened != null) {
    // 총 몇 조각인지는 게임이 끝나기 전까지 비공개(서프라이즈 요소)라, 완성 전에는 분모 없이
    // 발견한 개수만 보여준다. 서버가 END에서만 crestTotal을 내려준다.
    const label = p.crestTotal != null ? `${p.crestOpened} / ${p.crestTotal}` : `${p.crestOpened}`;
    g.appendChild(statBox('crest', label, '가문의 문장 조각'));
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
        // 빈 칸(E)은 아이콘이 없어 안 연 칸과 헷갈릴 수 있으므로, 큰 X로 "이미 열어봤음"을 표시한다.
        cell.innerHTML = data.type === 'E' ? '<span class="emptyMark">✕</span>' : cellVisualHTML(data.type, data.piece, opts.crestFamily);
      } else if (opts.peekCell && opts.peekCell.row === r && opts.peekCell.col === c) {
        // 한 칸 정찰 보상: 실제로 연 것은 아니지만, 잠깐 불이 들어와 정체가 보였다가 저절로
        // 꺼지는 느낌을 준다 — CSS 애니메이션이 밝게 켜진 상태에서 원래의 어두운 모습으로 페이드된다.
        cell.classList.add('peekLit', opts.peekCell.type);
        cell.innerHTML = opts.peekCell.type === 'E' ? '<span class="emptyMark">✕</span>' : cellIconSVG(opts.peekCell.type);
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
  // 섬광 정찰(FLASH_ALL)을 골랐다면 실제로 번쩍이는 순간을 먼저 겪어야 칸을 열 수 있다 —
  // 서버도 doAction()에서 똑같이 막지만, 클릭해도 안 먹히는 것처럼 보이지 않도록 미리 잠근다.
  const waitingForFlash = !!(state.myReward && state.myReward.type === 'FLASH_ALL' && !state.myReward.used);
  const pickMode = state.isMyTurn && state.opensRemaining > 0 && !waitingForFlash;
  const myFamily = crestFamilyFor(state.me.name);
  p.appendChild(buildRoomGrid(state.me.room, { pickMode, onOpen: (r, c) => socket.emit('action:open', { row: r, col: c }), flashRoom, peekCell, crestFamily: myFamily }));
  if (pickMode) p.appendChild(el('p', 'hint', `열고 싶은 칸을 클릭하세요. (이번 턴에 ${state.opensRemaining}개 더 열 수 있습니다)`));
  else if (waitingForFlash) p.appendChild(el('p', 'hint', '🍱 철가방 정찰이 터질 때까지 잠시 기다리세요 — 번쩍인 뒤에 칸을 열 수 있습니다.'));
  p.appendChild(crestAssemblyWidget(state.me.room, myFamily));
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
  const wrap = el('div', 'mainView');

  appendRewardPanels(wrap, state);

  const waitingForFlash = !!(state.myReward && state.myReward.type === 'FLASH_ALL' && !state.myReward.used);
  const pickMode = state.isMyTurn && state.opensRemaining > 0 && !waitingForFlash;

  const mine = el('div', 'panel');
  mine.appendChild(el('h2', null, `내 처소 (${state.me.name})`));
  const myFamily = crestFamilyFor(state.me.name);
  mine.appendChild(buildRoomGrid(state.me.room, { pickMode, onOpen: (r, c) => socket.emit('action:open', { row: r, col: c }), flashRoom, peekCell, crestFamily: myFamily }));
  if (pickMode) mine.appendChild(el('p', 'hint', `열고 싶은 칸을 클릭하세요. (이번 턴에 ${state.opensRemaining}개 더 열 수 있습니다)`));
  else if (waitingForFlash) mine.appendChild(el('p', 'hint', '🍱 철가방 정찰이 터질 때까지 잠시 기다리세요.'));
  else if (!state.isMyTurn) mine.appendChild(el('p', 'hint', state.oppOpensRemaining > 0 ? '✅ 이번 라운드 몫을 다 열었습니다. 상대를 기다리는 중...' : '✅ 양쪽 모두 완료 — 다음 라운드로 넘어갑니다.'));
  mine.appendChild(crestAssemblyWidget(state.me.room, myFamily));
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
    box.appendChild(el('div', 'desc', '번갈아 1~3만큼 독배를 채웁니다. 정확히 몇 번째에 넘치는지는 아무도 모릅니다 — 넘치게 만든 사람이 이번 미니게임에서 집니다.'));
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
    box.appendChild(el('div', 'desc', '한 명이 독이 든 손(왼/오)을 숨기고, 다른 한 명이 어느 손인지 맞힙니다.'));
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
    box.appendChild(el('div', 'desc', '화면이 완전히 어두워집니다. 잔이 환하게 밝혀지는 순간, 누구보다 빨리 클릭하세요. 어두울 때 클릭하면 즉시 패배합니다.'));
    const stage = el('div', 'reflexStage' + (mg.goFired ? ' lit' : ''));
    stage.innerHTML = mg.goFired
      ? `<div class="reflexGoblet">${sceneCupSVG()}</div><div class="reflexCta">지금 클릭!</div>`
      : '<div class="reflexDark">잔이 어둠 속에 있습니다...</div>';
    if (!mg.myClicked) stage.onclick = () => socket.emit('minigame:move', { action: 'CLICK' });
    else stage.classList.add('done');
    box.appendChild(stage);
    if (mg.myClicked) box.appendChild(el('div', 'hint', '상대의 반응을 기다리는 중...'));
  } else if (type === 'BOMB') {
    box.appendChild(el('div', 'desc', '정해진 시간이 다 되면 터집니다. 터지는 순간 들고 있으면 집니다. (막판 10초부터는 정확히 언제 터질지 감춰집니다)'));
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
    box.appendChild(el('div', 'desc', `안전핀 ${mg.pinCount}개 중 하나는 폭탄 — 번갈아 하나씩 뽑으세요.<br/>폭탄을 뽑으면 그 사람이 집니다.`));
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
    box.appendChild(el('div', 'desc', '검은 독배를 베고, 독배는 방패에 스며들고, 방패는 검을 막습니다. 상대와 동시에 하나를 고르세요.'));
    const row = el('div', 'btnRow');
    [['SWORD', '🗡️ 검'], ['POISON', '☠️ 독배'], ['SHIELD', '🛡️ 방패']].forEach(([key, label]) => {
      const b = el('button', 'action' + (mg.myPick === key ? ' primary' : ''), label);
      b.disabled = !mg.waitingForMe;
      b.onclick = () => socket.emit('minigame:move', { pick: key });
      row.appendChild(b);
    });
    box.appendChild(row);
    if (!mg.waitingForMe) box.appendChild(el('div', 'hint', mg.oppPicked ? '결과 공개 중...' : '상대의 선택을 기다리는 중...'));
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
    box.appendChild(el('div', 'desc', `숫자야구입니다. 나만의 금고(0~9 중 서로 다른 숫자 ${mg.digits}개)를 추리하세요. 칸이 <span class="strikeText">초록</span>이면 스트라이크(숫자·자리 모두 일치), <span class="ballText">노랑</span>이면 볼(숫자만 일치)입니다.`));

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
  } else if (type === 'CARD_DUEL') {
    box.appendChild(el('div', 'desc', '카드 1·2·3을 원하는 순서로 클릭해 세 자리(①②③)에 하나씩 배치하세요. 셋 다 놓으면 상대와 동시에 공개되어, 같은 자리끼리 숫자를 비교합니다 — 더 큰 숫자를 낸 자리가 많은 쪽이 승리(자리 승수가 같으면 무승부)입니다.'));
    if (cardDuelRound !== state.round) { cardDuelRound = state.round; cardDuelPicks = []; }
    // 새로고침 등으로 로컬 상태가 날아갔어도, 이미 서버에 제출된 배치가 있으면 그걸 그대로 보여준다.
    if (mg.myArrangement && cardDuelPicks.length !== 3) cardDuelPicks = mg.myArrangement.slice();

    const slotsRow = el('div', 'btnRow cardDuelSlots');
    for (let i = 0; i < 3; i++) {
      const val = cardDuelPicks[i];
      slotsRow.appendChild(el('div', 'cardDuelSlot' + (val ? ' filled' : ''), val ? String(val) : `${i + 1}번째 자리`));
    }
    box.appendChild(slotsRow);

    if (!mg.submitted) {
      const numRow = el('div', 'btnRow');
      [1, 2, 3].forEach((n) => {
        const used = cardDuelPicks.includes(n);
        const b = el('button', 'action', String(n));
        b.disabled = used || cardDuelPicks.length >= 3;
        b.onclick = () => {
          cardDuelPicks.push(n);
          if (cardDuelPicks.length === 3) socket.emit('minigame:move', { arrangement: cardDuelPicks.slice() });
          render(lastState);
        };
        numRow.appendChild(b);
      });
      box.appendChild(numRow);
      if (cardDuelPicks.length > 0) {
        const undo = el('button', 'action', '다시 배치');
        undo.onclick = () => { cardDuelPicks = []; render(lastState); };
        box.appendChild(undo);
      }
    } else {
      box.appendChild(el('div', 'hint', mg.oppSubmitted ? '결과 공개 중...' : '상대의 배치를 기다리는 중...'));
    }

    if (mg.revealed) {
      const revealRow = el('div', 'btnRow cardDuelReveal');
      for (let i = 0; i < 3; i++) {
        const myN = mg.revealed.mine[i], oppN = mg.revealed.opp[i];
        const cls = myN > oppN ? 'win' : myN < oppN ? 'lose' : 'tie';
        revealRow.appendChild(el('div', 'cardDuelLane ' + cls, `${myN} : ${oppN}`));
      }
      box.appendChild(revealRow);
    }
  } else if (type === 'PACT') {
    box.appendChild(el('div', 'desc', '상대와 동시에 몰래 침묵/밀고를 고릅니다.<br/>둘 다 침묵하면 서로 처소 정보를 하나씩 나눠 받고, 한쪽만 밀고하면 그 쪽이 미니게임 승리로 정찰 보상을 직접 고르며, 둘 다 밀고하면 아무도 얻는 것이 없습니다.'));
    const row = el('div', 'btnRow');
    [['SILENT', '침묵한다'], ['TALK', '밀고한다']].forEach(([key, label]) => {
      const b = el('button', 'action' + (mg.myAction === key ? ' primary' : ''), label);
      b.disabled = !mg.waitingForMe;
      b.onclick = () => socket.emit('minigame:move', { action: key });
      row.appendChild(b);
    });
    box.appendChild(row);
    if (!mg.waitingForMe) box.appendChild(el('div', 'hint', mg.oppActed ? '결과 공개 중...' : '상대의 선택을 기다리는 중...'));
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
  // 처소 열기는 두 사람이 동시에 각자 진행한다 — 서로 기다릴 필요 없이 바로 열면 된다.
  if (!state.isMyTurn) {
    p.appendChild(el('p', 'badge', '✅ 이번 라운드 몫을 다 열었습니다.'));
    p.appendChild(el('p', 'hint', state.oppOpensRemaining > 0 ? `상대는 아직 ${state.oppOpensRemaining}칸 더 열어야 합니다...` : '상대도 완료했습니다 — 다음 라운드로 넘어갑니다.'));
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
    // 정확히 언제 터질지는 이제 화면에 보여주지 않는다 — "몇 초 후 터집니다" 카운트다운이 없어야
    // 기습적으로 느껴진다는 피드백. 서버는 여전히 fireAt을 알고 있고, 그 순간이 오기 전까지는
    // (renderMyRoomPanel에서) 칸 열기 자체를 잠가 정보가 헛되지 않게 한다.
    box.appendChild(el('div', 'desc', '🍱 철가방 정찰 — 곧(언제일지 모름) 내 처소 전체의 뚜껑이 확 열렸다가 저절로 잠깐 드러납니다. 그 전까지는 칸을 열 수 없습니다.'));
    box.appendChild(el('div', 'hint', '⏳ 기다리는 중...'));
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
    const axisCount = r.type === 'ROW_COUNT' ? state.config.ROWS_TOTAL : state.config.GRID;
    box.appendChild(el('div', 'desc', `내 처소에서 확인할 술잔 종류를 고르세요 — ${axisCount}개 ${axisLabel} 전부에 몇 개씩 있는지 한 번에 알려드립니다. (아직 열리지 않은 줄은 0으로 표시됩니다)`));
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
function renderEnd(state) {
  const cls = state.winner === 'me' ? 'win' : state.winner === 'opp' ? 'lose' : 'draw';
  const title = state.winner === 'me' ? '👑 왕위를 차지했습니다' : state.winner === 'opp' ? '⚰️ 왕위를 넘겨주었습니다' : '무승부 — 두 왕자의 점수가 같습니다';
  const p = el('div', 'panel');
  const banner = el('div', 'endBanner ' + cls);
  banner.appendChild(el('h2', null, title));
  banner.appendChild(el('p', null, state.endReason || ''));
  p.appendChild(banner);

  const cols = el('div', 'cols');
  const mine = el('div', 'col');
  mine.appendChild(el('h3', null, `내 처소 최종 (${state.me.name})`));
  mine.appendChild(statGrid(state.me));
  mine.appendChild(el('p', 'hint', `최종 점수: <b>${state.me.finalScore}</b> (${poisonBreakdownText(state.me, state.config)})`));
  mine.appendChild(buildRevealGrid(state.me.room, crestFamilyFor(state.me.name)));
  cols.appendChild(mine);

  if (state.opp) {
    const opp = el('div', 'col');
    opp.appendChild(el('h3', null, `상대 처소 최종 (${state.opp.name})`));
    opp.appendChild(statGrid(state.opp));
    opp.appendChild(el('p', 'hint', `최종 점수: <b>${state.opp.finalScore}</b> (${poisonBreakdownText(state.opp, state.config)})`));
    if (state.opp.room) opp.appendChild(buildRevealGrid(state.opp.room, crestFamilyFor(state.opp.name)));
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

function buildRevealGrid(room, family) {
  const grid = el('div', 'grid6');
  for (let r = 0; r < room.length; r++) {
    for (let c = 0; c < room[r].length; c++) {
      const data = room[r][c];
      const cell = el('div', 'cell opened ' + data.type, cellVisualHTML(data.type, data.piece, family));
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
