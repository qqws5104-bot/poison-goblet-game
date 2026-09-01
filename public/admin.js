// 관리자(관전) 화면 — 플레이어 슬롯을 차지하지 않고, 장남/차남 두 사람의 처소를 실시간으로 그대로 보여준다.
// 밸런스 테스트 관찰용이므로 플레이어에게는 숨기는 정보(칸 종류 전체)도 그대로 내려받아 보여준다.
const socket = io({ query: { role: 'admin' } });
const app = document.getElementById('app');
const statusBar = document.getElementById('statusBar');

const CELL_NAMES = { P: '독 술잔', G: '금 술잔', S: '은 술잔', A: '해독제', E: '빈 칸' };
let prevOpened = {}; // 이름별 이전 opened 상태(6x6) — 방금 새로 열린 칸에 반짝임 효과를 주기 위함

// client.js의 cellIconSVG와 동일한 아이콘(독/금/은/해독제) — 관리자 화면에서도 같은 모양으로 보여준다.
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

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

const PHASE_NAMES = { LOBBY: '대기 중', SETUP: '독배 설치 중', ROUND_MINIGAME: '미니게임 진행 중', ROUND_ACTION: '처소 열기 진행 중', END: '게임 종료' };

socket.on('connect', () => { statusBar.textContent = '연결됨 — 상태를 기다리는 중...'; });
socket.on('disconnect', () => { statusBar.textContent = '⚠ 서버와 연결이 끊겼습니다.'; });

socket.on('adminState', (state) => {
  render(state);
});

function render(state) {
  statusBar.innerHTML = `<b>${PHASE_NAMES[state.phase] || state.phase}</b> · 라운드 ${state.round}/${state.roundsTotal}${state.minigame ? ` · 미니게임: ${state.minigame.name}` : ''}`;
  app.innerHTML = '';

  if (!state.players || state.players.length === 0) {
    app.appendChild(el('div', 'panel center', '<p>아직 접속한 플레이어가 없습니다.</p>'));
    return;
  }

  // 요청사항: "관리자용 화면은 상대의 화면을 서로 볼 수 있도록" — 확정된 결과뿐 아니라
  // 셋업 확정 전 실시간 미리보기, 미니게임 진행 중인 선택도 함께 보여준다.
  if (state.phase === 'SETUP' && state.setupPreview) app.appendChild(renderSetupPreview(state.setupPreview));
  if (state.phase === 'ROUND_MINIGAME' && state.minigame && state.minigame.detail) app.appendChild(renderMinigameDetail(state.minigame));

  const grid = el('div', 'adminGrid');
  state.players.forEach((p) => {
    grid.appendChild(renderPlayerCard(p));
  });
  app.appendChild(grid);
}

function renderSetupPreview(preview) {
  const p = el('div', 'panel adminLive');
  p.appendChild(el('h2', null, '🔴 실시간 설치 현황 (확정 전 미리보기 — 관리자 전용)'));
  const row = el('div', 'adminLiveRow');
  preview.forEach((entry) => {
    const col = el('div', 'adminLiveCol');
    col.appendChild(el('h3', null, `${entry.name} ${entry.confirmed ? '<span class="badge win">확정됨</span>' : '<span class="badge wait">선택 중...</span>'}`));
    const grid6 = el('div', 'adminGrid6 adminGrid6small');
    const cellSet = new Set((entry.cells || []).map((c) => c.row + '_' + c.col));
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const div = el('div', 'adminCell' + (cellSet.has(r + '_' + c) ? ' selPreview' : ''));
        grid6.appendChild(div);
      }
    }
    col.appendChild(grid6);
    row.appendChild(col);
  });
  p.appendChild(row);
  return p;
}

function renderMinigameDetail(minigame) {
  const p = el('div', 'panel adminLive');
  p.appendChild(el('h2', null, `🔴 미니게임 진행 상황 — ${minigame.name} (관리자 전용)`));
  const list = el('div', 'adminDetailList');
  Object.entries(minigame.detail || {}).forEach(([label, value]) => {
    let valueText;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      valueText = Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(' · ');
    } else if (Array.isArray(value)) {
      valueText = value.join(', ');
    } else {
      valueText = String(value);
    }
    list.appendChild(el('div', 'adminDetailRow', `<b>${label}</b>: ${valueText}`));
  });
  p.appendChild(list);
  return p;
}

function renderPlayerCard(p) {
  const card = el('div', 'panel adminCard adminCol');
  const openedCount = p.room.flat().filter((c) => c.opened).length;
  card.appendChild(el('h2', null,
    `${p.name} <span class="adminSub">${p.connected ? '' : '(연결 끊김) '}독${p.poison} · 해독${p.antidote} · 점수${p.score} · 연 칸 ${openedCount}/36</span>`));

  const prev = prevOpened[p.name] || [];
  const nowOpened = [];
  const grid6 = el('div', 'adminGrid6');
  for (let r = 0; r < p.room.length; r++) {
    nowOpened.push([]);
    for (let c = 0; c < p.room[r].length; c++) {
      const cell = p.room[r][c];
      const wasOpened = prev[r] && prev[r][c];
      nowOpened[r].push(!!cell.opened);
      // "서로 어떤 걸 선택했는지"만 보여주는 게 목적 — 무엇인지(종류)는 알 필요 없고, 그저
      // "이 칸을 선택했다"는 사실만 보이면 된다. 그래서 연 칸이라도 종류별 아이콘/색을 쓰지 않고,
      // 전부 똑같은 모양의 "선택됨" 표시만 준다(안 연 칸은 계속 완전히 빈 칸).
      const div = el('div', 'adminCell' + (cell.opened ? ' opened' : '') + (cell.opened && !wasOpened ? ' justOpened' : ''));
      div.title = cell.opened ? `(${r + 1},${c + 1}) · 선택됨` : `(${r + 1},${c + 1}) · 미선택`;
      grid6.appendChild(div);
    }
  }
  prevOpened[p.name] = nowOpened;
  card.appendChild(grid6);
  return card;
}
