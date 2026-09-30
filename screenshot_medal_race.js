// "금은동 쟁탈전"(SIGIL 최신 버전) 화면(금/은/동 버튼 + 진행 현황)이 실제로 어떻게 보이는지
// 확인하기 위한 1회성 스크린샷 스크립트. A는 브라우저 뷰어이자 일부러 첫 버튼(금)을 누르지 않아
// "대기 중" 화면이 유지되게 하고, B는 봇이 계속 진행시켜 A 쪽에서 "상대 진행 X/3"도 함께 보이게 한다.
const { chromium } = require('playwright');
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';

function connectBot(slot, opts) {
  opts = opts || {};
  const socket = io(URL, { reconnection: false, forceNew: true, query: { slot } });
  let setupSent = false, midSetupSent = false;
  socket.on('state', (state) => {
    if (state.phase === 'SETUP' && !setupSent) {
      setupSent = true;
      setTimeout(() => socket.emit('setup:confirm', { cells: [{ row: 3, col: 5 }, { row: 0, col: 5 }, { row: 2, col: 1 }] }), 50);
    }
    if (state.phase === 'MID_SETUP' && !midSetupSent && state.oppOpenedMask) {
      midSetupSent = true;
      const mask = state.oppOpenedMask;
      const cands = [];
      for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) cands.push({ row: r, col: c });
      setTimeout(() => socket.emit('mid_setup:confirm', { cells: cands.slice(0, state.config.POISON_MID) }), 30);
    }
    if (state.phase === 'ROUND_ACTION' && state.isMyTurn && state.opensRemaining > 0) {
      const room = state.me.room;
      const cands = [];
      for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened && !room[r][c].locked) cands.push({ row: r, col: c });
      if (cands.length) setTimeout(() => socket.emit('action:open', cands[0]), 30);
    }
    if (state.phase === 'ROUND_MINIGAME' && state.minigame && state.minigame.public) {
      const mg = state.minigame.public, type = state.minigame.type;
      setTimeout(() => {
        if (type === 'SIGIL') {
          // opts.advance === true인 봇(B)만 실제로 진행시키고, A는 한 걸음도 누르지 않아
          // "금" 버튼이 눌리길 기다리는 첫 화면 그대로 유지된다. 대신 B가 한 걸음 진행해서
          // 화면에 "상대 1/3" 같은 진행 현황이 뜨는 것도 함께 캡처한다.
          if (opts.advance && (mg.myProgress.GOLD || 0) < (mg.itemCounts.GOLD || 0)) {
            socket.emit('minigame:move', { tier: 'GOLD' });
          }
          return;
        }
        if (type === 'NIM' && mg.myTurn) socket.emit('minigame:move', { n: 1 });
        if (type === 'HAND' && mg.waitingForMe) socket.emit('minigame:move', { hand: 'L' });
        if (type === 'REFLEX' && !mg.myClicked && mg.goFired) socket.emit('minigame:move', { action: 'CLICK' });
        if (type === 'BOMB' && mg.myTurn) socket.emit('minigame:move', { action: 'PASS' });
        if (type === 'PIN' && mg.myTurn) {
          const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
          if (remaining.length) socket.emit('minigame:move', { action: 'PICK', index: remaining[0] });
        }
        if (type === 'GUESS_COUNT' && mg.myGuess == null) socket.emit('minigame:move', { guess: mg.trueCount });
        if (type === 'DICE' && mg.myResult == null && !mg.myPressed) {
          socket.emit('minigame:move', { action: 'PRESS' });
          setTimeout(() => socket.emit('minigame:move', { action: 'RELEASE' }), 200);
        }
        if (type === 'BANK') socket.emit('minigame:move', { guess: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3) });
      }, 30);
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
      }, 30);
    }
  });
  return socket;
}

(async () => {
  await new Promise((resolve) => {
    const s = io(URL, { reconnection: false, forceNew: true });
    s.on('connect', () => { s.emit('admin:reset'); setTimeout(() => { s.close(); resolve(); }, 300); });
  });

  connectBot('A', { advance: false }); // A는 SIGIL에서 일부러 안 누름 -> 대기 화면 유지
  connectBot('B', { advance: true }); // B는 한 걸음(금)만 진행 -> "상대 1/3" 표시 확인용

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    proxy: { server: 'direct://', bypass: 'localhost,127.0.0.1' },
    args: ['--no-proxy-server'],
  });
  const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
  page.on('pageerror', (err) => console.log('[PAGE EXCEPTION]', err.message));
  await page.goto(URL + '/game/A');

  await page.waitForFunction(() => !!document.querySelector('.medalScatterArea'), null, { timeout: 180000, polling: 500 });
  await page.waitForTimeout(500); // B의 1단계 진행이 반영될 시간
  await page.screenshot({ path: '/tmp/build/poison_game/screenshot_medal_race.png', fullPage: false });
  console.log('saved screenshot_medal_race.png');

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
