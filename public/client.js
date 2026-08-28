const socket = io();
const app = document.getElementById('app');
const statusBar = document.getElementById('statusBar');
const logBox = document.getElementById('log');

let lastState = null;
let setupSelection = []; // [{row,col}]
let actionMode = null; // null | 'ITEM_GET' | 'CLUE' | 'OPEN' | 'ITEM_USE'
let itemUseType = null; // when actionMode==='ITEM_USE', which item chosen (awaiting target if needed)
let lastClueResult = null;
let guessCountRound = null;
let guessCountRevealUntil = 0;
let flashRoom = null; // 섬광 정찰 보상: 0.1초간 전체 공개할 상대 처소 타입 배열
let rewardChosenType = null; // 행/열 정찰 보상 선택 중인 술잔 종류
let seenSeq = null; // 서버의 match.seq — 값이 바뀌면(재대전 포함) 새 매치이므로 화면/입력 상태를 초기화

const CELL_NAME = { P: '독', G: '금', S: '은', A: '해독', E: '' };
const CELL_EMOJI = { P: '☠️', G: '🥇', S: '🥈', A: '💊', E: '' }; // 로그 등 순수 텍스트 자리에서만 사용
const ITEM_EMOJI = { SPOON: '🥄', NOSE: '👃', WARD: '🧿', SWAP: '🎭' };

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

function addLog(msg) {
  const div = document.createElement('div');
  div.textContent = msg;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

socket.on('log', ({ msg }) => addLog(msg));
socket.on('error', ({ message }) => addLog('⚠ ' + message));
socket.on('full', () => { app.innerHTML = '<div class="panel center"><p>이미 두 명이 접속해 있습니다. 이 프로토타입은 2인 전용입니다.</p></div>'; });
socket.on('clueResult', ({ text, cells }) => { lastClueResult = { text, cells: cells || [] }; addLog('🔎 ' + text); render(lastState); });

socket.on('rewardResult', (payload) => {
  if (payload.kind === 'FLASH_ALL') {
    flashRoom = payload.room;
    addLog('⚡ 섬광 정찰 — 상대 처소 전체가 0.1초간 공개되었습니다.');
    render(lastState);
    setTimeout(() => { flashRoom = null; render(lastState); }, 100);
    return;
  }
  if (payload.kind === 'PEEK_CELL') {
    addLog(`🔎 한 칸 정찰: 상대 처소 (${payload.row + 1},${payload.col + 1}) = ${CELL_EMOJI[payload.type] || ''} ${CELL_NAME[payload.type] || ''}`);
  } else if (payload.kind === 'ROW_COUNT' || payload.kind === 'COL_COUNT') {
    const axisLabel = payload.kind === 'ROW_COUNT' ? '행' : '열';
    const catName = (lastState && lastState.clueCatNames && lastState.clueCatNames[payload.targetType]) || payload.targetType;
    addLog(`🔎 정찰 결과: 상대 ${payload.index + 1}${axisLabel}에 ${catName}이(가) ${payload.count}개 있습니다.`);
  }
  render(lastState);
});

socket.on('state', (state) => {
  if (state.seq !== seenSeq) {
    // 새 매치 시작(최초 접속 또는 재대전) — 지난 판에서 남은 화면/입력 상태를 전부 초기화
    seenSeq = state.seq;
    setupSelection = [];
    actionMode = null;
    itemUseType = null;
    lastClueResult = null;
    guessCountRound = null;
    guessCountRevealUntil = 0;
    flashRoom = null;
    rewardChosenType = null;
  }
  lastState = state;
  render(state);
});

document.getElementById('btnReset').onclick = () => { if (confirm('게임을 재시작할까요? (두 플레이어 모두 다시 접속해야 할 수 있습니다)')) socket.emit('admin:reset'); };

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function render(state) {
  if (flashRoom) return renderFlashOverlay(flashRoom);
  if (!state) return;
  renderStatusBar(state);
  app.innerHTML = '';
  if (state.phase === 'LOBBY') return renderLobby(state);
  if (state.phase === 'SETUP') return renderSetup(state);
  if (state.phase === 'END') return renderEnd(state);
  return renderMain(state);
}

function renderFlashOverlay(room) {
  app.innerHTML = '';
  const p = el('div', 'panel flashOverlay');
  p.appendChild(el('h2', null, '⚡ 섬광 정찰 — 상대 처소 전체 (0.1초)'));
  const grid = el('div', 'grid6');
  for (let r = 0; r < room.length; r++) {
    for (let c = 0; c < room[r].length; c++) {
      grid.appendChild(el('div', 'cell opened ' + room[r][c], cellIconSVG(room[r][c])));
    }
  }
  p.appendChild(grid);
  app.appendChild(p);
}

function renderStatusBar(state) {
  statusBar.innerHTML = `
    <span>나: <b>${state.me ? state.me.name : '-'}</b></span>
    <span>상대: <b>${state.opp ? state.opp.name : '대기 중'}</b></span>
    <span>라운드: <b>${state.round || 0} / ${state.roundsTotal || '-'}</b></span>
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
function renderSetup(state) {
  const p = el('section', 'panel');
  p.appendChild(el('h2', null, '셋업 — 상대 왕자의 처소에 독 술잔 3개를 몰래 지정하세요'));
  p.appendChild(el('p', 'hint', `아래 그리드는 상대(${state.opp ? state.opp.name : '상대'})의 빈 처소입니다. 독을 심을 칸 ${state.config.COUNTS.P}개를 고른 뒤 확정하세요. 확정 후에는 바꿀 수 없습니다.`));

  const already = state.setupDone.me;
  const grid = el('div', 'grid6');
  for (let r = 0; r < state.config.GRID; r++) {
    for (let c = 0; c < state.config.GRID; c++) {
      const cell = el('div', 'cell');
      const isSel = setupSelection.some((s) => s.row === r && s.col === c);
      if (isSel) cell.classList.add('selected');
      if (!already) {
        cell.classList.add('pickable');
        cell.onclick = () => {
          const idx = setupSelection.findIndex((s) => s.row === r && s.col === c);
          if (idx >= 0) setupSelection.splice(idx, 1);
          else if (setupSelection.length < state.config.COUNTS.P) setupSelection.push({ row: r, col: c });
          render(lastState);
        };
      }
      cell.textContent = isSel ? '☠' : '';
      grid.appendChild(cell);
    }
  }
  p.appendChild(grid);

  const info = el('p', 'hint', `선택됨: ${setupSelection.length} / ${state.config.COUNTS.P}`);
  p.appendChild(info);

  if (!already) {
    const btn = el('button', 'action primary', '독 설치 확정');
    btn.disabled = setupSelection.length !== state.config.COUNTS.P;
    btn.onclick = () => socket.emit('setup:confirm', { cells: setupSelection });
    p.appendChild(btn);
  } else {
    p.appendChild(el('p', 'hint', '✅ 설치 완료. 상대방을 기다리는 중...'));
  }

  const statusP = el('p', 'hint', `나: ${state.setupDone.me ? '완료' : '진행 중'} · 상대: ${state.setupDone.opp ? '완료' : '진행 중'}`);
  p.appendChild(statusP);

  app.appendChild(p);
}

// ---------------------------- MAIN (미니게임 + 액션) ----------------------------
function renderMain(state) {
  const cols = el('div', 'cols');

  // 왼쪽: 내 방 + 통계
  const left = el('div', 'col');
  left.appendChild(renderStatsPanel(state));
  left.appendChild(renderMyRoomPanel(state));
  cols.appendChild(left);

  // 오른쪽: 라운드 보상 안내 / 미니게임 / 액션 / 보상 사용 / 내 행동 기록
  const right = el('div', 'col');
  if (state.roundReward) right.appendChild(renderRoundRewardBanner(state));
  if (state.phase === 'ROUND_MINIGAME') right.appendChild(renderMinigamePanel(state));
  if (state.phase === 'ROUND_ACTION') right.appendChild(renderActionPanel(state));
  if (state.phase === 'ROUND_ACTION' && state.myReward && !state.myReward.used) right.appendChild(renderRewardPanel(state));
  right.appendChild(renderHistoryPanel(state));
  cols.appendChild(right);

  app.appendChild(cols);
}

function renderRoundRewardBanner(state) {
  const p = el('div', 'panel rewardBanner');
  p.appendChild(el('h2', null, '이번 라운드 보상'));
  p.appendChild(el('div', 'desc', `🎁 ${state.roundReward.name}<br/><span class="hint">미니게임 승자가 획득합니다.</span>`));
  if (state.myReward) {
    p.appendChild(el('div', 'hint', state.myReward.used ? '✅ 이미 사용했습니다.' : '✨ 당신이 이 보상을 얻었습니다 — 아래 "보상 사용"에서 사용하세요.'));
  } else if (state.oppHasReward) {
    p.appendChild(el('div', 'hint', '⚠ 상대가 이 보상을 아직 가지고 있습니다.'));
  }
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
  mine.appendChild(el('p', 'hint', `아이템: ${state.me.items.length ? state.me.items.map((i) => `${ITEM_EMOJI[i] || ''} ${state.itemNames[i]}`).join(', ') : '없음'} ${state.me.shield ? ' · 🧿 부적 활성' : ''}`));
  wrap.appendChild(mine);

  if (state.opp) {
    const opp = el('div', 'col');
    opp.appendChild(el('h3', null, `상대 처소 (${state.opp.name}) ${state.opp.connected ? '' : '<span class="hint">(연결 끊김)</span>'}`));
    opp.appendChild(statGrid(state.opp));
    opp.appendChild(el('p', 'hint', `보유 아이템 수: ${state.opp.itemCount}${state.opp.shield ? ' · 🧿 부적 활성' : ''}`));
    wrap.appendChild(opp);
  }
  p.appendChild(wrap);
  return p;
}

function statGrid(p) {
  const g = el('div', 'statgrid');
  g.appendChild(statBox('poison', p.poison, `독 (종료 시 -${lastState.config.POISON_PENALTY}점/개)`));
  g.appendChild(statBox('antidote', p.antidote, '해독제'));
  g.appendChild(statBox('score', p.score, '점수'));
  return g;
}
function statBox(cls, v, label) {
  const d = el('div', 'stat ' + cls);
  d.appendChild(el('div', 'v', v));
  d.appendChild(el('div', 'l', label));
  return d;
}

function renderMyRoomPanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, '내 처소 (6×6)'));
  if (lastClueResult) {
    const box = el('div', 'clueResultBox', '📜 ' + lastClueResult.text);
    p.appendChild(box);
  }
  const hintCells = (lastClueResult && lastClueResult.cells) || [];
  const isHint = (r, c) => hintCells.some((h) => h.row === r && h.col === c);
  const pickMode = state.isMyTurn && (actionMode === 'OPEN' || (actionMode === 'ITEM_USE' && itemUseType === 'SPOON'));
  const grid = el('div', 'grid6');
  for (let r = 0; r < state.config.GRID; r++) {
    for (let c = 0; c < state.config.GRID; c++) {
      const data = state.me.room[r][c];
      const cell = el('div', 'cell');
      if (data.opened) {
        cell.classList.add('opened', data.type);
        cell.innerHTML = cellIconSVG(data.type);
      } else if (data.type) {
        cell.classList.add('clued');
        cell.appendChild(el('div', null, cellIconSVG(data.type)));
        cell.appendChild(el('span', 'clueMark', '?'));
      } else {
        cell.textContent = '';
      }
      if (!data.opened && isHint(r, c)) cell.classList.add('hint-area');
      if (data.note) {
        const n = el('div', 'note', data.note);
        cell.appendChild(n);
      }
      if (pickMode && !data.opened) {
        cell.classList.add('pickable');
        cell.onclick = () => {
          if (actionMode === 'OPEN') {
            socket.emit('action:open', { row: r, col: c });
            actionMode = null;
          } else if (actionMode === 'ITEM_USE' && itemUseType === 'SPOON') {
            socket.emit('action:item_use', { itemType: 'SPOON', target: { row: r, col: c } });
            actionMode = null; itemUseType = null;
          }
        };
      }
      grid.appendChild(cell);
    }
  }
  p.appendChild(grid);
  if (pickMode) p.appendChild(el('p', 'hint', '열고 싶은 칸을 클릭하세요.'));
  return p;
}

// -------- 미니게임 UI --------
function renderMinigamePanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, `미니게임: ${state.minigame.name}`));
  const box = el('div', 'mgBox');
  const mg = state.minigame.public;
  const type = state.minigame.type;

  if (type === 'NIM') {
    box.appendChild(el('div', 'desc', `번갈아 1~3만큼 잔을 채웁니다. 누적이 ${mg.limit} 이상이 되게 만든 사람이 이번 미니게임에서 집니다. (현재 누적: ${mg.count}/${mg.limit})`));
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
  } else if (type === 'CARD') {
    box.appendChild(el('div', 'desc', '카드 값(1~5)을 보고 제시자가 진실 또는 거짓 값을 말하면, 상대가 진실/거짓을 판별합니다.'));
    if (mg.role === 'presenter') {
      box.appendChild(el('div', 'desc', `실제 카드 값: <b>${mg.trueVal}</b> (당신만 볼 수 있음)`));
      if (mg.waitingForMe) {
        const row = el('div', 'btnRow');
        for (let n = 1; n <= lastState.config.CARD_MAX; n++) {
          const b = el('button', 'action', String(n));
          b.onclick = () => socket.emit('minigame:move', { declared: n });
          row.appendChild(b);
        }
        box.appendChild(el('div', 'desc', '제시할 값을 고르세요 (실제 값과 같게 = 진실, 다르게 = 거짓).'));
        box.appendChild(row);
      } else {
        box.appendChild(el('div', 'desc', '상대가 판별하는 중입니다...'));
      }
    } else {
      if (mg.declared == null) {
        box.appendChild(el('div', 'desc', '상대가 카드 값을 제시하는 중입니다...'));
      } else {
        box.appendChild(el('div', 'desc', `제시된 값: <b>${mg.declared}</b> — 이게 진실일까요, 거짓일까요?`));
        const row = el('div', 'btnRow');
        const t = el('button', 'action', '진실이다'); t.disabled = !mg.waitingForMe; t.onclick = () => socket.emit('minigame:move', { guess: 'TRUE' });
        const l = el('button', 'action', '거짓이다'); l.disabled = !mg.waitingForMe; l.onclick = () => socket.emit('minigame:move', { guess: 'LIE' });
        row.appendChild(t); row.appendChild(l);
        box.appendChild(row);
      }
    }
  } else if (type === 'BOMB') {
    box.appendChild(el('div', 'desc', `폭탄이 숨겨진 순간에 터집니다. 지금까지 ${mg.passes}번 넘겨졌습니다. 터질 때 들고 있으면 집니다.`));
    const row = el('div', 'btnRow');
    const b = el('button', 'action danger', '폭탄 넘기기');
    b.disabled = !mg.myTurn;
    b.onclick = () => socket.emit('minigame:move', { action: 'PASS' });
    row.appendChild(b);
    box.appendChild(row);
    box.appendChild(turnBadge(mg.myTurn, '지금 내가 들고 있음'));
  } else if (type === 'PIN') {
    box.appendChild(el('div', 'desc', `안전핀을 번갈아 뽑습니다. 지금까지 ${mg.pulls}번 뽑았습니다. 언제 터질지는 아무도 모릅니다.`));
    const row = el('div', 'btnRow');
    const b = el('button', 'action danger', '핀 뽑기');
    b.disabled = !mg.myTurn;
    b.onclick = () => socket.emit('minigame:move', { action: 'PULL' });
    row.appendChild(b);
    box.appendChild(row);
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
    if (guessCountRound !== state.round) { guessCountRound = state.round; guessCountRevealUntil = Date.now() + 4000; }
    const remaining = guessCountRevealUntil - Date.now();
    if (remaining > 0 && mg.myGuess == null) {
      box.appendChild(el('div', 'desc', '촛불 개수를 잘 봐두세요 — 잠시 후 화면에서 사라집니다.'));
      box.appendChild(el('div', 'candleDisplay', '🕯️'.repeat(mg.trueCount)));
      box.appendChild(el('div', 'hint', `${Math.max(1, Math.ceil(remaining / 1000))}초 후 가려집니다`));
    } else if (mg.myGuess == null) {
      box.appendChild(el('div', 'desc', '몇 개였을까요? 가장 가깝게 맞히는 쪽이 이깁니다.'));
      const row = el('div', 'btnRow');
      for (let n = 0; n <= 12; n++) {
        const b = el('button', 'action', String(n));
        b.onclick = () => socket.emit('minigame:move', { guess: n });
        row.appendChild(b);
      }
      box.appendChild(row);
    } else {
      box.appendChild(el('div', 'desc', `내 추측: ${mg.myGuess}개 — 상대 추측을 기다리는 중...`));
    }
  } else if (type === 'PARITY') {
    box.appendChild(el('div', 'desc', `당신은 이번 판 "${mg.role === 'ODD' ? '홀' : '짝'}" 담당입니다. 두 사람이 낸 숫자의 합이 ${mg.role === 'ODD' ? '홀수' : '짝수'}면 당신이 이깁니다.`));
    const row = el('div', 'btnRow');
    [1, 2, 3].forEach((n) => {
      const b = el('button', 'action' + (mg.myPick === n ? ' primary' : ''), String(n));
      b.disabled = !mg.waitingForMe;
      b.onclick = () => socket.emit('minigame:move', { n });
      row.appendChild(b);
    });
    box.appendChild(row);
  } else if (type === 'SHOWDOWN') {
    box.appendChild(el('div', 'desc', '1~10 중 배짱 수치를 정하세요. 더 높은 쪽이 이깁니다 (동률이면 다시 냅니다).'));
    const row = el('div', 'btnRow');
    for (let n = 1; n <= 10; n++) {
      const b = el('button', 'action' + (mg.myPick === n ? ' primary' : ''), String(n));
      b.disabled = !mg.waitingForMe;
      b.onclick = () => socket.emit('minigame:move', { n });
      row.appendChild(b);
    }
    box.appendChild(row);
  } else if (type === 'BANK') {
    box.appendChild(el('div', 'desc', `숫자야구입니다. 각자 나만의 금고 번호(0~9 중 서로 다른 숫자 ${mg.digits}개)를 정하고, 번갈아 상대의 번호를 추리하세요. ⚡스트라이크=숫자·자리 모두 일치, ・볼=숫자만 일치, 아웃=둘 다 없음.`));

    const makeDigitInput = (buttonLabel, onSubmit) => {
      const row = el('div', 'btnRow');
      const inp = document.createElement('input');
      inp.type = 'text'; inp.maxLength = mg.digits; inp.className = 'bankInput'; inp.placeholder = `숫자 ${mg.digits}개`;
      inp.inputMode = 'numeric';
      const btn = el('button', 'action primary', buttonLabel);
      btn.onclick = () => {
        const digits = inp.value.trim().split('').map((ch) => Number(ch));
        if (digits.length !== mg.digits || digits.some((d) => Number.isNaN(d) || d < 0 || d > 9) || new Set(digits).size !== digits.length) {
          addLog(`⚠ 서로 다른 숫자 ${mg.digits}개를 입력하세요.`);
          return;
        }
        onSubmit(digits);
        inp.value = '';
      };
      row.appendChild(inp); row.appendChild(btn);
      return row;
    };
    const outcomeLabel = (h) => (h.strikes === 0 && h.balls === 0 ? '아웃' : `⚡${h.strikes} ・${h.balls}`);

    if (!mg.mySecretSet) {
      box.appendChild(el('div', 'hint', '먼저 나만의 금고 번호를 정하세요 (상대에게는 보이지 않습니다).'));
      box.appendChild(makeDigitInput('내 번호로 정하기', (digits) => socket.emit('minigame:move', { secret: digits })));
    } else if (!mg.oppSecretSet) {
      box.appendChild(el('div', 'hint', '내 번호 설정 완료. 상대가 번호를 정하는 중입니다...'));
    } else {
      const dual = el('div', 'bankDual');
      const mine = el('div', 'bankCol');
      mine.appendChild(el('div', 'bankColTitle', '내가 상대 번호에 시도'));
      (mg.myGuesses || []).slice().reverse().forEach((h) => {
        mine.appendChild(el('div', 'bankRow', `<b>${h.guess.join('')}</b> → ${outcomeLabel(h)}`));
      });
      const theirs = el('div', 'bankCol');
      theirs.appendChild(el('div', 'bankColTitle', '상대가 내 번호에 시도'));
      (mg.oppGuesses || []).slice().reverse().forEach((h) => {
        theirs.appendChild(el('div', 'bankRow', `<b>${h.guess.join('')}</b> → ${outcomeLabel(h)}`));
      });
      dual.appendChild(mine); dual.appendChild(theirs);
      box.appendChild(dual);

      if (mg.myTurn) {
        box.appendChild(el('div', 'hint', `상대의 금고 번호를 추리하세요 (서로 다른 숫자 ${mg.digits}개).`));
        box.appendChild(makeDigitInput('번호 불러보기', (digits) => socket.emit('minigame:move', { guess: digits })));
      } else {
        box.appendChild(el('div', 'hint', '상대의 차례입니다...'));
      }
    }
  }
  p.appendChild(box);
  return p;
}
function turnBadge(myTurn, label) {
  const b = el('span', 'badge ' + (myTurn ? 'turn' : 'wait'), myTurn ? (label || '내 차례') : '상대 차례');
  return b;
}

// -------- 액션 UI --------
function renderActionPanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, '본행동'));
  if (!state.isMyTurn) {
    p.appendChild(el('p', 'hint', '상대의 턴입니다. 잠시 기다려주세요...'));
    return p;
  }
  p.appendChild(el('p', 'badge turn', '내 턴 — 행동 1개를 선택하세요'));

  const row = el('div', 'btnRow');
  const modes = [
    ['ITEM_GET', '아이템 얻기'],
    ['CLUE', '단서 얻기'],
    ['OPEN', '술잔 고르기'],
  ];
  if (state.me.items.length > 0) modes.push(['ITEM_USE', '아이템 사용']);
  modes.forEach(([m, label]) => {
    const b = el('button', 'action' + (actionMode === m ? ' primary' : ''), label);
    b.onclick = () => { actionMode = actionMode === m ? null : m; itemUseType = null; render(lastState); };
    row.appendChild(b);
  });
  p.appendChild(row);

  if (actionMode === 'ITEM_GET') p.appendChild(renderItemGetChoice(state));
  if (actionMode === 'CLUE') p.appendChild(renderClueChoice(state));
  if (actionMode === 'OPEN') p.appendChild(el('p', 'hint', '왼쪽 "내 처소" 그리드에서 마실 술잔을 클릭하세요.'));
  if (actionMode === 'ITEM_USE') p.appendChild(renderItemUseChoice(state));

  return p;
}

function renderItemGetChoice(state) {
  const box = el('div', 'mgBox');
  box.appendChild(el('div', 'desc', `보유 중: ${state.me.items.length}/${state.config.INVENTORY_CAP}`));
  const grid = el('div', 'itemCardGrid');
  const descs = {
    SPOON: '지정한 칸 1개를 열지 않고 독 여부만 확인',
    NOSE: '행 또는 열 하나의 독 개수만 확인',
    WARD: '다음 독 1회를 자동으로 무효화',
    SWAP: '상대의 다음 단서 결과를 조작',
  };
  const full = state.me.items.length >= state.config.INVENTORY_CAP;
  Object.keys(state.itemNames).forEach((k) => {
    const card = el('div', 'itemCard' + (full ? ' disabled' : ''));
    card.appendChild(el('div', 'itemCardIcon', ITEM_EMOJI[k] || '✨'));
    const body = el('div', 'itemCardBody');
    body.appendChild(el('div', 'itemCardTitle', state.itemNames[k]));
    body.appendChild(el('div', 'itemCardDesc', descs[k]));
    card.appendChild(body);
    if (!full) card.onclick = () => { socket.emit('action:item_get', { itemType: k }); actionMode = null; };
    grid.appendChild(card);
  });
  box.appendChild(grid);
  return box;
}

function renderClueChoice(state) {
  const box = el('div', 'mgBox');
  box.appendChild(el('div', 'desc', '어떤 종류의 단서를 원하시나요? (정확한 좌표 / 행 / 열 / 구역 / 인접 중 무작위로 알려줍니다)'));
  const row = el('div', 'btnRow');
  Object.keys(state.clueCatNames).forEach((cat) => {
    const b = el('button', 'action', state.clueCatNames[cat]);
    b.onclick = () => { socket.emit('action:clue', { category: cat }); actionMode = null; };
    row.appendChild(b);
  });
  box.appendChild(row);
  return box;
}

function renderItemUseChoice(state) {
  const box = el('div', 'mgBox');
  if (state.me.items.length === 0) {
    box.appendChild(el('div', 'desc', '보유한 아이템이 없습니다.'));
    return box;
  }
  box.appendChild(el('div', 'desc', '사용할 아이템을 고르세요.'));
  const row = el('div', 'btnRow');
  const uniq = [...new Set(state.me.items)];
  uniq.forEach((k) => {
    const count = state.me.items.filter((x) => x === k).length;
    const b = el('button', 'action' + (itemUseType === k ? ' primary' : ''), `${state.itemNames[k]} (${count})`);
    b.onclick = () => {
      itemUseType = k;
      if (k === 'WARD' || k === 'SWAP') {
        socket.emit('action:item_use', { itemType: k });
        actionMode = null; itemUseType = null;
      } else {
        render(lastState);
      }
    };
    row.appendChild(b);
  });
  box.appendChild(row);

  if (itemUseType === 'SPOON') {
    box.appendChild(el('div', 'hint', '왼쪽 "내 처소" 그리드에서 확인할 칸을 클릭하세요.'));
  }
  if (itemUseType === 'NOSE') {
    box.appendChild(renderNosePicker(state));
  }
  return box;
}

function renderNosePicker(state) {
  const wrap = el('div', null, '');
  wrap.appendChild(el('div', 'hint', '확인할 행 또는 열을 고르세요.'));
  const row1 = el('div', 'btnRow');
  row1.appendChild(el('span', 'hint', '행: '));
  for (let i = 0; i < state.config.GRID; i++) {
    const b = el('button', 'action', String(i + 1));
    b.onclick = () => { socket.emit('action:item_use', { itemType: 'NOSE', target: { axis: 'row', index: i } }); actionMode = null; itemUseType = null; };
    row1.appendChild(b);
  }
  wrap.appendChild(row1);
  const row2 = el('div', 'btnRow');
  row2.appendChild(el('span', 'hint', '열: '));
  for (let i = 0; i < state.config.GRID; i++) {
    const b = el('button', 'action', String(i + 1));
    b.onclick = () => { socket.emit('action:item_use', { itemType: 'NOSE', target: { axis: 'col', index: i } }); actionMode = null; itemUseType = null; };
    row2.appendChild(b);
  }
  wrap.appendChild(row2);
  return wrap;
}

// -------- 보상 사용 UI --------
function renderRewardPanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, '🎁 보상 사용'));
  const box = el('div', 'mgBox');
  const r = state.myReward;

  if (r.type === 'FLASH_ALL') {
    const remaining = r.expiresAt ? Math.max(0, Math.ceil((r.expiresAt - Date.now()) / 1000)) : 0;
    box.appendChild(el('div', 'desc', `원할 때 한 번, 상대 처소 전체를 0.1초간 볼 수 있습니다. 남은 시간: ${remaining}초`));
    const b = el('button', 'action primary', '⚡ 지금 섬광 정찰');
    b.onclick = () => socket.emit('reward:use', {});
    box.appendChild(b);
  } else if (r.type === 'PEEK_CELL') {
    box.appendChild(el('div', 'desc', '상대 처소에서 확인할 칸 1개를 고르세요 (아래는 상대 처소의 좌표판입니다 — 내용은 보이지 않습니다).'));
    const grid = el('div', 'grid6 pickerGrid');
    for (let rr = 0; rr < state.config.GRID; rr++) {
      for (let cc = 0; cc < state.config.GRID; cc++) {
        const cell = el('div', 'cell pickable');
        cell.onclick = () => socket.emit('reward:use', { row: rr, col: cc });
        grid.appendChild(cell);
      }
    }
    box.appendChild(grid);
  } else if (r.type === 'ROW_COUNT' || r.type === 'COL_COUNT') {
    const axisLabel = r.type === 'ROW_COUNT' ? '행' : '열';
    box.appendChild(el('div', 'desc', `상대 처소에서 확인할 술잔 종류를 먼저 고른 뒤, ${axisLabel} 번호를 고르세요.`));
    const typeRow = el('div', 'btnRow');
    Object.keys(state.clueCatNames).forEach((cat) => {
      const b = el('button', 'action' + (rewardChosenType === cat ? ' primary' : ''), state.clueCatNames[cat]);
      b.onclick = () => { rewardChosenType = cat; render(lastState); };
      typeRow.appendChild(b);
    });
    box.appendChild(typeRow);
    const idxRow = el('div', 'btnRow');
    for (let i = 0; i < state.config.GRID; i++) {
      const b = el('button', 'action', String(i + 1));
      b.disabled = !rewardChosenType;
      b.onclick = () => {
        if (!rewardChosenType) return;
        socket.emit('reward:use', { index: i, targetType: rewardChosenType });
        rewardChosenType = null;
      };
      idxRow.appendChild(b);
    }
    box.appendChild(idxRow);
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
  mine.appendChild(el('p', 'hint', `최종 점수: <b>${state.me.finalScore}</b> (술잔 점수 ${state.me.score} − 독 ${state.me.poison}개 × ${state.config.POISON_PENALTY})`));
  mine.appendChild(buildRevealGrid(state.me.room));
  cols.appendChild(mine);

  if (state.opp) {
    const opp = el('div', 'col');
    opp.appendChild(el('h3', null, `상대 처소 최종 (${state.opp.name})`));
    opp.appendChild(statGrid(state.opp));
    opp.appendChild(el('p', 'hint', `최종 점수: <b>${state.opp.finalScore}</b> (술잔 점수 ${state.opp.score} − 독 ${state.opp.poison}개 × ${state.config.POISON_PENALTY})`));
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
      const cell = el('div', 'cell opened ' + data.type, cellIconSVG(data.type));
      grid.appendChild(cell);
    }
  }
  return grid;
}

setInterval(() => {
  if (!lastState) return;
  // 촛불 개수 맞히기: 공개 시간이 지나면 새 서버 상태 없이도 "추측 입력" 화면으로 넘어가야 함
  if (lastState.phase === 'ROUND_MINIGAME' && lastState.minigame && lastState.minigame.type === 'GUESS_COUNT'
      && lastState.minigame.public.myGuess == null && guessCountRevealUntil && Date.now() >= guessCountRevealUntil) {
    render(lastState);
    return;
  }
  // 섬광 정찰 보상: 남은 시간 카운트다운 갱신
  if (lastState.phase === 'ROUND_ACTION' && lastState.myReward && lastState.myReward.type === 'FLASH_ALL' && !lastState.myReward.used) {
    render(lastState);
  }
}, 500);
