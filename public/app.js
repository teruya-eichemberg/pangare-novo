const HORSES = [
  {name:'Rosa', color:'#d85c9d', faces:{circle:'01',square:'02',triangle:'03'}},
  {name:'Amarelo', color:'#f4cf12', faces:{circle:'04',square:'05',triangle:'06'}},
  {name:'Azul', color:'#159fd4', faces:{circle:'07',square:'08',triangle:'09'}},
  {name:'Laranja', color:'#f28b05', faces:{circle:'10',square:'11',triangle:'12'}},
  {name:'Verde', color:'#37a936', faces:{circle:'13',square:'14',triangle:'15'}}
];
const BET = {0:{1:'19',2:'20',3:'21',4:'22',5:'23'},1:{1:'24',2:'25',3:'26',4:'27',5:'28'},2:{1:'29',2:'30',3:'31',4:'32',5:'33'},3:{1:'34',2:'35',3:'36',4:'37',5:'38'}};
const img = n => `/assets/pangare-${n}.png`;
const betImg = n => `/assets/aposta-${n}.png`;
const app = document.getElementById('app');
let ws = null, state = null, me = null, hand = [], roomCode = '', selectedBet = null, selectedAction = null;

function send(message){
  if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function connect(afterOpen){
  if(ws && ws.readyState === WebSocket.OPEN) return afterOpen?.();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => afterOpen?.();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if(msg.type === 'created' || msg.type === 'joined'){
      roomCode = msg.code;
      me = msg.id;
      renderLobby();
      return;
    }
    if(msg.type === 'state'){
      state = msg.state;
      me = msg.me;
      hand = msg.hand || [];
      render();
      return;
    }
    if(msg.type === 'error') alert(msg.message);
  };
  ws.onerror = () => alert('Não foi possível conectar ao servidor. Tente novamente.');
  ws.onclose = () => {
    if(state && state.status !== 'finished') alert('A conexão foi encerrada. Recarregue a página para entrar novamente.');
  };
}

function landing(){
  app.innerHTML = `<div class="screen"><div class="panel"><h1 class="logo">PANGARÉ</h1><div class="subtitle">A grande corrida para descobrir o melhor pangaré do mundo!</div><div class="field"><input id="name" placeholder="Seu nome" maxlength="18"><button class="btn" id="create">Criar partida</button></div><div class="field"><input id="joinCode" placeholder="Código da sala (PANG-XXXX)"><button class="btn secondary" id="join">Entrar</button></div><div class="tip">Até 4 jogadores. Você pode adicionar bots para testar sozinho.</div></div></div>`;
  document.getElementById('create').onclick = () => {
    const name = document.getElementById('name').value.trim() || 'Jogador';
    connect(() => send({type:'create', name}));
  };
  document.getElementById('join').onclick = () => {
    const name = document.getElementById('name').value.trim() || 'Jogador';
    const code = document.getElementById('joinCode').value.trim().toUpperCase();
    if(!code) return alert('Digite o código da sala.');
    connect(() => send({type:'join', name, code}));
  };
}

function renderLobby(){
  const players = state?.players || [];
  app.innerHTML = `<div class="screen"><div class="panel"><h1 class="logo">PANGARÉ</h1><div>Sala</div><div class="room-code">${roomCode || state?.code || '—'}</div><div class="players">${players.map(p=>`<div class="player-row" style="border-left-color:${HORSES[p.color]?.color||'#777'}"><span>${escapeHtml(p.name)}${p.isBot?' 🤖':''}</span><b>${p.isBot?'BOT':'JOGADOR'}</b></div>`).join('') || '<div>Aguardando jogadores…</div>'}</div><div class="controls center"><button class="btn secondary" id="bot">+ Adicionar Bot</button><button class="btn green" id="start">Começar corrida</button></div><div class="tip">Compartilhe o código da sala com outros jogadores.</div></div></div>`;
  document.getElementById('bot').onclick = () => send({type:'addBot'});
  document.getElementById('start').onclick = () => send({type:'start'});
}

function render(){
  if(!state) return landing();
  if(state.status === 'lobby') return renderLobby();
  renderGame();
  if(state.status === 'finished') setTimeout(finishModal, 0);
}

function renderGame(){
  const current = state.players[state.current];
  const myTurn = current?.id === me;
  const mine = state.players.find(p=>p.id===me);
  app.innerHTML = `<div class="game"><div class="topbar"><div class="brand">PANGARÉ</div><div>Sala <b>${state.code}</b></div><div class="turn">${myTurn?'★ SUA VEZ':'Vez de '+escapeHtml(current?.name||'—')}</div></div><div class="table"><div class="other-players">${state.players.map(p=>`<div class="pill" style="border-left:5px solid ${HORSES[p.color]?.color||'#777'}">${escapeHtml(p.name)}${p.isBot?' 🤖':''} · ${p.actions} ação(ões)</div>`).join('')}</div><div class="track">${state.rows.map(lane).join('')}</div></div><div class="bottom"><div class="actionline"><div><div class="phase">${phaseText(myTurn)}</div><div class="event">${escapeHtml(state.lastEvent||'')}</div></div><div class="controls">${myTurn&&state.phase==='race'?'<button class="btn" id="reveal">Revelar carta</button><button class="btn secondary" id="stop">Parar</button>':''}${myTurn&&state.phase==='action'?'<button class="btn secondary" id="skip">Passar ação</button>':''}${myTurn&&state.phase==='bet'?'<button class="btn green" id="end">Finalizar turno</button>':''}</div></div>${state.revealed.length?`<div class="reveal-zone"><b>Reveladas:</b>${state.revealed.map(card).join('')}</div>`:''}<div><b>Sua mão de ações</b><div class="hand">${hand.length?hand.map((_,i)=>`<div class="action-card" data-action="${i}"><img src="/assets/action_cenoura.png"><span>Cenoura / Galinha</span></div>`).join(''):'<span class="small">nenhuma</span>'}</div></div><div class="bet-hand"><b>Suas apostas</b><div class="hand">${[1,2,3,4,5].map(pos=>{const f=BET[mine?.color||0][pos]; const selected=selectedBet===pos?'selected':''; const used=mine?.bets[pos]!==null?'used':''; return `<img class="hand-card bet ${selected} ${used}" src="${betImg(f)}" data-bet="${pos}" title="${pos}º lugar">`;}).join('')}</div></div></div></div>`;
  if(myTurn){
    document.getElementById('reveal')?.addEventListener('click',()=>send({type:'reveal'}));
    document.getElementById('stop')?.addEventListener('click',()=>send({type:'stop'}));
    document.getElementById('skip')?.addEventListener('click',()=>send({type:'skipAction'}));
    document.getElementById('end')?.addEventListener('click',()=>send({type:'endTurn'}));
    document.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>actionModal(Number(el.dataset.action)));
    document.querySelectorAll('[data-bet]').forEach(el=>el.onclick=()=>betSelect(Number(el.dataset.bet)));
    if(state.phase==='bonus' && state.pending?.playerId===me) bonusModal();
  }
}

function phaseText(my){
  if(!my) return 'Observe a corrida';
  if(state.phase==='race') return 'CORRIDA — revele até 4 cartas e decida quando parar';
  if(state.phase==='bonus') return 'BÔNUS — retire uma carta da pista ou passe';
  if(state.phase==='action') return 'AÇÃO — use 1 Carta de Ação ou passe';
  if(state.phase==='bet') return 'APOSTA — escolha uma posição ainda livre e finalize o turno';
  return '';
}

function lane(row){
  const h=HORSES[row.horse];
  const cards=row.cards.map(card).join('');
  const carrots=row.carrots?Array(Math.min(row.carrots,4)).fill('<img class="modifier" src="/assets/action_cenoura.png">').join(''):'';
  const chickens=row.chickens?Array(Math.min(row.chickens,4)).fill('<img class="modifier" src="/assets/action_galinha.png">').join(''):'';
  const bets=state.players.flatMap(p=>Object.entries(p.bets).filter(([,horse])=>Number(horse)===row.horse).map(([pos])=>`<span class="mini-bet-wrap"><img class="mini-bet" title="${escapeHtml(p.name)}: ${pos}º" src="${betImg(BET[p.color][pos])}"></span>`)).join('');
  return `<div class="lane" style="box-shadow:inset 6px 0 ${h.color}"><div class="lane-head"><span>${h.name} <span class="lane-meta">${row.cards.length}/7</span></span><span>${row.carrots?'🥕 '+row.carrots+' ':''}${row.chickens?'🐔 '+row.chickens:''}</span></div><div class="cards">${cards}${carrots}${chickens}</div><div class="bet-zone">${bets}</div></div>`;
}

function card(c){return `<img class="race-card" src="${img(HORSES[c.horse].faces[c.symbol])}">`;}

function betSelect(pos){
  const mine=state.players.find(p=>p.id===me);
  if(state.phase!=='bet' || mine.bets[pos]!==null) return;
  selectedBet=pos; horseModal('apostar');
}

function actionModal(index){
  if(state.phase!=='action') return;
  selectedAction=index;
  app.insertAdjacentHTML('beforeend', `<div class="modal" id="modal"><div class="modal-card"><h2>Usar Carta de Ação</h2><p>A carta pode ser usada como Cenoura, Galinha ou para mover uma aposta.</p><div class="controls center"><button class="btn" id="carrot">🥕 Cenoura</button><button class="btn danger" id="chicken">🐔 Galinha</button><button class="btn secondary" id="move">🎟️ Mover aposta</button></div><button class="btn secondary" onclick="closeModal()">Cancelar</button></div></div>`);
  document.getElementById('carrot').onclick=()=>horseModal('carrot');
  document.getElementById('chicken').onclick=()=>horseModal('chicken');
  document.getElementById('move').onclick=moveBetModal;
}

function horseModal(kind){
  closeModal();
  const title=kind==='apostar'?'Escolha o pangaré da aposta':kind==='carrot'?'Escolha quem recebe a Cenoura':'Escolha quem recebe a Galinha';
  const modal=document.createElement('div'); modal.className='modal'; modal.id='modal';
  modal.innerHTML=`<div class="modal-card"><h2>${title}</h2><div class="horse-grid">${HORSES.map((h,i)=>`<button class="horse-choice" data-h="${i}"><img src="${img(h.faces.circle)}"><b>${h.name}</b><div class="small">${state.rows[i].cards.length} cartas</div></button>`).join('')}</div><button class="btn secondary" onclick="closeModal()">Cancelar</button></div>`;
  app.appendChild(modal);
  modal.querySelectorAll('[data-h]').forEach(b=>b.onclick=()=>{const horse=Number(b.dataset.h);closeModal();if(kind==='apostar'){send({type:'bet',pos:selectedBet,horse});selectedBet=null;}else send({type:'action',index:selectedAction,kind,horse});});
}

function moveBetModal(){
  closeModal();
  const p=state.players.find(x=>x.id===me); const existing=[1,2,3,4,5].filter(pos=>p.bets[pos]!==null);
  if(!existing.length) return alert('Você ainda não tem apostas para mover.');
  app.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><div class="modal-card"><h2>Qual aposta você quer mover?</h2><div class="controls center">${existing.map(pos=>`<button class="btn" data-pos="${pos}">${pos}º lugar</button>`).join('')}</div><button class="btn secondary" onclick="closeModal()">Cancelar</button></div></div>`);
  document.querySelectorAll('[data-pos]').forEach(b=>b.onclick=()=>{const pos=Number(b.dataset.pos);closeModal();horseMoveModal(pos);});
}

function horseMoveModal(pos){
  const modal=document.createElement('div'); modal.className='modal'; modal.id='modal';
  modal.innerHTML=`<div class="modal-card"><h2>Escolha o novo pangaré</h2><div class="horse-grid">${HORSES.map((h,i)=>`<button class="horse-choice" data-h="${i}"><img src="${img(h.faces.circle)}"><b>${h.name}</b></button>`).join('')}</div><button class="btn secondary" onclick="closeModal()">Cancelar</button></div>`;
  app.appendChild(modal);
  modal.querySelectorAll('[data-h]').forEach(b=>b.onclick=()=>{send({type:'action',index:selectedAction,kind:'moveBet',pos,horse:Number(b.dataset.h)});closeModal();});
}

function bonusModal(){
  if(document.getElementById('modal')) return;
  const modal=document.createElement('div'); modal.className='modal'; modal.id='modal';
  modal.innerHTML=`<div class="modal-card"><h2>🐎 Bônus: dois pangarés iguais!</h2><p>Você pode retirar 1 carta de qualquer fila.</p><div class="horse-grid">${HORSES.map((h,i)=>`<button class="horse-choice" data-h="${i}"><img src="${img(h.faces.circle)}"><b>${h.name}</b><div class="small">${state.rows[i].cards.length} cartas</div></button>`).join('')}</div><button class="btn secondary" id="ignore">Não usar</button></div>`;
  app.appendChild(modal);
  modal.querySelectorAll('[data-h]').forEach(b=>b.onclick=()=>{send({type:'pending',horse:Number(b.dataset.h)});closeModal();});
  document.getElementById('ignore').onclick=()=>{send({type:'pending',skip:true});closeModal();};
}

function closeModal(){document.getElementById('modal')?.remove();}
window.closeModal=closeModal;

function finishModal(){
  if(document.getElementById('finish') || !state || state.status!=='finished') return;
  const rows=[...state.players].sort((a,b)=>b.score-a.score);
  const div=document.createElement('div'); div.className='modal'; div.id='finish';
  div.innerHTML=`<div class="modal-card"><div class="finish">🏆 Corrida encerrada!</div><p>${state.winner?.length>1?'Empate!':'Resultado final'}</p>${rows.map((p,i)=>`<div class="score-row"><span>${i+1}. ${escapeHtml(p.name)}${p.id===me?' (você)':''}</span><b>${p.score} pts</b></div>`).join('')}<button class="btn" onclick="location.reload()">Nova partida</button></div>`;
  app.appendChild(div);
}

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

landing();
