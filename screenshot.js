// 두 브라우저 컨텍스트로 실제 페이지를 끝까지 자동 진행시키며 주요 화면을 스크린샷으로 저장한다.
// 미니게임 순서가 매치마다 셔플되므로, 특정 미니게임 이름에 의존하지 않고 화면에 보이는
// 활성화된 버튼을 범용적으로 클릭해 나간다.
const { chromium } = require('playwright');

const URL = 'http://localhost:3000';
const OUT = '/tmp/build/shots';
require('fs').mkdirSync(OUT, { recursive: true });

function shuffle3() {
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const picked = [];
  for (let i = 0; i < 3; i++) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return picked;
}

async function doMinigameMove(page) {
  const bankInput = page.locator('.bankInput');
  if (await bankInput.isVisible().catch(() => false)) {
    await bankInput.fill(shuffle3().join(''));
    await page.locator('button.action', { hasText: '금고 열기 시도' }).click().catch(() => {});
    return true;
  }
  const btns = await page.locator('.mgBox button.action:not([disabled])').all();
  if (btns.length) { await btns[Math.floor(Math.random() * btns.length)].click().catch(() => {}); return true; }
  return false;
}

async function doRewardIfAny(page, shots) {
  const rewardPanel = page.locator('h2', { hasText: '🎁 보상 사용' });
  if (!(await rewardPanel.isVisible().catch(() => false))) return false;
  if (!shots.reward) { shots.reward = true; await page.screenshot({ path: `${OUT}/7_reward_panel.png`, fullPage: true }); }
  const flashBtn = page.locator('button.action', { hasText: '지금 섬광 정찰' });
  if (await flashBtn.isVisible().catch(() => false)) {
    await flashBtn.click().catch(() => {});
    await page.waitForTimeout(30);
    await page.screenshot({ path: `${OUT}/7b_flash_overlay.png`, fullPage: true }).catch(() => {});
    return true;
  }
  const cellBtn = page.locator('.pickerGrid .cell').first();
  if (await cellBtn.isVisible().catch(() => false)) { await cellBtn.click().catch(() => {}); return true; }
  const typeBtn = page.locator('.mgBox button.action').first();
  if (await typeBtn.isVisible().catch(() => false)) {
    await typeBtn.click().catch(() => {});
    await page.waitForTimeout(80);
    const idxBtn = page.locator('.mgBox .btnRow button.action:not([disabled])').last();
    if (await idxBtn.isVisible().catch(() => false)) await idxBtn.click().catch(() => {});
    return true;
  }
  return false;
}

async function doAction(page) {
  const turnBadge = page.locator('p.badge.turn', { hasText: '내 턴' });
  if (!(await turnBadge.isVisible().catch(() => false))) return false;
  const r = Math.random();
  if (r < 0.2) {
    await page.locator('button.action', { hasText: '아이템 얻기' }).click().catch(() => {});
    await page.waitForTimeout(150);
    const card = page.locator('.itemCard:not(.disabled)').first();
    if (await card.isVisible().catch(() => false)) await card.click().catch(() => {});
  } else if (r < 0.5) {
    await page.locator('button.action', { hasText: '단서 얻기' }).click().catch(() => {});
    await page.waitForTimeout(150);
    const btns = await page.locator('.mgBox button.action').all();
    if (btns.length) await btns[Math.floor(Math.random() * btns.length)].click().catch(() => {});
  } else {
    await page.locator('button.action', { hasText: '술잔 고르기' }).click().catch(() => {});
    await page.waitForTimeout(150);
    const cells = await page.locator('.grid6 .cell.pickable').all();
    if (cells.length) await cells[Math.floor(Math.random() * cells.length)].click().catch(() => {});
  }
  return true;
}

(async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto(URL);
  await pageA.waitForTimeout(500);
  await pageA.screenshot({ path: `${OUT}/1_lobby.png` });

  await pageB.goto(URL);
  await pageA.waitForTimeout(800);

  // SETUP: 장남(A)이 3칸 선택 후 확정
  await pageA.screenshot({ path: `${OUT}/2_setup.png` });
  const cellsA = await pageA.locator('.grid6 .cell').all();
  for (const idx of [0, 7, 14]) await cellsA[idx].click();
  await pageA.screenshot({ path: `${OUT}/3_setup_selected.png` });
  await pageA.locator('button.action.primary', { hasText: '독 설치 확정' }).click();

  // 차남(B)도 선택 후 확정
  const cellsB = await pageB.locator('.grid6 .cell').all();
  for (const idx of [1, 8, 15]) await cellsB[idx].click();
  await pageB.locator('button.action.primary', { hasText: '독 설치 확정' }).click();

  await pageA.waitForTimeout(1000);
  await pageA.screenshot({ path: `${OUT}/4_minigame_and_reward_banner.png`, fullPage: true });
  await pageB.screenshot({ path: `${OUT}/4b_minigame_opponent.png`, fullPage: true });

  const shots = {};
  let gotActionShot = false, gotClueShot = false, gotBankShot = false, gotEnd = false;

  for (let i = 0; i < 500 && !gotEnd; i++) {
    for (const page of [pageA, pageB]) {
      const isEnd = await page.locator('.endBanner').isVisible().catch(() => false);
      if (isEnd) { gotEnd = true; continue; }

      if (!gotBankShot && (await page.locator('.bankInput').isVisible().catch(() => false))) {
        gotBankShot = true;
        await page.screenshot({ path: `${OUT}/5_bank_minigame.png`, fullPage: true });
      }

      await doMinigameMove(page);

      if (!gotActionShot && (await page.locator('h2', { hasText: '본행동' }).isVisible().catch(() => false))) {
        gotActionShot = true;
        await page.screenshot({ path: `${OUT}/6a_action_panel.png`, fullPage: true });
        const itemBtn = page.locator('button.action', { hasText: '아이템 얻기' });
        if (await itemBtn.isVisible().catch(() => false)) {
          await itemBtn.click().catch(() => {});
          await page.waitForTimeout(150);
          await page.screenshot({ path: `${OUT}/6b_item_card_grid.png`, fullPage: true });
          const closeBtn = page.locator('button.action', { hasText: '아이템 얻기' });
          await closeBtn.click().catch(() => {}); // 토글 닫기
        }
      }
      if (!gotClueShot) {
        const clueBtn = page.locator('button.action', { hasText: '단서 얻기' });
        if (await clueBtn.isVisible().catch(() => false)) {
          await clueBtn.click().catch(() => {});
          await page.waitForTimeout(150);
          const stillThere = await page.locator('.mgBox').isVisible().catch(() => false);
          if (stillThere) {
            gotClueShot = true;
            await page.screenshot({ path: `${OUT}/6c_clue_choice.png`, fullPage: true });
          }
          const btns = await page.locator('.mgBox button.action').all();
          if (btns.length) await btns[Math.floor(Math.random() * btns.length)].click().catch(() => {});
        }
      }

      await doRewardIfAny(page, shots);
      await doAction(page);
    }
    await pageA.waitForTimeout(60);
  }

  await pageA.waitForTimeout(400);
  await pageA.screenshot({ path: `${OUT}/8_end_screen.png`, fullPage: true }).catch(() => {});
  await pageB.screenshot({ path: `${OUT}/8b_end_screen_opponent.png`, fullPage: true }).catch(() => {});

  await browser.close();
  console.log('DONE', { gotActionShot, gotClueShot, gotBankShot, gotEnd, reward: !!shots.reward });
})().catch((e) => { console.error(e); process.exit(1); });
