// 가문의 문장 조각을 "드래그 앤 드롭"으로 조립 구역의 원하는 칸에 놓는 UI(public/client.js의
// crestBoardWidget)를 실제 브라우저(Chromium)에서 검증하는 스크립트. 서버 로직 자체는
// test_crest.js/test_sim.js가 crest:move를 직접 emit해서 검증하지만, 이 스크립트는 "실제
// 마우스 드래그 이벤트가 올바른 crest:move를 만들어내는지"까지 확인한다 — (1) 보유 조각을
// 원하는 구역의 원하는 칸으로 드래그해서 새로 놓기, (2) 이미 놓은 조각을 다시 보유 목록으로
// 드래그해서 빼내기(무료 회수), 두 경로 모두 체크한다. 플레이어 A는 진짜 브라우저 페이지
// (드래그까지 실제로 수행)로, 플레이어 B는 socket.io-client 봇으로 움직여 게임을 진행시킨다.
//
// 사전 조건: node server.js 가 http://localhost:3000 에서 실행 중이어야 하고, 실행 전에
// admin:reset으로 방을 비워둬야 한다(다른 테스트가 남긴 플레이어가 있으면 'full'로 거부됨).
const { chromium } = require('playwright');
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';

function connectBotB() {
  const socket = io(URL, { reconnection: false, forceNew: true, query: { slot: 'B' } });
  let setupSent = false, midSetupSent = false;
  socket.on('state', (state) => {
    if (state.phase === 'SETUP' && !setupSent) {
      setupSent = true;
      setTimeout(() => socket.emit('setup:confirm', { cells: [{ row: 3, col: 5 }, { row: 0, col: 5 }, { row: 2, col: 1 }] }), 50);
    }
    if (state.phase === 'MID_SETUP' && !midSetupSent && state.oppOpenedMask) {
      midSetupSent = true;
      const mask = state.oppOpenedMask;
      const candidates = [];
      for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) candidates.push({ row: r, col: c });
      socket.emit('mid_setup:confirm', { cells: candidates.slice(0, state.config.POISON_MID) });
    }
    if (state.phase !== 'MID_SETUP') midSetupSent = false;
    if (state.phase === 'ROUND_ACTION' && state.isMyTurn && state.opensRemaining > 0) {
      const room = state.me.room;
      const candidates = [];
      for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened && !room[r][c].locked) candidates.push({ row: r, col: c });
      if (candidates.length) setTimeout(() => socket.emit('action:open', candidates[0]), 30);
    }
    if (state.phase === 'ROUND_MINIGAME' && state.minigame && state.minigame.public) {
      const mg = state.minigame.public, type = state.minigame.type;
      setTimeout(() => {
        if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 });
        if (type === 'HAND' && mg.waitingForMe) socket.emit('minigame:move', { hand: 'L' });
        if (type === 'REFLEX' && !mg.myClicked && mg.goFired) socket.emit('minigame:move', { action: 'CLICK' });
        if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
        if (type === 'PIN' && mg.myTurn) {
          const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
          if (remaining.length) socket.emit('minigame:move', { action: 'PICK', index: remaining[0] });
        }
        if (type === 'SIGIL' && mg.waitingForMe) socket.emit('minigame:move', { pick: ['SWORD', 'POISON', 'SHIELD'][Math.floor(Math.random() * 3)] });
        if (type === 'GUESS_COUNT' && mg.myGuess == null) socket.emit('minigame:move', { guess: mg.trueCount });
        if (type === 'CARD_DUEL' && mg.waitingForMe) socket.emit('minigame:move', { arrangement: [1, 2, 3].sort(() => Math.random() - 0.5) });
        if (type === 'PACT' && mg.waitingForMe) socket.emit('minigame:move', { action: 'SILENT' });
        if (type === 'BANK') socket.emit('minigame:move', { guess: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3) });
      }, 40);
    }
    if (state.phase === 'ROUND_ACTION' && state.myReward && !state.myReward.type && state.myReward.choices) {
      const c = state.myReward.choices[0];
      if (c) setTimeout(() => socket.emit('reward:choose', { type: c.type }), 30);
    }
    if (state.phase === 'ROUND_ACTION' && state.myReward && state.myReward.type && !state.myReward.used) {
      setTimeout(() => {
        if (state.myReward.type === 'FLASH_ALL') socket.emit('reward:use', {});
        else if (state.myReward.type === 'PEEK_CELL') socket.emit('reward:use', { row: 0, col: 0 });
        else socket.emit('reward:use', { targetType: 'GEM' });
      }, 40);
    }
  });
  return socket;
}

(async () => {
  await new Promise((resolve) => {
    const s = io(URL, { reconnection: false, forceNew: true });
    s.on('connect', () => { s.emit('admin:reset'); setTimeout(() => { s.close(); resolve(); }, 300); });
  });

  connectBotB();

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    // 이 샌드박스의 outbound 프록시가 localhost 요청까지 가로채는 경우가 있어, 로컬 서버
    // 테스트에는 프록시가 불필요하므로 명시적으로 우회한다.
    proxy: { server: 'direct://', bypass: 'localhost,127.0.0.1' },
    args: ['--no-proxy-server'],
  });
  const page = await browser.newPage({ viewport: { width: 500, height: 900 } });
  page.on('pageerror', (err) => console.log('[PAGE EXCEPTION]', err.message));
  await page.goto(URL + '/pick/A');

  // 플레이어 A(브라우저)도 socket.emit을 직접 호출해 설치/미니게임을 빠르게 통과시킨다.
  // client.js는 module이 아닌 일반 스크립트라 top-level let/const(socket, lastState)가
  // page.evaluate와 같은 실행 컨텍스트에서 이름 그대로 보인다(devtools 콘솔과 동일한 원리).
  async function getState() { return await page.evaluate(() => (typeof lastState !== 'undefined' ? lastState : null)); }

  async function driveUntilHeldPiece(maxSteps) {
    for (let i = 0; i < maxSteps; i++) {
      const s = await getState();
      if (!s) { await page.waitForTimeout(100); continue; }
      if (s.phase === 'SETUP') {
        await page.evaluate(() => socket.emit('setup:confirm', { cells: [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 3, col: 0 }] }));
      } else if (s.phase === 'MID_SETUP' && s.oppOpenedMask) {
        const mask = s.oppOpenedMask;
        const candidates = [];
        for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) candidates.push({ row: r, col: c });
        await page.evaluate(({ cells }) => socket.emit('mid_setup:confirm', { cells }), { cells: candidates.slice(0, s.config.POISON_MID) });
      } else if (s.phase === 'ROUND_MINIGAME' && s.minigame && s.minigame.public) {
        const mg = s.minigame.public, type = s.minigame.type;
        await page.evaluate(({ type, mg }) => {
          if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 });
          if (type === 'HAND' && mg.waitingForMe) socket.emit('minigame:move', { hand: 'L' });
          if (type === 'REFLEX' && !mg.myClicked && mg.goFired) socket.emit('minigame:move', { action: 'CLICK' });
          if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
          if (type === 'PIN' && mg.myTurn) {
            const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
            if (remaining.length) socket.emit('minigame:move', { action: 'PICK', index: remaining[0] });
          }
          if (type === 'SIGIL' && mg.waitingForMe) socket.emit('minigame:move', { pick: ['SWORD', 'POISON', 'SHIELD'][Math.floor(Math.random() * 3)] });
          if (type === 'GUESS_COUNT' && mg.myGuess == null) socket.emit('minigame:move', { guess: mg.trueCount });
          if (type === 'CARD_DUEL' && mg.waitingForMe) socket.emit('minigame:move', { arrangement: [1, 2, 3].sort(() => Math.random() - 0.5) });
          if (type === 'PACT' && mg.waitingForMe) socket.emit('minigame:move', { action: 'SILENT' });
          if (type === 'BANK') socket.emit('minigame:move', { guess: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3) });
        }, { type, mg });
      } else if (s.phase === 'ROUND_ACTION' && s.myReward && !s.myReward.type && s.myReward.choices) {
        const c = s.myReward.choices[0];
        if (c) await page.evaluate(({ t }) => socket.emit('reward:choose', { type: t }), { t: c.type });
      } else if (s.phase === 'ROUND_ACTION' && s.myReward && s.myReward.type && !s.myReward.used) {
        await page.evaluate(({ t }) => {
          if (t === 'FLASH_ALL') socket.emit('reward:use', {});
          else if (t === 'PEEK_CELL') socket.emit('reward:use', { row: 0, col: 0 });
          else socket.emit('reward:use', { targetType: 'GEM' });
        }, { t: s.myReward.type });
      } else if (s.phase === 'ROUND_ACTION' && s.opensRemaining > 0) {
        if (s.me.heldPieces && s.me.heldPieces.length > 0) {
          console.log(`[held piece ready] round=${s.round} held=${JSON.stringify(s.me.heldPieces)}`);
          return true; // 조각 확보 완료 — 이제부터는 실제 UI 드래그로 검증한다
        }
        const room = s.me.room;
        const candidates = [];
        for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened && !room[r][c].locked) candidates.push({ row: r, col: c });
        if (candidates.length) await page.evaluate(({ row, col }) => socket.emit('action:open', { row, col }), candidates[0]);
      }
      if (s.phase === 'END') { console.log('[unexpected] game ended before a held piece appeared'); return false; }
      await page.waitForTimeout(120);
    }
    return false;
  }

  // 상대(봇 B)가 계속 자기 턴을 진행하며 상태 브로드캐스트를 일으키는 통에(render()가 매번
  // 전체 DOM을 다시 그림) 정확히 그 순간에 드래그 제스처가 겹치면 Playwright의 dragTo가
  // "안정된 상태"를 기다리다 타임아웃할 수 있다 — 실제 두 사람이 각자 기기로 플레이할 땐
  // 겪지 않는, 이 테스트 특유의 소음이다. 그래서 실패하면 잠깐 쉬었다 다시 시도한다.
  async function dragWithRetry(sourceSelectorFn, targetSelectorFn, attempts = 4) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        await sourceSelectorFn().dragTo(targetSelectorFn(), { timeout: 6000 });
        return true;
      } catch (e) {
        lastErr = e;
        await page.waitForTimeout(500);
      }
    }
    console.log('(드래그 재시도 끝까지 실패:', lastErr && lastErr.message.split('\n')[0], ')');
    return false;
  }

  // "보유 → 구역"으로 새로 놓는 첫 드래그는 행동 예산을 쓰는 이동이다 — 만약 하필 그게
  // 이번 라운드의 마지막 행동이었다면(상대 봇 B도 이미 예산을 다 썼다면), 드롭 직후 곧바로
  // 다음 라운드의 미니게임으로 넘어가면서 조립 보드(.crestBoard) 자체가 화면에서 잠깐
  // 사라질 수 있다. 실제 두 사람이 플레이할 때도 있을 수 있는 정상적인 전환이므로, 두 번째
  // (회수) 드래그를 시도하기 전에 ROUND_ACTION으로 돌아올 때까지 기다려주고, 그 사이 뜨는
  // 미니게임엔 자동으로 대답해 넘긴다.
  async function waitForRoundActionResume(maxSteps) {
    for (let i = 0; i < maxSteps; i++) {
      const s = await getState();
      if (!s) { await page.waitForTimeout(100); continue; }
      if (s.phase === 'ROUND_ACTION') return true;
      if (s.phase === 'END') return false;
      if (s.phase === 'ROUND_MINIGAME' && s.minigame && s.minigame.public) {
        const mg = s.minigame.public, type = s.minigame.type;
        await page.evaluate(({ type, mg }) => {
          if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 });
          if (type === 'HAND' && mg.waitingForMe) socket.emit('minigame:move', { hand: 'L' });
          if (type === 'REFLEX' && !mg.myClicked && mg.goFired) socket.emit('minigame:move', { action: 'CLICK' });
          if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
          if (type === 'PIN' && mg.myTurn) {
            const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
            if (remaining.length) socket.emit('minigame:move', { action: 'PICK', index: remaining[0] });
          }
          if (type === 'SIGIL' && mg.waitingForMe) socket.emit('minigame:move', { pick: ['SWORD', 'POISON', 'SHIELD'][Math.floor(Math.random() * 3)] });
          if (type === 'GUESS_COUNT' && mg.myGuess == null) socket.emit('minigame:move', { guess: mg.trueCount });
          if (type === 'CARD_DUEL' && mg.waitingForMe) socket.emit('minigame:move', { arrangement: [1, 2, 3].sort(() => Math.random() - 0.5) });
          if (type === 'PACT' && mg.waitingForMe) socket.emit('minigame:move', { action: 'SILENT' });
          if (type === 'BANK') socket.emit('minigame:move', { guess: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3) });
        }, { type, mg });
      }
      await page.waitForTimeout(120);
    }
    return false;
  }

  const got = await driveUntilHeldPiece(400);
  if (!got) { console.log('FAIL: 문장 조각을 확보하지 못했습니다(타임아웃)'); await browser.close(); process.exit(1); }

  await page.waitForTimeout(300);
  await page.locator('.crestBoard').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'shot_before_drag.png', fullPage: false });

  const before = await getState();
  const piece = before.me.heldPieces[0];
  let targetZoneIndex = before.me.zones.findIndex((z) => z.crestId === piece.crestId);
  if (targetZoneIndex === -1) targetZoneIndex = before.me.zones.findIndex((z) => z.crestId === null);
  // 어느 칸(slot)에 놓을지는 플레이어가 자유롭게 고르는 부분 — 일부러 3번째 칸(인덱스 2, 좌하단)을
  // 선택해서 "자동으로 정해진 칸이 아니라 실제로 내가 고른 칸에 놓이는지"를 검증한다.
  const targetSlot = 2;
  console.log('드래그 대상:', JSON.stringify(piece), `→ 구역 ${targetZoneIndex} / 칸 ${targetSlot}`);

  // 1) 실제 드래그 앤 드롭 수행: 보유 조각을 목표 구역의 목표 칸으로 끌어다 놓는다.
  const getHeldFirst = () => page.locator('.crestHeldItem').first();
  const getTargetSlot = () => page.locator('.crestZoneBox').nth(targetZoneIndex).locator('.crestZoneSlot').nth(targetSlot);
  await dragWithRetry(getHeldFirst, getTargetSlot);
  await page.waitForTimeout(400);

  const after = await getState();
  // 드롭 직후 서버 상태가 들어와 화면 전체가 다시 그려지는 타이밍과 겹치면 방금 잡은 핸들이
  // 이미 교체된 DOM을 가리켜 "not attached" 에러가 날 수 있으므로, 실패해도 무시하고 계속한다
  // (스크린샷은 눈으로 확인하는 보조 자료일 뿐, PASS/FAIL 판정은 서버 state로만 한다).
  try {
    await page.locator('.crestBoard').scrollIntoViewIfNeeded({ timeout: 2000 });
  } catch (e) { console.log('(스크롤 생략:', e.message.split('\n')[0], ')'); }
  await page.screenshot({ path: 'shot_after_drag.png', fullPage: false });

  const placedOk = after.me.heldPieces.length === before.me.heldPieces.length - 1 &&
    after.me.zones[targetZoneIndex].slots[targetSlot] === piece.piecePos;
  console.log(placedOk ? 'PASS: 드래그로 조각이 원하는 칸에 배치됨' : 'FAIL: 드래그 후 원하는 칸에 배치되지 않음');
  console.log('배치 전 zones:', JSON.stringify(before.me.zones), '/ 배치 후:', JSON.stringify(after.me.zones));

  if (!placedOk) { await browser.close(); process.exit(1); }

  const resumed = await waitForRoundActionResume(200);
  if (!resumed) { console.log('FAIL: 회수 드래그를 시도하기 전에 게임이 끝나버렸습니다'); await browser.close(); process.exit(1); }

  // 2) 방금 놓은 조각을 다시 "보유 목록"으로 드래그해서 무료 회수가 되는지 검증한다 —
  //    이전엔 "한 번 놓으면 못 뺀다"는 규칙이었지만, 이번 변경으로 언제든 뺄 수 있어야 한다.
  const getHeldRow = () => page.locator('.crestHeldRow');
  await dragWithRetry(getTargetSlot, getHeldRow);
  await page.waitForTimeout(400);
  const afterUndo = await getState();
  try {
    await page.locator('.crestBoard').scrollIntoViewIfNeeded({ timeout: 2000 });
  } catch (e) { /* 무시 — 스크린샷은 보조 자료일 뿐 */ }
  await page.screenshot({ path: 'shot_after_undo.png', fullPage: false });

  const undoOk = afterUndo.me.heldPieces.length === after.me.heldPieces.length + 1 &&
    afterUndo.me.heldPieces.some((p) => p.crestId === piece.crestId && p.piecePos === piece.piecePos) &&
    afterUndo.me.zones[targetZoneIndex].slots[targetSlot] == null;
  console.log(undoOk ? 'PASS: 드래그로 조각을 보유 목록으로 다시 뺌' : 'FAIL: 회수 드래그 후에도 구역에 남아있음');
  console.log('회수 후 zones:', JSON.stringify(afterUndo.me.zones), '/ heldPieces:', JSON.stringify(afterUndo.me.heldPieces));

  await browser.close();
  process.exit(placedOk && undoOk ? 0 : 1);
})();
