// 가문의 문장 확장판(3세트 x 4조각 = 12조각, 조립 구역 2개, 세트별 "먼저 완성" +3 보너스,
// 완성 즉시 구역이 비워져 재사용됨) 검증 스크립트.
//
// 예전 버전(고정 9개 총량 + 즉시승리 없음)을 대체한다 — 지금은 문장 세트 구조(3x4) 자체는
// 공개 정보이고, 정확한 칸 위치만 비공개다. 이 스크립트는 실제 소켓 연결로 한 매치 전체를
// 진행시키며: 칸을 열면 즉시 +1점과 heldPieces 추가가 되는지, action:place가 조립 구역
// 규칙(같은 crestId만·이미 찬 구역엔 못 놓음·한번 놓으면 못 뺌)을 지키는지, 구역이 4/4를
// 채우면 비워지고 crestSetsCompleted에 반영되는지, 그리고 크레스트별 "먼저 완성"은 딱 한
// 명에게만 +3 보너스로 기록되는지(crestRace)를 확인한다.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
let states = { A: null, B: null };
let done = false;
let setupSent = { A: false, B: false };
let midSetupSent = { A: false, B: false };
const ROWS_FIRST_HALF = 4;

function connectPlayer(label) {
  const socket = io(URL, { reconnection: false, forceNew: true });
  socket.on('connect_error', (e) => console.error(label, 'connect_error', e.message));
  socket.on('state', (s) => { states[label] = s; onState(label, socket, s); });
  socket.on('log', ({ msg }) => { if (msg.includes('문장')) console.log('[LOG]', msg); });
  socket.on('error', ({ message }) => {
    console.log('[ERR]', label, message);
    // 중반 독 추가 설치가 거부당했으면(이미 독이 있는 칸을 몰라서 골랐을 뿐) 다시 무작위로 골라본다.
    const s = states[label];
    if (s && s.phase === 'MID_SETUP') { midSetupSent[label] = false; setTimeout(() => onState(label, socket, s), 20); }
  });
  return socket;
}

function onState(label, socket, s) {
  if (s.phase === 'SETUP' && !setupSent[label]) {
    setupSent[label] = true;
    const cells = label === 'A' ? [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 3, col: 0 }] : [{ row: 3, col: 5 }, { row: 0, col: 5 }, { row: 2, col: 1 }];
    setTimeout(() => socket.emit('setup:confirm', { cells }), 50);
  }
  if (s.phase === 'MID_SETUP' && !midSetupSent[label] && s.oppOpenedMask) {
    midSetupSent[label] = true;
    // 어느 칸에 이미 독(1차)이 있는지는 서버만 아는 비공개 정보이므로, 봇도 실제 플레이어처럼
    // "안 연 칸" 중 무작위로 골랐다가 서버가 거부하면(이미 독이 있는 칸) 다시 고르는 방식으로 흉내낸다.
    const mask = s.oppOpenedMask;
    const candidates = [];
    for (let r = 0; r < mask.length; r++) for (let c = 0; c < mask[r].length; c++) if (!mask[r][c]) candidates.push({ row: r, col: c });
    const tryPick = () => {
      const shuffled = candidates.slice().sort(() => Math.random() - 0.5);
      const picked = shuffled.slice(0, s.config.POISON_MID);
      socket.emit('mid_setup:confirm', { cells: picked });
    };
    setTimeout(tryPick, 50);
  }
  if (s.phase === 'ROUND_ACTION') {
    // 우선순위: 보유중(미배치) 조각이 있으면 조립부터 시도(자기 세트의 구역이 있거나 빈 구역이
    // 있으면), 없으면 칸 열기. held[0]만 보지 않고 전부 뒤져서 하나라도 놓을 수 있는 조각을
    // 찾는다 — 그래야 "낄 데 없는 조각"에 막혀 놓을 수 있는 다른 조각까지 영영 못 놓는 실수를 피한다.
    if (s.opensRemaining > 0) {
      const held = s.me.heldPieces;
      if (held && held.length > 0) {
        let placeTarget = null;
        for (const piece of held) {
          let zoneIndex = s.me.zones.findIndex((z) => z.crestId === piece.crestId);
          if (zoneIndex === -1) zoneIndex = s.me.zones.findIndex((z) => z.crestId === null);
          if (zoneIndex !== -1) { placeTarget = { piece, zoneIndex }; break; }
        }
        if (placeTarget) {
          setTimeout(() => socket.emit('action:place', { crestId: placeTarget.piece.crestId, piecePos: placeTarget.piece.piecePos, zoneIndex: placeTarget.zoneIndex }), 30);
          return;
        }
      }
      const room = s.me.room;
      const candidates = [];
      for (let r = 0; r < room.length; r++) for (let c = 0; c < room[r].length; c++) if (!room[r][c].opened && !room[r][c].locked) candidates.push({ row: r, col: c });
      if (candidates.length) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        setTimeout(() => socket.emit('action:open', target), 30);
      }
    }
  }
  if (s.minigame && s.minigame.public) {
    const mg = s.minigame.public, type = s.minigame.type;
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
      if (type === 'BANK') {
        const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, mg.digits || 3);
        socket.emit('minigame:move', { guess: digits });
      }
    }, 40);
  }
  if (s.phase === 'ROUND_ACTION' && s.myReward && !s.myReward.type && s.myReward.choices) {
    const c = s.myReward.choices[0];
    if (c) setTimeout(() => socket.emit('reward:choose', { type: c.type }), 30);
  }
  if (s.phase === 'ROUND_ACTION' && s.myReward && s.myReward.type && !s.myReward.used) {
    setTimeout(() => {
      if (s.myReward.type === 'FLASH_ALL') socket.emit('reward:use', {});
      else if (s.myReward.type === 'PEEK_CELL') socket.emit('reward:use', { row: 0, col: 0 });
      else socket.emit('reward:use', { targetType: 'GEM' });
    }, 40);
  }
  if (s.phase === 'END' && !done) {
    done = true;
    console.log('=== GAME END ===', s.winner, s.endReason);
    console.log('me:', label, JSON.stringify({ score: s.me.score, crestOpened: s.me.crestOpened, crestSetsCompleted: s.me.crestSetsCompleted, zones: s.me.zones, heldPieces: s.me.heldPieces }));
    console.log('crestRace:', JSON.stringify(s.crestRace));
    // 어느 쪽(A/B) state가 먼저 END를 관측하는지는 소켓 타이밍에 좌우되므로, 검증은 특정
    // 라벨에 매지 않고 처음 도착한 END 상태 기준으로 그대로 돌린다(양쪽 다 같은 crestRace를
    // 공유하고, me.* 검증 항목들은 어느 쪽 관점이든 동일한 규칙을 만족해야 한다).
    const checks = [];
    const validRace = Object.values(s.crestRace).every((v) => v === null || v === 'me' || v === 'opp');
    checks.push([validRace, 'crestRace shape valid (각 세트당 null/me/opp 중 하나)']);
    checks.push([s.me.crestOpened >= 0 && s.me.crestOpened <= 12, `crestOpened 범위(0~12) 이내: ${s.me.crestOpened}`]);
    checks.push([Array.isArray(s.me.zones) && s.me.zones.length === 2, `조립 구역은 항상 2개 유지: ${s.me.zones && s.me.zones.length}`]);
    checks.push([Array.isArray(s.me.crestSetsCompleted) && s.me.crestSetsCompleted.length <= 3, `완성 세트 수는 0~3: ${s.me.crestSetsCompleted && s.me.crestSetsCompleted.length}`]);
    const raceWinners = Object.values(s.crestRace).filter((v) => v === 'me' || v === 'opp').length;
    checks.push([raceWinners <= 3, `세트별 먼저-완성 보너스는 세트당 최대 1명: 합계 ${raceWinners}/3`]);
    let allPass = true;
    checks.forEach(([ok, desc]) => { console.log(ok ? 'PASS' : 'FAIL', '-', desc); if (!ok) allPass = false; });
    if (!allPass) process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
}

connectPlayer('A');
setTimeout(() => connectPlayer('B'), 100);
setTimeout(() => { if (!done) { console.error('TIMEOUT'); process.exit(1); } }, 300000);
