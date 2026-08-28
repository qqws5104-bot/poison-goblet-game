const socket = io();
const app = document.getElementById('app');
const statusBar = document.getElementById('statusBar');
const logBox = document.getElementById('log');

let lastState = null;
let setupSelection = []; // [{row,col}]
let actionMode = null; // null | 'ITEM_GET' | 'CLUE' | 'OPEN' | 'ITEM_USE'
let itemUseType = null; // when actionMode==='ITEM_USE', which item chosen (awaiting target if needed)
let lastClueResult = null;

const CELL_NAME = { P: '독', G: '금', S: '은', A: '해독', E: '' };

function addLog(msg) {
  const div = document.createElement('div');
  div.textContent = msg;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

socket.on('log', ({ msg }) => addLog(msg));
socket.on('error', ({ message }) => addLog('⚠ ' + message));
socket.on('full', () => { app.innerHTML = '<div class="panel center"><p>이미 두 명이 접속해 있습니다. 이 프로토타입은 2인 전용입니다.</p></div>'; });
socket.on('clueResult', ({ text }) => { lastClueResult = text; addLog('🔎 ' + text); render(lastState); });

socket.on('state', (state) => {
  lastState = state;
  render(state);
});

document.getElementById('btnReset').onclick = () => { if (confirm('전체 게임 상태를 초기화할까요? (두 플레이어 모두 다시 접속해야 할 수 있습니다)')) socket.emit('admin:reset'); };
document.getElementById('btnEnd').onclick = () => { if (confirm('지금 즉시 게임을 종료할까요?')) socket.emit('admin:end'); };

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function render(state) {
  if (!state) return;
  renderStatusBar(state);
  app.innerHTML = '';
  if (state.phase === 'LOBBY') return renderLobby(state);
  if (state.phase === 'SETUP') return renderSetup(state);
  if (state.phase === 'END') return renderEnd(state);
  return renderMain(state);
}

function renderStatusBar(state) {
  const t = state.startTime ? Math.max(0, Math.floor(state.timeLimit - (Date.now() - state.startTime) / 1000)) : state.timeLimit;
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  statusBar.innerHTML = `
    <span>나: <b>${state.me ? state.me.name : '-'}</b></span>
    <span>상대: <b>${state.opp ? state.opp.name : '대기 중'}</b></span>
    <span>라운드: <b>${state.round}</b></span>
    <span>남은시간: <b>${state.phase === 'ROUND_MINIGAME' || state.phase === 'ROUND_ACTION' ? mm + ':' + ss : '--:--'}</b></span>
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

  // 오른쪽: 미니게임 / 액션
  const right = el('div', 'col');
  if (state.phase === 'ROUND_MINIGAME') right.appendChild(renderMinigamePanel(state));
  if (state.phase === 'ROUND_ACTION') right.appendChild(renderActionPanel(state));
  cols.appendChild(right);

  app.appendChild(cols);
}

function renderStatsPanel(state) {
  const p = el('div', 'panel');
  p.appendChild(el('h2', null, '상태'));
  const wrap = el('div', 'cols');

  const mine = el('div', 'col');
  mine.appendChild(el('h3', null, `내 처소 (${state.me.name})`));
  mine.appendChild(statGrid(state.me));
  mine.appendChild(el('p', 'hint', `아이템: ${state.me.items.length ? state.me.items.map((i) => state.itemNames[i]).join(', ') : '없음'} ${state.me.shield ? ' · 🛡 부적 활성' : ''}`));
  wrap.appendChild(mine);

  if (state.opp) {
    const opp = el('div', 'col');
    opp.appendChild(el('h3', null, `상대 처소 (${state.opp.name}) ${state.opp.connected ? '' : '<span class="hint">(연결 끊김)</span>'}`));
    opp.appendChild(statGrid(state.opp));
    opp.appendChild(el('p', 'hint', `보유 아이템 수: ${state.opp.itemCount}${state.opp.shield ? ' · 🛡 부적 활성' : ''}`));
    wrap.appendChild(opp);
  }
  p.appendChild(wrap);
  return p;
}

function statGrid(p) {
  const g = el('div', 'statgrid');
  g.appendChild(statBox('poison', p.poison, `독 (한도 ${lastState.config.POISON_LIMIT})`));
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
    const box = el('div', 'clueResultBox', '📜 ' + lastClueResult);
    p.appendChild(box);
  }
  const pickMode = state.isMyTurn && (actionMode === 'OPEN' || (actionMode === 'ITEM_USE' && itemUseType === 'SPOON'));
  const grid = el('div', 'grid6');
  for (let r = 0; r < state.config.GRID; r++) {
    for (let c = 0; c < state.config.GRID; c++) {
      const data = state.me.room[r][c];
      const cell = el('div', 'cell');
      if (data.opened) {
        cell.classList.add('opened', data.type);
        cell.textContent = CELL_NAME[data.type];
      } else if (data.type) {
        cell.classList.add('clued');
        cell.textContent = CELL_NAME[data.type] + '?';
      } else {
        cell.textContent = '';
      }
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
  p.appendChild(el('h2', null, `우선권 미니게임: ${state.minigame.name}`));
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
  const row = el('div', 'itemChoice');
  const descs = {
    SPOON: '지정한 칸 1개를 열지 않고 독 여부만 확인',
    NOSE: '행 또는 열 하나의 독 개수만 확인',
    WARD: '다음 독 1회를 자동으로 무효화',
    SWAP: '상대의 다음 단서 결과를 조작',
  };
  Object.keys(state.itemNames).forEach((k) => {
    const wrap = el('div', null, '');
    const b = el('button', 'action', `${state.itemNames[k]} 획득`);
    b.disabled = state.me.items.length >= state.config.INVENTORY_CAP;
    b.onclick = () => { socket.emit('action:item_get', { itemType: k }); actionMode = null; };
    wrap.appendChild(b);
    wrap.appendChild(el('div', 'hint', descs[k]));
    row.appendChild(wrap);
  });
  box.appendChild(row);
  return box;
}

function renderClueChoice(state) {
  const box = el('div', 'mgBox');
  box.appendChild(el('div', 'desc', '어떤 종류의 단서를 원하시나요? (정확한 좌표 / 행 / 열 / 구역 중 무작위로 알려줍니다)'));
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

// ---------------------------- END ----------------------------
function renderEnd(state) {
  const cls = state.winner === 'me' ? 'win' : state.winner === 'opp' ? 'lose' : 'draw';
  const title = state.winner === 'me' ? '👑 왕위를 차지했습니다' : state.winner === 'opp' ? '⚰️ 독배를 피하지 못했습니다' : '무승부 — 두 왕자 모두 살아남았습니다';
  const p = el('div', 'panel');
  const banner = el('div', 'endBanner ' + cls);
  banner.appendChild(el('h2', null, title));
  banner.appendChild(el('p', null, state.endReason || ''));
  p.appendChild(banner);

  const cols = el('div', 'cols');
  const mine = el('div', 'col');
  mine.appendChild(el('h3', null, `내 처소 최종 (${state.me.name})`));
  mine.appendChild(statGrid(state.me));
  mine.appendChild(buildRevealGrid(state.me.room));
  cols.appendChild(mine);

  if (state.opp) {
    const opp = el('div', 'col');
    opp.appendChild(el('h3', null, `상대 처소 최종 (${state.opp.name})`));
    opp.appendChild(statGrid(state.opp));
    if (state.opp.room) opp.appendChild(buildRevealGrid(state.opp.room));
    cols.appendChild(opp);
  }
  p.appendChild(cols);
  p.appendChild(el('p', 'hint', '다시 테스트하려면 아래 "전체 초기화" 버튼을 사용하세요.'));
  app.appendChild(p);
}

function buildRevealGrid(room) {
  const grid = el('div', 'grid6');
  for (let r = 0; r < room.length; r++) {
    for (let c = 0; c < room[r].length; c++) {
      const data = room[r][c];
      const cell = el('div', 'cell opened ' + data.type, CELL_NAME[data.type]);
      grid.appendChild(cell);
    }
  }
  return grid;
}

setInterval(() => { if (lastState && (lastState.phase === 'ROUND_MINIGAME' || lastState.phase === 'ROUND_ACTION')) renderStatusBar(lastState); }, 1000);
