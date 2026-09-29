// "정확한 순서로 놓아야만 완성/보너스"라는 새 규칙 자체를 집중적으로 검증하는 스크립트.
// test_crest.js/test_sim.js는 무작위 플레이 속에서 이 규칙이 사고 없이 잘 돌아가는지를
// 확인하지만(실제로 정답 순서 완성 로그도 관측됨), 이 스크립트는 규칙의 핵심 시나리오를
// 결정론적으로 직접 재현한다:
//   1) 한 세트(4조각)를 전부 모은 뒤, 일부러 완전히 틀린 순서(4주기 치환)로 4칸을 채운다.
//      → 4/4가 찼는데도 crestSetsCompleted/보너스가 발생하지 않고, 구역이 "찼지만 미완성"
//        (crestId가 그대로 남아있는) 상태로 유지되는지 확인한다.
//   2) 같은 구역 안에서 스왑(자리 맞바꾸기)만으로 순서를 정답으로 고친다.
//      → 마지막 스왑 직후 즉시 완성 처리(구역이 비워지고 crestSetsCompleted 증가, 첫 완성이면
//        +CREST_SET_BONUS)가 일어나는지 확인한다.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';

function waitFor(getState, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const s = getState();
      if (s && predicate(s)) return resolve(s);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 40);
    };
    tick();
  });
}

(async () => {
  let sA = null, sB = null;
  const A = io(URL, { reconnection: false, forceNew: true });
  const B = io(URL, { reconnection: false, forceNew: true });
  A.on('state', (s) => { sA = s; });
  B.on('state', (s) => { sB = s; });
  A.on('log', ({ msg }) => { if (msg.includes('문장')) console.log('[LOG]', msg); });
  A.on('error', ({ message }) => console.log('[ERR:A]', message));
  B.on('error', ({ message }) => console.log('[ERR:B]', message));

  // B는 그냥 자기 턴마다 무작위로 칸을 여는 단순 봇 — A의 라운드 진행에 발이 묶이지 않게만 한다.
  B.on('state', (s) => {
    if (s.phase === 'SETUP' && !B._setupSent) {
      B._setupSent = true;
      setTimeout(() => B.emit('setup:confirm', { cells: [{ row: 3, col: 5 }, { row: 0, col: 5 }, { row: 2, col: 1 }] }), 50);
    }
    if (s.phase === 'MID_SETUP' && s.oppOpenedMask && !B._midSent) {
      B._midSent = true;
      const mask = s.oppOpenedMask;
      const candidates = [];
      for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) candidates.push({ row: r, col: c });
      setTimeout(() => B.emit('mid_setup:confirm', { cells: candidates.slice(0, s.config.POISON_MID) }), 50);
    }
    if (s.phase !== 'MID_SETUP') B._midSent = false;
    if (s.phase === 'ROUND_ACTION' && s.isMyTurn && s.opensRemaining > 0) {
      const room = s.me.room;
      const candidates = [];
      for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened && !room[r][c].locked) candidates.push({ row: r, col: c });
      if (candidates.length) setTimeout(() => B.emit('action:open', candidates[Math.floor(Math.random() * candidates.length)]), 30);
    }
    if (s.phase === 'ROUND_MINIGAME' && s.minigame && s.minigame.public) {
      const mg = s.minigame.public, type = s.minigame.type;
      setTimeout(() => {
        if (type === 'NIM' && mg.myTurn) B.emit('minigame:move', { n: 1 });
        if (type === 'HAND' && mg.waitingForMe) B.emit('minigame:move', { hand: 'L' });
        if (type === 'REFLEX' && !mg.myClicked && mg.goFired) B.emit('minigame:move', { action: 'CLICK' });
        if (type === 'BOMB' && mg.myTurn) B.emit('minigame:move', { action: 'PASS' });
        if (type === 'PIN' && mg.myTurn) {
          const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
          if (remaining.length) B.emit('minigame:move', { action: 'PICK', index: remaining[0] });
        }
        if (type === 'SIGIL' && mg.waitingForMe) B.emit('minigame:move', { pick: ['SWORD', 'POISON', 'SHIELD'][Math.floor(Math.random() * 3)] });
        if (type === 'GUESS_COUNT' && mg.myGuess == null) B.emit('minigame:move', { guess: mg.trueCount });
        if (type === 'CARD_DUEL' && mg.waitingForMe) B.emit('minigame:move', { arrangement: [1, 2, 3].sort(() => Math.random() - 0.5) });
        if (type === 'PACT' && mg.waitingForMe) B.emit('minigame:move', { action: 'SILENT' });
        if (type === 'BANK') B.emit('minigame:move', { guess: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3) });
      }, 40);
    }
    if (s.phase === 'ROUND_ACTION' && s.myReward && !s.myReward.type && s.myReward.choices) {
      const c = s.myReward.choices[0];
      if (c) setTimeout(() => B.emit('reward:choose', { type: c.type }), 30);
    }
    if (s.phase === 'ROUND_ACTION' && s.myReward && s.myReward.type && !s.myReward.used) {
      setTimeout(() => {
        if (s.myReward.type === 'FLASH_ALL') B.emit('reward:use', {});
        else if (s.myReward.type === 'PEEK_CELL') B.emit('reward:use', { row: 0, col: 0 });
        else B.emit('reward:use', { targetType: 'GEM' });
      }, 40);
    }
  });

  // A쪽은 미니게임/보상/설치는 자동으로 가볍게 통과시키고, ROUND_ACTION 중에는 "칸 열기"만
  // 자동으로 반복한다(문장 조각 배치는 이 스크립트가 뒤에서 직접 결정론적으로 제어한다).
  let autoOpenEnabled = true;
  A.on('state', (s) => {
    if (s.phase === 'SETUP' && !A._setupSent) {
      A._setupSent = true;
      setTimeout(() => A.emit('setup:confirm', { cells: [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 3, col: 0 }] }), 50);
    }
    if (s.phase === 'MID_SETUP' && s.oppOpenedMask && !A._midSent) {
      A._midSent = true;
      const mask = s.oppOpenedMask;
      const candidates = [];
      for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) candidates.push({ row: r, col: c });
      setTimeout(() => A.emit('mid_setup:confirm', { cells: candidates.slice(0, s.config.POISON_MID) }), 50);
    }
    if (s.phase !== 'MID_SETUP') A._midSent = false;
    if (s.phase === 'ROUND_MINIGAME' && s.minigame && s.minigame.public) {
      const mg = s.minigame.public, type = s.minigame.type;
      setTimeout(() => {
        if (type === 'NIM' && mg.myTurn) A.emit('minigame:move', { n: 1 });
        if (type === 'HAND' && mg.waitingForMe) A.emit('minigame:move', { hand: 'L' });
        if (type === 'REFLEX' && !mg.myClicked && mg.goFired) A.emit('minigame:move', { action: 'CLICK' });
        if (type === 'BOMB' && mg.myTurn) A.emit('minigame:move', { action: 'PASS' });
        if (type === 'PIN' && mg.myTurn) {
          const remaining = mg.pulled.map((p, i) => (p ? null : i)).filter((i) => i != null);
          if (remaining.length) A.emit('minigame:move', { action: 'PICK', index: remaining[0] });
        }
        if (type === 'SIGIL' && mg.waitingForMe) A.emit('minigame:move', { pick: ['SWORD', 'POISON', 'SHIELD'][Math.floor(Math.random() * 3)] });
        if (type === 'GUESS_COUNT' && mg.myGuess == null) A.emit('minigame:move', { guess: mg.trueCount });
        if (type === 'CARD_DUEL' && mg.waitingForMe) A.emit('minigame:move', { arrangement: [1, 2, 3].sort(() => Math.random() - 0.5) });
        if (type === 'PACT' && mg.waitingForMe) A.emit('minigame:move', { action: 'SILENT' });
        if (type === 'BANK') A.emit('minigame:move', { guess: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3) });
      }, 40);
    }
    if (s.phase === 'ROUND_ACTION' && s.myReward && !s.myReward.type && s.myReward.choices) {
      const c = s.myReward.choices[0];
      if (c) setTimeout(() => A.emit('reward:choose', { type: c.type }), 30);
    }
    if (s.phase === 'ROUND_ACTION' && s.myReward && s.myReward.type && !s.myReward.used) {
      setTimeout(() => {
        if (s.myReward.type === 'FLASH_ALL') A.emit('reward:use', {});
        else if (s.myReward.type === 'PEEK_CELL') A.emit('reward:use', { row: 0, col: 0 });
        else A.emit('reward:use', { targetType: 'GEM' });
      }, 40);
    }
    if (autoOpenEnabled && s.phase === 'ROUND_ACTION' && s.opensRemaining > 0) {
      const room = s.me.room;
      const candidates = [];
      for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened && !room[r][c].locked) candidates.push({ row: r, col: c });
      if (candidates.length) setTimeout(() => A.emit('action:open', candidates[Math.floor(Math.random() * candidates.length)]), 30);
    }
  });

  await waitFor(() => sA, (s) => !!s, 10000);
  console.log('연결 완료 — A의 처소에서 한 세트(4조각)를 모두 모을 때까지 무작위로 칸을 엽니다...');

  // 한 세트의 4조각을 전부 모을 때까지(각 라운드 budget이 다 떨어지면 다음 라운드까지) 기다린다.
  const targetCrestId = await waitFor(() => sA, (s) => {
    if (s.phase === 'END') throw new Error('게임이 끝나버렸습니다(세트를 못 모음)');
    const held = s.me.heldPieces || [];
    const counts = {};
    held.forEach((p) => { counts[p.crestId] = (counts[p.crestId] || 0) + 1; });
    return Object.values(counts).some((n) => n >= 4);
  }, 240000).then((s) => {
    const held = s.me.heldPieces || [];
    const counts = {};
    held.forEach((p) => { counts[p.crestId] = (counts[p.crestId] || 0) + 1; });
    return Number(Object.keys(counts).find((cid) => counts[cid] >= 4));
  });
  console.log(`세트 확보 완료 — 대상 crestId=${targetCrestId} (${sA.me.heldPieces.length}개 보유 중)`);

  autoOpenEnabled = false; // 이제부터 A는 이 스크립트가 직접 조립을 제어한다.

  function moveAndWaitZone(payload, predicate, label) {
    return new Promise((resolve, reject) => {
      A.emit('crest:move', payload);
      const start = Date.now();
      const tick = () => {
        if (predicate(sA)) return resolve(sA);
        if (Date.now() - start > 10000) return reject(new Error(`timeout: ${label}`));
        setTimeout(tick, 40);
      };
      setTimeout(tick, 60);
    });
  }

  // 빈 구역 하나를 골라, 그 구역에 이 세트를 배정한다.
  let zoneIndex = sA.me.zones.findIndex((z) => z.crestId === targetCrestId);
  if (zoneIndex === -1) zoneIndex = sA.me.zones.findIndex((z) => z.crestId === null);
  if (zoneIndex === -1) throw new Error('빈 구역을 찾을 수 없습니다');

  // 대상 세트의 held 조각 4개를 slot(piecePos % 4)로 놓는다 — piecePos 1→slot1, 2→slot2,
  // 3→slot3, 4→slot0. 이는 정답 매핑(piecePos-1)과 한 자리도 겹치지 않는 완전 치환(4-cycle)이라,
  // 4칸이 다 차도 절대 정답 순서가 될 수 없다.
  const pieces = sA.me.heldPieces.filter((p) => p.crestId === targetCrestId).slice(0, 4).sort((a, b) => a.piecePos - b.piecePos);
  if (pieces.length !== 4) throw new Error(`held에 4조각이 없습니다: ${JSON.stringify(pieces)}`);
  console.log('보유 조각(오름차순):', JSON.stringify(pieces));

  // "보유 → 구역"으로 새로 놓는 건 라운드당 2회뿐인 행동 예산을 쓴다 — 이미 그 예산을 다 쓴
  // 라운드라면(칸 열기로 소진됐을 수 있음) 다음 라운드가 돌아올 때까지 기다린다.
  async function waitForOpensAvailable() {
    await waitFor(() => sA, (s) => s.phase === 'ROUND_ACTION' && s.opensRemaining > 0, 60000);
  }

  for (const piece of pieces) {
    await waitForOpensAvailable();
    const wrongSlot = piece.piecePos % 4; // 1→1, 2→2, 3→3, 4→0
    await moveAndWaitZone(
      { crestId: piece.crestId, piecePos: piece.piecePos, from: 'held', to: { zoneIndex, slot: wrongSlot } },
      (s) => s.me.zones[zoneIndex].slots[wrongSlot] === piece.piecePos,
      `놓기(잘못된 슬롯) piecePos=${piece.piecePos}→slot${wrongSlot}`
    );
    console.log(`놓음: piecePos=${piece.piecePos} → slot ${wrongSlot} (정답은 slot ${piece.piecePos - 1})`);
  }

  const beforeFix = sA;
  const zoneAfterFill = beforeFix.me.zones[zoneIndex];
  const filled4 = zoneAfterFill.slots.every((v) => v != null);
  const isWrongOrder = zoneAfterFill.slots.some((v, i) => v !== i + 1);
  const stillUnsolved = zoneAfterFill.crestId === targetCrestId; // 정답이었다면 서버가 이미 비웠을 것
  const completedCountBefore = (beforeFix.me.crestSetsCompleted || []).filter((c) => c === targetCrestId).length;
  console.log('4칸 채운 직후 zone:', JSON.stringify(zoneAfterFill));
  console.log(filled4 && isWrongOrder && stillUnsolved
    ? 'PASS: 4/4가 찼지만 순서가 틀려 완성 처리가 안 되고 구역이 그대로 남아있음(needsFix 상태)'
    : 'FAIL: 4/4인데도 상태가 기대와 다름(완성되었거나 구조가 이상함)');
  console.log(completedCountBefore === 0 ? 'PASS: 아직 crestSetsCompleted에 반영되지 않음' : 'FAIL: 순서가 틀렸는데 이미 완성으로 처리됨');

  // ---- 스왑만으로 정답 순서로 고치기 ----
  // 현재: slot0=4, slot1=1, slot2=2, slot3=3 (piecePos%4 매핑) → 정답: slot0=1,slot1=2,slot2=3,slot3=4
  // 인접 스왑 3번으로 고친다: (0↔1) → (1↔2) → (2↔3).
  async function swapSlots(a, b) {
    const zoneNow = sA.me.zones[zoneIndex];
    const pieceAtA = zoneNow.slots[a];
    const pieceAtB = zoneNow.slots[b];
    await moveAndWaitZone(
      { crestId: targetCrestId, piecePos: pieceAtA, from: { zoneIndex, slot: a }, to: { zoneIndex, slot: b } },
      (s) => {
        const z = s.me.zones[zoneIndex];
        // 완성되면 zone 전체가 비워지므로(slots 전부 null) 그 경우도 "성공"으로 본다.
        const cleared = z.crestId == null && z.slots.every((v) => v == null);
        return cleared || (z.slots[b] === pieceAtA && z.slots[a] === pieceAtB);
      },
      `스왑 slot${a}<->slot${b}`
    );
    console.log(`스왑 완료: slot${a}<->slot${b} (${pieceAtA}번 ↔ ${pieceAtB}번)`);
  }

  await swapSlots(0, 1); // slot0=1,slot1=4,slot2=2,slot3=3
  await swapSlots(1, 2); // slot1=2,slot2=4,slot3=3
  await swapSlots(2, 3); // slot2=3,slot3=4 → 전부 정답!

  const finalState = sA;
  const zoneAfterSwap = finalState.me.zones[zoneIndex];
  const clearedNow = zoneAfterSwap.crestId == null && zoneAfterSwap.slots.every((v) => v == null);
  const completedCountAfter = (finalState.me.crestSetsCompleted || []).filter((c) => c === targetCrestId).length;
  console.log('스왑 완료 후 zone:', JSON.stringify(zoneAfterSwap));
  console.log('crestSetsCompleted:', JSON.stringify(finalState.me.crestSetsCompleted), 'score:', finalState.me.score);
  console.log(clearedNow ? 'PASS: 스왑만으로 정답 순서를 완성해서 구역이 비워짐' : 'FAIL: 스왑 후에도 구역이 비워지지 않음');
  console.log(completedCountAfter === completedCountBefore + 1 ? 'PASS: crestSetsCompleted가 정확히 1 증가함' : 'FAIL: crestSetsCompleted 변화가 예상과 다름');

  const allPass = filled4 && isWrongOrder && stillUnsolved && completedCountBefore === 0 && clearedNow && completedCountAfter === completedCountBefore + 1;
  console.log(allPass ? '=== 전체 PASS ===' : '=== 전체 FAIL ===');
  A.close(); B.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  console.error('예외 발생:', e.message);
  process.exit(1);
});
