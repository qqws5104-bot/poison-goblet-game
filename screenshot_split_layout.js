// 처소 그리드(왼쪽) + 가문의 문장 조립(오른쪽) 좌우 배치가 실제로 스크롤 없이 한 화면에
// 잘 들어오는지 브라우저 스크린샷으로 확인하기 위한 1회성 스크립트.
// slot('A'/'B')은 소켓 여러 개가 공유할 수 있는 진짜 플레이어 식별자이므로, 봇 소켓으로
// 두 플레이어(A/B)를 빠르게 ROUND_ACTION까지 진행시키고, 그와 별개로 /pick/A 페이지를
// "그냥 구경만 하는 뷰어"로 열어 같은 slot A 상태를 그대로 받아 화면을 캡처한다.
const { chromium } = require('playwright');
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';

function connectBot(slot, opts) {
  opts = opts || {};
  const socket = io(URL, { reconnection: false, forceNew: true, query: { slot } });
  let setupSent = false;
  let lastPhase = null;
  socket.on('connect_error', (e) => console.log(`[${slot}] connect_error`, e.message));
  socket.on('error', (e) => console.log(`[${slot}] server error`, e));
  socket.on('full', () => console.log(`[${slot}] room full!`));
  socket.on('state', (state) => {
    if (state.phase !== lastPhase) { lastPhase = state.phase; console.log(`[${slot}] phase -> ${state.phase}`); }
    if (state.phase === 'SETUP' && !setupSent) {
      setupSent = true;
      setTimeout(() => socket.emit('setup:confirm', { cells: [{ row: 3, col: 5 }, { row: 0, col: 5 }, { row: 2, col: 1 }] }), 50);
    }
    // opts.act === false: 일부러 칸을 열지 않고 ROUND_ACTION 상태에 계속 머물러, 그 사이에
    // 스크린샷을 안정적으로 찍을 수 있게 한다.
    if (opts.act !== false && state.phase === 'ROUND_ACTION' && state.isMyTurn && state.opensRemaining > 0) {
      const room = state.me.room;
      const cands = [];
      for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened && !room[r][c].locked) cands.push({ row: r, col: c });
      if (cands.length) setTimeout(() => socket.emit('action:open', cands[0]), 30);
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
        if (type === 'SIGIL' && mg.itemCounts) {
          let t = null;
          for (const k of ['GOLD', 'SILVER', 'BRONZE']) { if ((mg.myProgress[k] || 0) < (mg.itemCounts[k] || 0)) { t = k; break; } }
          if (t) socket.emit('minigame:move', { tier: t });
        }
        if (type === 'GUESS_COUNT' && mg.myGuess == null) socket.emit('minigame:move', { guess: mg.trueCount });
        if (type === 'DICE' && mg.myResult == null && !mg.myPressed) {
          socket.emit('minigame:move', { action: 'PRESS' });
          setTimeout(() => socket.emit('minigame:move', { action: 'RELEASE' }), 200);
        }
        if (type === 'BANK') socket.emit('minigame:move', { guess: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3) });
      }, 40);
    }
    if (state.phase === 'ROUND_ACTION' && state.myReward && !state.myReward.type && state.myReward.choices) {
      const c = state.myReward.choices[0];
      if (c) setTimeout(() => socket.emit('reward:choose', { type: c.type }), 30);
    }
  });
  return socket;
}

(async () => {
  await new Promise((resolve) => {
    const s = io(URL, { reconnection: false, forceNew: true });
    s.on('connect', () => { s.emit('admin:reset'); setTimeout(() => { s.close(); resolve(); }, 300); });
  });

  connectBot('A', { act: false }); // A는 화면 캡처 대상이므로 일부러 칸을 안 열어 ROUND_ACTION에 머무르게 함
  connectBot('B');

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    proxy: { server: 'direct://', bypass: 'localhost,127.0.0.1' },
    args: ['--no-proxy-server'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => console.log('[PAGE EXCEPTION]', err.message));
  await page.goto(URL + '/pick/A');

  await page.waitForSelector('.roomCrestSplit', { timeout: 15000 });
  await page.screenshot({ path: '/tmp/build/poison_game/screenshot_1280.png', fullPage: false });
  console.log('saved screenshot_1280.png');

  for (const w of [900, 660, 600]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.screenshot({ path: `/tmp/build/poison_game/screenshot_${w}.png`, fullPage: false });
    console.log(`saved screenshot_${w}.png`);
  }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
