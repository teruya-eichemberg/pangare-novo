const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const HORSES = [
  { id: 0, name: 'Rosa', color: '#d85c9d', faces: { circle: '01', square: '02', triangle: '03' } },
  { id: 1, name: 'Amarelo', color: '#f4cf12', faces: { circle: '04', square: '05', triangle: '06' } },
  { id: 2, name: 'Azul', color: '#159fd4', faces: { circle: '07', square: '08', triangle: '09' } },
  { id: 3, name: 'Laranja', color: '#f28b05', faces: { circle: '10', square: '11', triangle: '12' } },
  { id: 4, name: 'Verde', color: '#37a936', faces: { circle: '13', square: '14', triangle: '15' } }
];
const SYMBOLS = ['circle', 'square', 'triangle'];
const POINTS = { 1: 8, 2: 4, 3: 2, 4: 1, 5: 0 };
const rooms = new Map();

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck() {
  const deck = [];
  let id = 0;
  for (const horse of HORSES) {
    for (let n = 0; n < 4; n++) {
      for (const symbol of SYMBOLS) deck.push({ id: id++, horse: horse.id, symbol });
    }
  }
  return shuffle(deck);
}

function makeActionDeck() {
  return shuffle(Array.from({ length: 15 }, (_, id) => ({ id })));
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `PANG-${suffix}`;
}

function newPlayer(name, ws, isBot = false) {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: String(name || 'Jogador').slice(0, 18),
    color: 0,
    ws,
    isBot,
    actions: [],
    bets: { 1: null, 2: null, 3: null, 4: null, 5: null },
    score: 0
  };
}

function newRoom() {
  let code;
  do code = roomCode(); while (rooms.has(code));
  const room = {
    code,
    status: 'lobby',
    players: [],
    deck: [],
    actionDeck: [],
    discard: [],
    rows: HORSES.map(h => ({ horse: h.id, cards: [], carrots: 0, chickens: 0 })),
    revealed: [],
    current: 0,
    phase: 'lobby',
    pending: null,
    turnNumber: 0,
    betPlaced: false,
    lastEvent: 'Sala criada.',
    winner: null,
    timers: new Set()
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, player) {
  player.color = room.players.length;
  room.players.push(player);
}

function send(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    phase: room.phase,
    current: room.current,
    turnNumber: room.turnNumber,
    rows: room.rows,
    revealed: room.revealed,
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    pending: room.pending,
    lastEvent: room.lastEvent,
    winner: room.winner,
    players: room.players.map(p => ({
      id: p.id, name: p.name, color: p.color, isBot: p.isBot,
      actions: p.actions.length, bets: p.bets, score: p.score
    }))
  };
}

function broadcast(room) {
  const state = publicState(room);
  for (const p of room.players) {
    send(p.ws, { type: 'state', state, me: p.id, hand: p.actions, bets: p.bets });
  }
}

function errorTo(room, player, message) { send(player.ws, { type: 'error', message }); }
function log(room, text) { room.lastEvent = text; }
function currentPlayer(room) { return room.players[room.current]; }
function ownsTurn(room, player) { return currentPlayer(room)?.id === player.id; }

function startGame(room) {
  if (room.players.length < 2) {
    for (const p of room.players) errorTo(room, p, 'Adicione pelo menos 1 outro jogador ou bot.');
    return;
  }
  room.status = 'game';
  room.phase = 'race';
  room.deck = makeDeck();
  room.actionDeck = makeActionDeck();
  room.discard = [];
  room.rows = HORSES.map(h => ({ horse: h.id, cards: [], carrots: 0, chickens: 0 }));
  room.revealed = [];
  room.current = 0;
  room.turnNumber = 1;
  room.pending = null;
  room.betPlaced = false;
  room.winner = null;
  room.players.forEach(p => {
    p.actions = room.actionDeck.length ? [room.actionDeck.pop()] : [];
    p.bets = { 1: null, 2: null, 3: null, 4: null, 5: null };
    p.score = 0;
  });
  for (let i = 0; i < 3; i++) {
    const card = room.deck.pop();
    room.rows[card.horse].cards.push(card);
  }
  log(room, 'A corrida começou!');
  broadcast(room);
  scheduleBot(room);
}

function accident(revealed) {
  if (revealed.length < 3) return false;
  const symbols = revealed.slice(0, 3).map(c => c.symbol);
  const unique = new Set(symbols).size;
  return unique === 1 || unique === 3;
}

function countsByHorse(cards) {
  const counts = {};
  for (const c of cards) counts[c.horse] = (counts[c.horse] || 0) + 1;
  return counts;
}

function reveal(room, player) {
  if (room.status !== 'game' || !ownsTurn(room, player) || room.phase !== 'race' || room.pending) return;
  if (room.revealed.length >= 4 || !room.deck.length) return;

  const card = room.deck.pop();
  room.revealed.push(card);

  // Acidente has priority: the three first symbols determine the bust.
  if (accident(room.revealed)) {
    room.discard.push(...room.revealed);
    room.revealed = [];
    if (room.actionDeck.length) player.actions.push(room.actionDeck.pop());
    room.phase = 'action';
    log(room, 'ACIDENTE! As cartas reveladas foram descartadas. +1 Carta de Ação.');
    broadcast(room);
    scheduleBot(room);
    return;
  }

  const counts = countsByHorse(room.revealed);
  if (Object.values(counts).some(n => n >= 3)) {
    const a = room.actionDeck.pop();
    const b = room.actionDeck.pop();
    if (a) player.actions.push(a);
    if (b) player.actions.push(b);
    log(room, 'Bônus: 3 cartas do mesmo pangaré — +2 Cartas de Ação.');
  } else if (Object.values(counts).some(n => n >= 2)) {
    room.pending = { type: 'pairBonus', playerId: player.id };
    room.phase = 'bonus';
    log(room, 'Bônus: 2 cartas do mesmo pangaré — você pode retirar 1 carta da pista.');
    broadcast(room);
    scheduleBot(room);
    return;
  }

  if (room.revealed.length === 4) {
    stopRace(room, player);
  } else {
    broadcast(room);
  }
}

function stopRace(room, player) {
  if (room.status !== 'game' || !ownsTurn(room, player) || room.phase !== 'race') return;
  for (const card of room.revealed) room.rows[card.horse].cards.push(card);
  const n = room.revealed.length;
  room.revealed = [];
  room.pending = null;
  room.phase = 'action';
  log(room, `${player.name} parou e avançou ${n} carta(s).`);
  if (checkRaceEnd(room)) return;
  broadcast(room);
  scheduleBot(room);
}

function resolvePair(room, player, data) {
  if (!room.pending || room.pending.type !== 'pairBonus' || room.pending.playerId !== player.id) return;
  if (data.skip) {
    room.pending = null;
    room.phase = 'race';
    log(room, `${player.name} não usou o bônus.`);
    broadcast(room);
    scheduleBot(room);
    return;
  }
  const horse = Number(data.horse);
  if (!Number.isInteger(horse) || !room.rows[horse] || room.rows[horse].cards.length === 0) return;
  const removed = room.rows[horse].cards.pop();
  room.discard.push(removed);
  room.pending = null;
  room.phase = 'race';
  log(room, `${player.name} retirou uma carta do pangaré ${HORSES[horse].name}.`);
  broadcast(room);
  scheduleBot(room);
}

function playAction(room, player, data) {
  if (room.status !== 'game' || !ownsTurn(room, player) || room.phase !== 'action' || room.pending) return;
  const index = Number(data.index);
  if (!Number.isInteger(index) || index < 0 || index >= player.actions.length) return;
  const card = player.actions.splice(index, 1)[0];
  const horse = Number(data.horse);

  if (!HORSES[horse]) { player.actions.push(card); return; }

  if (data.kind === 'carrot') {
    room.rows[horse].carrots++;
    log(room, `${player.name} colocou uma Cenoura no ${HORSES[horse].name}.`);
  } else if (data.kind === 'chicken') {
    room.rows[horse].chickens++;
    log(room, `${player.name} colocou uma Galinha no ${HORSES[horse].name}.`);
  } else if (data.kind === 'removeChicken') {
    if (room.rows[horse].chickens < 1 || room.rows[horse].cards.length < 1) {
      player.actions.push(card);
      errorTo(room, player, 'É preciso haver uma Galinha e uma carta desse pangaré para removê-la.');
      return;
    }
    room.rows[horse].chickens--;
    room.discard.push(room.rows[horse].cards.pop());
    log(room, `${player.name} removeu uma Galinha do ${HORSES[horse].name} pagando com 1 carta.`);
  } else if (data.kind === 'moveBet') {
    const pos = Number(data.pos);
    if (![1, 2, 3, 4, 5].includes(pos) || player.bets[pos] === null) {
      player.actions.push(card);
      errorTo(room, player, 'Escolha uma aposta que você já tenha feito.');
      return;
    }
    player.bets[pos] = horse;
    log(room, `${player.name} moveu a aposta de ${pos}º lugar para ${HORSES[horse].name}.`);
  } else {
    player.actions.push(card);
    return;
  }

  room.phase = 'bet';
  broadcast(room);
}

function skipAction(room, player) {
  if (room.status !== 'game' || !ownsTurn(room, player) || room.phase !== 'action' || room.pending) return;
  room.phase = 'bet';
  log(room, `${player.name} passou a fase de Ação.`);
  broadcast(room);
}

function placeBet(room, player, pos, horse) {
  if (room.status !== 'game' || !ownsTurn(room, player) || room.phase !== 'bet' || room.betPlaced) return;
  pos = Number(pos); horse = Number(horse);
  if (![1, 2, 3, 4, 5].includes(pos) || !HORSES[horse]) return;
  if (player.bets[pos] !== null) return;
  player.bets[pos] = horse;
  room.betPlaced = true;
  log(room, `${player.name} apostou ${pos}º lugar no ${HORSES[horse].name}.`);
  broadcast(room);
}

function endTurn(room, player) {
  if (room.status !== 'game' || !ownsTurn(room, player) || room.phase !== 'bet' || room.pending) return;
  if (checkRaceEnd(room)) return;
  room.revealed = [];
  room.pending = null;
  room.betPlaced = false;
  room.current = (room.current + 1) % room.players.length;
  room.turnNumber++;
  room.phase = 'race';
  log(room, `É a vez de ${currentPlayer(room).name}.`);
  broadcast(room);
  scheduleBot(room);
}

function finalOrder(room) {
  return [...room.rows].sort((a, b) => {
    if (b.cards.length !== a.cards.length) return b.cards.length - a.cards.length;
    if (b.carrots !== a.carrots) return b.carrots - a.carrots;
    if (a.chickens !== b.chickens) return a.chickens - b.chickens;
    return a.horse - b.horse;
  });
}

function checkRaceEnd(room) {
  const reached = room.rows.find(r => r.cards.length >= 7);
  if (!reached) return false;
  const order = finalOrder(room);
  order.forEach((row, index) => { row.finalPos = index + 1; });
  for (const p of room.players) {
    p.score = 0;
    for (let pos = 1; pos <= 5; pos++) {
      const horse = p.bets[pos];
      if (horse === null) continue;
      const actual = order[pos - 1];
      if (actual && actual.horse === horse) p.score += POINTS[pos] || 0;
    }
  }
  const max = Math.max(...room.players.map(p => p.score));
  room.winner = room.players.filter(p => p.score === max).map(p => p.id);
  room.status = 'finished';
  room.phase = 'finished';
  room.pending = null;
  log(room, 'A corrida terminou!');
  broadcast(room);
  return true;
}

function botSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  return timer;
}

function scheduleBot(room) {
  const p = currentPlayer(room);
  if (!p?.isBot || room.status !== 'game') return;
  const timer = botSchedule(() => botStep(room, p), 500);
  room.timers.add(timer);
}

function botStep(room, bot) {
  if (room.status !== 'game' || currentPlayer(room)?.id !== bot.id) return;
  if (room.phase === 'race') {
    if (room.revealed.length > 0 && Math.random() < (room.revealed.length >= 2 ? 0.58 : 0.35)) stopRace(room, bot);
    else reveal(room, bot);
    return;
  }
  if (room.phase === 'bonus') {
    const choices = room.rows.filter(r => r.cards.length > 0).sort((a, b) => b.cards.length - a.cards.length);
    if (choices.length && Math.random() < 0.8) resolvePair(room, bot, { horse: choices[0].horse });
    else resolvePair(room, bot, { skip: true });
    return;
  }
  if (room.phase === 'action') {
    if (bot.actions.length && Math.random() < 0.6) {
      const leader = [...room.rows].sort((a, b) => b.cards.length - a.cards.length)[0];
      const kind = Math.random() < 0.5 ? 'chicken' : 'carrot';
      playAction(room, bot, { index: 0, kind, horse: leader.horse });
    } else skipAction(room, bot);
    return;
  }
  if (room.phase === 'bet') {
    const open = [1, 2, 3, 4, 5].filter(pos => bot.bets[pos] === null);
    if (open.length) {
      const pos = open[Math.floor(Math.random() * open.length)];
      const ranked = [...room.rows].sort((a, b) => b.cards.length - a.cards.length);
      const horse = ranked[Math.floor(Math.random() * Math.min(3, ranked.length))].horse;
      placeBet(room, bot, pos, horse);
    }
    endTurn(room, bot);
  }
}

wss.on('connection', ws => {
  let room = null;
  let player = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create') {
      room = newRoom();
      player = newPlayer(msg.name, ws, false);
      addPlayer(room, player);
      send(ws, { type: 'created', code: room.code, id: player.id });
      broadcast(room);
      return;
    }

    if (msg.type === 'join') {
      const wanted = String(msg.code || '').trim().toUpperCase();
      const found = rooms.get(wanted);
      if (!found) return send(ws, { type: 'error', message: 'Sala não encontrada.' });
      if (found.status !== 'lobby') return send(ws, { type: 'error', message: 'A partida já começou.' });
      if (found.players.length >= 4) return send(ws, { type: 'error', message: 'Sala cheia.' });
      room = found;
      player = newPlayer(msg.name, ws, false);
      addPlayer(room, player);
      send(ws, { type: 'joined', code: room.code, id: player.id });
      broadcast(room);
      return;
    }

    if (!room || !player) return;

    if (msg.type === 'addBot') {
      if (room.status === 'lobby' && room.players.length < 4) {
        addPlayer(room, newPlayer(`Bot ${room.players.length + 1}`, null, true));
        broadcast(room);
      }
      return;
    }
    if (msg.type === 'start') return startGame(room);
    if (msg.type === 'reveal') return reveal(room, player);
    if (msg.type === 'stop') return stopRace(room, player);
    if (msg.type === 'pending') return resolvePair(room, player, msg);
    if (msg.type === 'action') return playAction(room, player, msg);
    if (msg.type === 'skipAction') return skipAction(room, player);
    if (msg.type === 'bet') return placeBet(room, player, msg.pos, msg.horse);
    if (msg.type === 'endTurn') return endTurn(room, player);
  });

  ws.on('close', () => {
    if (!room || !player) return;
    player.ws = null;
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pangaré online em http://localhost:${PORT}`));
