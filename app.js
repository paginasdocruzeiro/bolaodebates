const STORAGE_KEY = 'bolaoCruzeiroDebates.local.v4';
const SESSION_KEY = 'bolaoCruzeiroDebates.session';

async function hashPin(pin, userId = '') {
  // Salt = pepper ('bolao:') + userId — unique per user, reduces offline rainbow attacks
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bolao:${userId}:${pin}`));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isPinHashed(pin) {
  return typeof pin === 'string' && pin.length === 64 && /^[0-9a-f]+$/.test(pin);
}
const ADMIN_NAMES = ['Ivo', 'Samuel', 'Gabriel'];

const session = { user: null };
let state = null;
let countdownTimer = null;
let printMode = 'ranking';
const views = ['home', 'round', 'ranking', 'history', 'admin', 'print'];
// Note: ia, sofascore and chat are integrated into home view
let currentRoute = 'home';
let firebaseDbRef = null;
let firebaseSyncEnabled = false;
let geminiKey = null;

const SEED_USERS = [
  ['Davidson', 17, '+553196017445'],
  ['Gabriel', 14, '+553187076410'],
  ['Pedro Lucas', 13, '+553798024477'],
  ['Leandro', 11, '+553192203422'],
  ['Ivo', 10, '+351935886230'],
  ['Bruno', 9, '+553187516769'],
  ['Juliano', 9, '+553798267290'],
  ['Samuel', 9, '+553799026621'],
  ['Farlon', 8, '+553799162671'],
  ['Dente', 8, '+553182494730'],
  ['Filipe', 7, '+553197878752']
].map(([name, basePoints, phone]) => ({
  id: crypto.randomUUID(),
  name,
  phone,
  basePoints,
  baseExact: 0,
  basePartial: 0,
  pin: null,
  isAdmin: ADMIN_NAMES.includes(name)
}));

const APP_TIMEZONE = 'America/Sao_Paulo';
const APP_TIMEZONE_LABEL = 'Horário de Brasília';

function getZonedParts(date = new Date(), timeZone = APP_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function getTimeZoneOffsetMs(date, timeZone = APP_TIMEZONE) {
  const parts = getZonedParts(date, timeZone);
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - date.getTime();
}

function parseAppDateTime(value) {
  if (!value) return null;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value).getTime();

  const [datePart, timePart = '00:00'] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);

  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimeZoneOffsetMs(guess, APP_TIMEZONE);
  return guess.getTime() - offset;
}

function toLocalInputInAppTime(date = new Date()) {
  const parts = getZonedParts(date, APP_TIMEZONE);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const now = new Date();
const addDays = (days, hours = 20, mins = 0) => {
  const base = parseAppDateTime(toLocalInputInAppTime(now));
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hours + 3, mins, 0, 0);
  return toLocalInputInAppTime(d);
};

const SEED_ROUNDS = [
  {
    id: crypto.randomUUID(),
    title: 'Próxima rodada',
    opponent: 'Novo adversário',
    competition: 'Brasileirão',
    matchTime: addDays(4, 18, 30),
    deadline: addDays(4, 18, 0),
    resultCruzeiro: null,
    resultOpponent: null,
    manualState: 'auto',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

const el = (id) => document.getElementById(id);

function buildInitialState() {
  return {
    users: SEED_USERS,
    rounds: SEED_ROUNDS,
    bets: {},
    lastRoundHighlight: {
      text: 'Pedro Lucas, único com acerto exato, foi o destaque da última rodada.',
      player: 'Pedro Lucas'
    },
    initialRankingSnapshot: SEED_USERS.map(u => ({ name: u.name, points: u.basePoints })),
    externalMatches: { upcoming: [], finished: [], updatedAt: null }
  };
}

function normalizeState(raw) {
  const base = buildInitialState();
  if (!raw || typeof raw !== 'object') return base;

  // Merge phone from SEED_USERS into users that don't have it (e.g. loaded from Firebase before phone was added)
  const seedPhoneMap = Object.fromEntries(SEED_USERS.map(u => [u.name, u.phone]));
  const mergedUsers = (Array.isArray(raw.users) ? raw.users : base.users).map(u => ({
    ...u,
    phone: u.phone || seedPhoneMap[u.name] || ''
  }));

  const normalizedBets = Array.isArray(raw.bets)
    ? Object.fromEntries(
        raw.bets
          .filter(Boolean)
          .map(b => [b.id, b])
      )
    : (raw.bets && typeof raw.bets === 'object' ? raw.bets : {});

  return {
    users: mergedUsers,
    rounds: Array.isArray(raw.rounds) ? raw.rounds : base.rounds,
    bets: normalizedBets,
    lastRoundHighlight: raw.lastRoundHighlight || base.lastRoundHighlight,
    initialRankingSnapshot: Array.isArray(raw.initialRankingSnapshot)
      ? raw.initialRankingSnapshot
      : base.initialRankingSnapshot,
    externalMatches: raw.externalMatches && typeof raw.externalMatches === 'object'
      ? {
          upcoming: Array.isArray(raw.externalMatches.upcoming) ? raw.externalMatches.upcoming : [],
          finished: Array.isArray(raw.externalMatches.finished) ? raw.externalMatches.finished : [],
          updatedAt: raw.externalMatches.updatedAt || null
        }
      : base.externalMatches
  };
}

function applyAdminFlags() {
  if (!state?.users) return;
  state.users.forEach(u => {
    u.isAdmin = ADMIN_NAMES.includes(u.name);
  });
}

function loadLocalState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const initial = buildInitialState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }
  return normalizeState(JSON.parse(raw));
}

function persistLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function saveSession(user) {
  if (!user) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    userId: user.id,
    userName: user.name,
    savedAt: new Date().toISOString()
  }));
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function restoreSession() {
  const saved = loadSession();
  if (!saved || !state?.users) return false;

  const user = state.users.find(u =>
    (saved.userId && u.id === saved.userId) ||
    (saved.userName && u.name === saved.userName)
  );

  if (!user) {
    clearSession();
    session.user = null;
    return false;
  }

  session.user = user;
  return true;
}

function firebaseConfigReady() {
  return typeof window.firebase !== 'undefined'
    && typeof window.firebase.auth === 'function'  // requires firebase-auth-compat.js in index.html
    && window.BOLAO_FIREBASE_CONFIG
    && typeof window.BOLAO_FIREBASE_CONFIG === 'object'
    && !!window.BOLAO_FIREBASE_CONFIG.apiKey
    && !!window.BOLAO_FIREBASE_CONFIG.projectId
    && !!window.BOLAO_FIREBASE_CONFIG.databaseURL;
}

async function initializeDataSource() {
  state = loadLocalState();
  applyAdminFlags();

  if (!firebaseConfigReady()) {
    firebaseSyncEnabled = false;
    restoreSession(); // local mode: state is already loaded, restore session here
    return;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(window.BOLAO_FIREBASE_CONFIG);
  }

  // Authenticate anonymously before any RTDB read/write.
  // This satisfies the "auth != null" rule on all paths.
  // Anonymous Auth must be enabled in the Firebase Console → Authentication → Sign-in providers.
  const auth = firebase.auth();
  if (!auth.currentUser) {
    await auth.signInAnonymously();
  }

  const db = firebase.database();
  const dbPath = window.BOLAO_FIREBASE_PATH || 'bolao-cruzeiro-debates/state';
  firebaseDbRef = db.ref(dbPath);

  // Resolve the initial state first, synchronously from the app's perspective.
  // The .on('value') listener is only attached afterwards, so it never fires
  // during startup and init() needs no guard against a double render.
  const firstSnapshot = await firebaseDbRef.once('value');

  if (!firstSnapshot.exists()) {
    await firebaseDbRef.set(state);
  } else {
    state = normalizeState(firstSnapshot.val());
    applyAdminFlags();
    restoreSession();
    persistLocalState();
  }

  // From this point on, the listener handles real-time updates only.
  firebaseDbRef.on('value', (snapshot) => {
    const remoteState = snapshot.val();
    if (!remoteState) return;

    state = normalizeState(remoteState);
    applyAdminFlags();
    restoreSession();
    persistLocalState();
    renderAll(currentRoute);
  });

  firebaseSyncEnabled = true;
}

// Returns the Firebase Anonymous UID for the current session.
// Used by the admin-write paths (rounds, users) which the RTDB rules
// check against the adminUids node.
function getFirebaseUid() {
  try {
    return firebase.auth().currentUser?.uid || null;
  } catch {
    return null;
  }
}

function saveBetsState() {
  // DEPRECATED — não usar. Apostas são gravadas individualmente em upsertBet().
  // Esta função fazia .set() global que conflitua com as regras por $betId.
  console.warn('saveBetsState() está deprecated. Use upsertBet() para gravar apostas individualmente.');
  applyAdminFlags();
  persistLocalState();
}

function saveUsersState() {
  applyAdminFlags();
  persistLocalState();
  if (firebaseDbRef) {
    firebaseDbRef.child('users').set(state.users || []);
  }
}

function saveAdminState() {
  applyAdminFlags();
  persistLocalState();
  if (firebaseDbRef) {
    firebaseDbRef.update({
      rounds:                 state.rounds,
      lastRoundHighlight:     state.lastRoundHighlight,
      initialRankingSnapshot: state.initialRankingSnapshot
    });
  }
}

function saveState(scope = 'all') {
  applyAdminFlags();
  persistLocalState();
  if (!firebaseDbRef) return;

  if (scope === 'bets') {
    // SEGURO: não faz .set() global — apostas são gravadas individualmente em upsertBet()
    // Apenas persiste localmente
    return;
  }

  if (scope === 'users') {
    firebaseDbRef.child('users').set(state.users || []);
    return;
  }

  if (scope === 'admin') {
    firebaseDbRef.update({
      rounds:                 state.rounds,
      lastRoundHighlight:     state.lastRoundHighlight,
      initialRankingSnapshot: state.initialRankingSnapshot
    });
    return;
  }

  // Full sync — nunca inclui bets (cada aposta é gravada individualmente em upsertBet)
  firebaseDbRef.update({
    users:                  state.users,
    rounds:                 state.rounds,
    lastRoundHighlight:     state.lastRoundHighlight,
    initialRankingSnapshot: state.initialRankingSnapshot
  });
}

function currentUser() {
  return session.user;
}

function isAdmin() {
  return !!currentUser()?.isAdmin;
}

function formatDateTime(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: APP_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(parseAppDateTime(iso)));
}

function getRound(roundId) {
  return state.rounds.find(r => r.id === roundId);
}

function getBetsArray() {
  if (!state?.bets) return [];
  return Object.values(state.bets).filter(Boolean);
}

function getBetById(betId) {
  if (!betId || !state?.bets) return null;
  return state.bets[betId] || null;
}

function getLatestRound() {
  return [...state.rounds].sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime))[0] || null;
}

function getCurrentRound() {
  const sorted = [...state.rounds]
    .sort((a, b) => parseAppDateTime(a.matchTime) - parseAppDateTime(b.matchTime));

  // Prefer an actively open/closed/result round over upcoming
  const active = sorted.find(r => ['open', 'closed', 'result'].includes(effectiveRoundState(r)));
  if (active) return active;

  // Fall back to the next upcoming round if no active one exists
  const upcoming = sorted.find(r => effectiveRoundState(r) === 'upcoming');
  return upcoming || getLatestRound();
}

function effectiveRoundState(round) {
  if (!round) return 'none';
  if (round.manualState && round.manualState !== 'auto') return round.manualState;

  const nowMs    = Date.now();
  const deadline = parseAppDateTime(round.deadline);
  const matchMs  = parseAppDateTime(round.matchTime);

  if (round.resultCruzeiro !== null && round.resultOpponent !== null) return 'result';
  if (nowMs > deadline) return 'closed';
  // Auto-upcoming: deadline is in the future but match is also far away (>48h)
  // and no bets have been placed yet — treat as upcoming so it doesn't hijack
  // the current active round in the dashboard.
  const betsForRound = getBetsArray().filter(b => b.roundId === round.id).length;
  if (matchMs - nowMs > 48 * 3600000 && betsForRound === 0) return 'upcoming';
  return 'open';
}

function roundStateLabel(round) {
  return ({
    none:      'Sem rodada',
    upcoming:  'Em espera',
    open:      'Apostas abertas',
    closed:    'Apostas encerradas',
    result:    'Resultado lançado',
    finalized: 'Rodada finalizada'
  })[effectiveRoundState(round)] || '—';
}

function getBet(roundId, userName) {
  return getBetsArray().find(b => b.roundId === roundId && b.userName === userName) || null;
}

function getMissingBettors(round = getCurrentRound()) {
  if (!round || effectiveRoundState(round) !== 'open') return [];
  return state.users.filter(user => !getBet(round.id, user.name));
}

function generateMissingBetsMessage() {
  const round = getCurrentRound();
  if (!round) return 'Sem rodada ativa.';
  const missing = getMissingBettors(round);
  if (!missing.length) return `✅ Todos já apostaram para Cruzeiro x ${round.opponent}`;
  const list = missing.map(u => u.name).join(', ');
  return [
    `⚽ Apostadores em falta — Cruzeiro x ${round.opponent}`,
    '',
    list,
    '',
    `Prazo: ${formatDateTime(round.deadline)}, ${APP_TIMEZONE_LABEL}.`
  ].join('\n');
}

// ── Novo painel de lembretes ──────────────────────────────────────────────────

// Estado do painel de lembretes (persistido só em memória durante a sessão)
const _reminderState = { sent: new Set(), queue: [], queueIndex: 0, mode: null };

function renderMissingBetsPanel() {
  const wrap = el('missingBetsAdminWrap');
  if (!wrap) return;

  const round = getCurrentRound();
  const state_round = round ? effectiveRoundState(round) : null;

  if (!round || state_round !== 'open') {
    wrap.innerHTML = `<div class="notice" style="color:var(--text-2);">Sem rodada com apostas abertas.</div>`;
    return;
  }

  const missing = getMissingBettors(round);

  if (!missing.length) {
    wrap.innerHTML = `<div class="notice" style="border-color:var(--green);color:var(--green);">✅ Todos já apostaram para Cruzeiro x ${round.opponent}!</div>`;
    return;
  }

  // Template de mensagem individual
  const deadline = formatDateTime(round.deadline);
  const defaultMsg = `Opa, bão demais? Passando aqui só pra avisar que você ainda não apostou no Bolão Cruzeiro Debates para o jogo Cruzeiro x ${round.opponent}.\n\nPrazo: ${deadline}, ${APP_TIMEZONE_LABEL}.\n\nAcesse aqui: https://bolaodocruzeiro.online/`;
  const defaultGroupMsg = `⚽ Apostadores em falta para Cruzeiro x ${round.opponent}:\n\n${missing.map(u => `• ${u.name}`).join('\n')}\n\nPrazo: ${deadline}, ${APP_TIMEZONE_LABEL}.\n\nAcesse: https://bolaodocruzeiro.online/`;

  const sentCount = missing.filter(u => _reminderState.sent.has(u.name)).length;

  wrap.innerHTML = `
    <div class="missing-panel">
      <div class="missing-panel-header">
        <span class="mini-label">Apostadores em falta</span>
        <span class="missing-count-badge">${missing.length} em falta${sentCount ? ` · <span style="color:var(--green)">✅ ${sentCount} lembrete${sentCount > 1 ? 's' : ''} enviado${sentCount > 1 ? 's' : ''}</span>` : ''}</span>
      </div>

      <div class="missing-checklist" id="missingChecklist">
        ${missing.map(u => `
          <label class="missing-check-item ${_reminderState.sent.has(u.name) ? 'sent' : ''}">
            <input type="checkbox" name="missingUser" value="${u.name}" ${_reminderState.sent.has(u.name) ? 'checked disabled' : 'checked'} />
            <span class="missing-check-name">${avatarHTML(u.name)} ${u.name}</span>
            ${u.phone ? `<span class="missing-check-phone">${u.phone}</span>` : `<span class="missing-check-nophone">Sem número</span>`}
            ${_reminderState.sent.has(u.name) ? `<span class="missing-sent-tag">✅ Enviado</span>` : ''}
          </label>
        `).join('')}
      </div>

      <div class="missing-msg-wrap">
        <label style="font-size:.82rem;color:var(--text-2);display:grid;gap:6px;margin-bottom:12px;">
          Mensagem individual (editável)
          <textarea id="missingMsgTemplate" rows="5" style="font-size:.82rem;">${defaultMsg}</textarea>
        </label>
      </div>

      <div class="missing-actions">
        <button class="ios-btn ios-btn-green" id="missingOneByOneBtn">📲 Enviar um a um</button>
        <button class="ios-btn ios-btn-blue" id="missingGroupBtn">💬 Mensagem para o grupo</button>
      </div>

      <div id="missingQueueWrap" class="missing-queue hidden"></div>
    </div>
  `;

  // Eventos
  el('missingOneByOneBtn')?.addEventListener('click', () => startOneByOneReminders(missing, round));
  el('missingGroupBtn')?.addEventListener('click', () => sendGroupReminder(missing, defaultGroupMsg));
}

function getSelectedMissing(missing) {
  const checked = Array.from(document.querySelectorAll('input[name="missingUser"]:checked:not(:disabled)'));
  const selectedNames = new Set(checked.map(c => c.value));
  return missing.filter(u => selectedNames.has(u.name));
}

function startOneByOneReminders(missing, round) {
  const selected = getSelectedMissing(missing);
  if (!selected.length) { showToast('Selecione pelo menos um apostador.'); return; }

  const withPhone = selected.filter(u => u.phone);
  const withoutPhone = selected.filter(u => !u.phone);

  if (!withPhone.length) {
    showToast(`Nenhum dos selecionados tem número de WhatsApp: ${withoutPhone.map(u => u.name).join(', ')}`);
    return;
  }

  _reminderState.queue = withPhone;
  _reminderState.queueIndex = 0;
  _reminderState.mode = 'one-by-one';

  if (withoutPhone.length) {
    showToast(`Sem número: ${withoutPhone.map(u => u.name).join(', ')} — serão ignorados.`);
  }

  renderQueueStep(round);
}

function renderQueueStep(round) {
  const wrap = el('missingQueueWrap');
  if (!wrap) return;

  const queue = _reminderState.queue;
  const idx = _reminderState.queueIndex;
  const total = queue.length;
  const sentSoFar = idx; // idx avança após cada envio

  if (idx >= total) {
    // Todos enviados
    wrap.classList.remove('hidden');
    wrap.innerHTML = `
      <div class="queue-done">
        ✅ <strong>${total} lembrete${total > 1 ? 's' : ''} enviado${total > 1 ? 's' : ''}!</strong>
        <button class="ios-btn ios-btn-gray" id="queueResetBtn" style="margin-top:10px;">Fechar</button>
      </div>
    `;
    el('queueResetBtn')?.addEventListener('click', () => {
      wrap.classList.add('hidden');
      renderMissingBetsPanel();
    });
    return;
  }

  const user = queue[idx];
  const msgTemplate = el('missingMsgTemplate')?.value ||
    `Opa, bão demais? Passando aqui só pra avisar que você ainda não apostou no Bolão para Cruzeiro x ${round.opponent}. Prazo: ${formatDateTime(round.deadline)}, ${APP_TIMEZONE_LABEL}. Acesse: https://bolaodocruzeiro.online/`;

  const phone = user.phone.replace(/\D/g, '');
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(msgTemplate)}`;

  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class="queue-step">
      <div class="queue-progress">
        <div class="queue-progress-bar" style="width:${(sentSoFar / total) * 100}%"></div>
      </div>
      <p class="queue-counter">${sentSoFar} de ${total} enviado${sentSoFar !== 1 ? 's' : ''}</p>
      <div class="queue-current">
        <span>A enviar para:</span>
        <strong>${avatarHTML(user.name)} ${user.name}</strong>
        <span class="missing-check-phone">${user.phone}</span>
      </div>
      <div class="queue-btns">
        <a href="${url}" target="_blank" class="ios-btn ios-btn-green" id="queueSendBtn">📲 Abrir WhatsApp → ${user.name}</a>
        <button class="ios-btn ios-btn-gray" id="queueDoneBtn">✅ Marcado como enviado</button>
        <button class="ios-btn ios-btn-red" id="queueSkipBtn">⏭ Pular</button>
      </div>
    </div>
  `;

  el('queueDoneBtn')?.addEventListener('click', () => {
    _reminderState.sent.add(user.name);
    _reminderState.queueIndex++;
    renderQueueStep(round);
    renderMissingBetsPanel(); // atualiza badges
  });

  el('queueSkipBtn')?.addEventListener('click', () => {
    _reminderState.queueIndex++;
    renderQueueStep(round);
  });

  // Auto-avança para "marcado" se o user clicar no link do WhatsApp
  el('queueSendBtn')?.addEventListener('click', () => {
    setTimeout(() => {
      el('queueDoneBtn')?.focus();
    }, 800);
  });
}

function sendGroupReminder(missing, defaultMsg) {
  // Usa a mensagem do template se disponível
  const msg = el('missingMsgTemplate')?.value
    ? `⚽ Apostadores em falta para o próximo jogo:\n\n${missing.map(u => `• ${u.name}`).join('\n')}\n\nPor favor apostem a tempo! 🙏`
    : defaultMsg;

  const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
  showToast('WhatsApp aberto — escolhe o grupo para enviar.');
}


function scorePrediction(predC, predO, realC, realO) {
  if ([predC, predO, realC, realO].some(v => v === null || Number.isNaN(v))) {
    return { points: 0, type: 'erro' };
  }
  if (predC === realC && predO === realO) {
    return { points: 3, type: 'exato' };
  }

  const predOutcome = Math.sign(predC - predO);
  const realOutcome = Math.sign(realC - realO);

  if (predOutcome === realOutcome) {
    return { points: 1, type: 'parcial' };
  }

  return { points: 0, type: 'erro' };
}

function upsertBet({ roundId, userName, cruzeiroGoals, opponentGoals }) {
  const nowIso = new Date().toISOString();
  const existing = getBet(roundId, userName);
  const loggedUser = currentUser();
  const firebaseUid = getFirebaseUid();

  let betId;
  let updatedBet;

  if (existing) {
    if (existing.userId && existing.userId !== (loggedUser?.id || null)) {
      showToast('Não é possível editar a aposta de outro participante.');
      return;
    }

    updatedBet = {
      ...existing,
      userId: existing.userId || loggedUser?.id || null,
      firebaseUid: existing.firebaseUid || firebaseUid || null,
      cruzeiroGoals,
      opponentGoals,
      updatedAt: nowIso
    };
    betId = existing.id;
    state.bets[betId] = updatedBet;
    showToast('Palpite atualizado com sucesso.');
  } else {
    betId = crypto.randomUUID();
    updatedBet = {
      id: betId,
      roundId,
      userName,
      userId: loggedUser?.id || null,
      firebaseUid: firebaseUid || null,
      cruzeiroGoals,
      opponentGoals,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    state.bets[betId] = updatedBet;
    showToast('Palpite registrado com sucesso.');
  }

  // Guardar persistência local
  persistLocalState();

  // Guardar só esta aposta individual no Firebase (evita conflito com regras por $betId)
  if (firebaseDbRef) {
    firebaseDbRef.child('bets').child(betId).set(updatedBet)
      .catch(err => {
        console.error('Erro ao guardar aposta no Firebase:', err);
        showToast('Erro ao salvar no servidor. Tente novamente.');
      });
  }
}

function applyCompetitionPositions(arr, scoreField) {
  let currentPosition = 1;
  arr.forEach((item, index) => {
    if (index > 0 && item[scoreField] < arr[index - 1][scoreField]) {
      currentPosition = index + 1;
    }
    item.position = currentPosition;
  });
}

function calculateRankings() {
  const users = state.users.map((user) => {
    let totalPoints  = user.basePoints;
    let exact        = user.baseExact   || 0;
    let partial      = user.basePartial || 0;
    let roundsPlayed = 0;
    let scoringRounds = 0;
    let zeroRounds   = 0;  // apostou e não pontuou
    let missedRounds = 0;  // não apostou (rodada com resultado)
    let roundScores  = [];

    const sortedRounds = [...state.rounds].sort((a, b) => parseAppDateTime(a.matchTime) - parseAppDateTime(b.matchTime));
    sortedRounds.forEach((round) => {
      // Only count rounds that have a result AND are closed/finalized (not open/upcoming)
      if (round.resultCruzeiro === null || round.resultOpponent === null) return;
      const rs = effectiveRoundState(round);
      if (rs === 'open' || rs === 'upcoming') return;

      roundsPlayed += 1;
      const bet = getBet(round.id, user.name);

      if (!bet) {
        missedRounds += 1;
        roundScores.push({ roundId: round.id, points: 0, type: 'sem aposta' });
        return;
      }

      const score = scorePrediction(
        bet.cruzeiroGoals, bet.opponentGoals,
        round.resultCruzeiro, round.resultOpponent
      );

      totalPoints += score.points;
      if (score.type === 'exato')   exact   += 1;
      if (score.type === 'parcial') partial += 1;
      if (score.points > 0) scoringRounds += 1;
      else                  zeroRounds    += 1;  // apostou mas não pontuou

      roundScores.push({ roundId: round.id, points: score.points, type: score.type });
    });

    const avg        = roundsPlayed ? totalPoints / roundsPlayed : totalPoints;
    const efficiency = roundsPlayed ? (totalPoints / (roundsPlayed * 3)) * 100 : 0;

    return {
      ...user,
      totalPoints,
      exact,
      partial,
      roundsPlayed,
      scoringRounds,
      zeroRounds,   // apostou e errou (0 pts)
      missedRounds, // não apostou
      avg,
      efficiency,
      roundScores
    };
  });

  const ordered = [...users].sort((a, b) => b.totalPoints - a.totalPoints || b.exact - a.exact || a.name.localeCompare(b.name));
  applyCompetitionPositions(ordered, 'totalPoints');

  const initialOrdered = [...state.initialRankingSnapshot].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  applyCompetitionPositions(initialOrdered, 'points');
  const initialMap = Object.fromEntries(initialOrdered.map(x => [x.name, x.position]));

  ordered.forEach((item) => {
    const previous = initialMap[item.name] ?? item.position;
    item.movementDelta = previous - item.position;
    item.movement = item.movementDelta > 0 ? 'up' : item.movementDelta < 0 ? 'down' : 'same';
  });

  return ordered;
}

function getRoundRanking(round = getCurrentRound()) {
  if (!round || round.resultCruzeiro === null || round.resultOpponent === null) return [];

  const entries = state.users.map((user) => {
    const bet   = getBet(round.id, user.name);
    const score = bet
      ? scorePrediction(bet.cruzeiroGoals, bet.opponentGoals, round.resultCruzeiro, round.resultOpponent)
      : { points: 0, type: 'sem aposta' };

    return {
      name: user.name,
      bet:    bet ? `${bet.cruzeiroGoals}x${bet.opponentGoals}` : 'Sem palpite',
      points: score.points,
      type:   score.type   // 'exato' | 'parcial' | 'erro' | 'sem aposta'
    };
  }).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  applyCompetitionPositions(entries, 'points');
  return entries;
}

function getConsistencyRanking() {
  // missedRounds is now a first-class field on each user from calculateRankings()
  const ranking = calculateRankings().map((user) => ({
    name: user.name,
    average: user.avg,
    scoringRounds: user.scoringRounds,
    zeroRounds: user.zeroRounds,     // apostou e errou
    missedRounds: user.missedRounds, // não apostou
    roundsPlayed: user.roundsPlayed,
    // Missed rounds penalised more heavily (-6) than actual zeros (-3)
    consistencyScore:
      (user.avg * 100) +
      (user.scoringRounds  *  5) -
      (user.zeroRounds     *  3) -
      (user.missedRounds   *  6)
  })).sort((a, b) =>
    b.consistencyScore - a.consistencyScore ||
    b.average - a.average ||
    a.name.localeCompare(b.name)
  );

  applyCompetitionPositions(ranking, 'consistencyScore');
  return ranking;
}

function getUserHistory(userName) {
  return [...state.rounds]
    .sort((a, b) => parseAppDateTime(a.matchTime) - parseAppDateTime(b.matchTime))
    .map((round) => {
      const bet = getBet(round.id, userName);
      const hasResult =
  Number.isInteger(round.resultCruzeiro) &&
  Number.isInteger(round.resultOpponent);
      const score = bet && hasResult
        ? scorePrediction(bet.cruzeiroGoals, bet.opponentGoals, round.resultCruzeiro, round.resultOpponent)
        : null;

      const didNotBet = !bet && hasResult;

      return {
        title: round.title,
        competition: round.competition,
        opponent: round.opponent,
        resultLabel: hasResult ? `${round.resultCruzeiro}x${round.resultOpponent}` : 'A definir',
        betLabel: bet ? `${bet.cruzeiroGoals}x${bet.opponentGoals}` : (didNotBet ? 'Sem palpite' : '-'),
        pointsValue: hasResult ? (score ? score.points : 0) : null,
        pointsLabel: didNotBet ? '0 (não apostou)' : (hasResult ? `${score ? score.points : 0} ${(score && score.points === 1) ? 'ponto' : 'pontos'}` : '-'),
        type: didNotBet ? 'sem aposta' : (score?.type || '-')
      };
    });
}

// Formats a list of names naturally: "A", "A e B", "A, B e C"
function formatNames(names) {
  if (!names.length) return '—';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1];
}

// Returns the round winner label: handles no-score, single winner, ties
function roundWinnerLabel(roundRanking) {
  if (!roundRanking.length) return null;
  const top = roundRanking[0];
  if (top.points === 0) return { text: 'Ninguém pontuou nesta rodada', names: [], points: 0 };
  const tied = roundRanking.filter(r => r.points === top.points);
  return { text: formatNames(tied.map(r => r.name)), names: tied.map(r => r.name), points: top.points };
}

// Returns betting profile label for a player based on their average bet
function bettingProfile(history) {
  const bets = history.filter(h => h.betLabel && h.betLabel !== '-' && h.betLabel !== 'Sem palpite');
  if (!bets.length) return '—';
  const avgCruz = bets.reduce((s, h) => s + Number(h.betLabel.split('x')[0]), 0) / bets.length;
  const avgOpp  = bets.reduce((s, h) => s + Number(h.betLabel.split('x')[1]), 0) / bets.length;
  const diff = avgCruz - avgOpp;
  if (diff > 1)       return '🔵 Optimista';
  if (diff < -0.5)    return '🔴 Pessimista';
  if (avgCruz < 1.2)  return '🤐 Cauteloso';
  return '⚖️ Equilibrado';
}

// Returns current streak for a player: consecutive scoring or non-scoring rounds
function currentStreak(roundScores) {
  if (!roundScores.length) return null;

  // Only consider rounds where the user actually placed a bet
  // Missed rounds (sem aposta) reset the streak
  const sorted = [...roundScores];

  // Find the last round with a bet placed
  let lastIdx = sorted.length - 1;
  while (lastIdx >= 0 && sorted[lastIdx].type === 'sem aposta') lastIdx--;

  // If all rounds were missed, no streak to show
  if (lastIdx < 0) return '—';

  const last = sorted[lastIdx];
  const scoring = last.points > 0;
  let count = 0;

  for (let i = lastIdx; i >= 0; i--) {
    const entry = sorted[i];
    // sem aposta breaks the streak
    if (entry.type === 'sem aposta') break;
    if ((entry.points > 0) === scoring) count++;
    else break;
  }

  if (count === 0) return '—';

  if (scoring) {
    // Check if the current streak is ALL exatos
    const streakEntries = sorted.slice(Math.max(0, lastIdx - count + 1), lastIdx + 1);
    const allExato = streakEntries.every(e => e.type === 'exato');
    const label = `${count} rodada${count > 1 ? 's' : ''} seguida${count > 1 ? 's' : ''}`;
    if (allExato) return `<span class="streak-exato">🔥🔥 ${label} cravando!</span>`;
    return `🔥 ${label} pontuando`;
  }
  return `❄️ ${count} rodada${count > 1 ? 's' : ''} seguida${count > 1 ? 's' : ''} sem pontuar`;
}

function getStatsSummary() {
  const ranking = calculateRankings();
  const roundRanking = getRoundRanking();
  const totalBets = getBetsArray().length;
  const topExact = [...ranking].sort((a, b) => b.exact - a.exact || a.name.localeCompare(b.name))[0];
  const topPartial = [...ranking].sort((a, b) => b.partial - a.partial || a.name.localeCompare(b.name))[0];
  const bestAverage = [...ranking].sort((a, b) => b.avg - a.avg || a.name.localeCompare(b.name))[0];
  const bestEfficiency = [...ranking].sort((a, b) => b.efficiency - a.efficiency || a.name.localeCompare(b.name))[0];
  const mostScoredInRound = roundRanking[0];
  const mostConsistent = getConsistencyRanking()[0];

  return [
    { label: 'Mais acertos exatos', value: topExact ? `${topExact.name}, ${topExact.exact}` : '—' },
    { label: 'Mais acertos parciais', value: topPartial ? `${topPartial.name}, ${topPartial.partial}` : '—' },
    { label: 'Melhor média de pontos', value: bestAverage ? `${bestAverage.name}, ${bestAverage.avg.toFixed(2)}` : '—' },
    { label: 'Maior pontuação na rodada', value: mostScoredInRound ? `${mostScoredInRound.name}, ${mostScoredInRound.points}` : '—' },
    { label: 'Melhor aproveitamento', value: bestEfficiency ? `${bestEfficiency.name}, ${bestEfficiency.efficiency.toFixed(1)}%` : '—' },
    { label: 'Mais consistente', value: mostConsistent ? `${mostConsistent.name}` : '—' },
    { label: 'Total de apostas', value: String(totalBets) },
    { label: 'Participantes', value: String(state.users.length) },
    { label: 'Rodadas registadas', value: String(state.rounds.length) },
    ...state.users.map(u => ({
      label: `Perfil — ${u.name}`,
      value: bettingProfile(getUserHistory(u.name))
    }))
  ];
}


// ── IA do Bolão ──────────────────────────────────────────────

function showAiActions(text, isWhatsApp = false) {
  const copyBtn = el('aiCopyBtn');
  const waBtn = el('aiSendWhatsBtn');
  const emptyMsg = el('aiOutputEmpty');
  if (emptyMsg) emptyMsg.classList.add('hidden');
  if (copyBtn) {
    copyBtn.classList.remove('hidden');
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(text);
      showToast('Copiado!');
    };
  }
  if (waBtn) {
    waBtn.classList.toggle('hidden', !isWhatsApp);
    waBtn.onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
}

async function loadGeminiKey() {
  if (geminiKey) return geminiKey;
  if (window.BOLAO_GEMINI_KEY && window.BOLAO_GEMINI_KEY !== 'SUBSTITUA_PELA_SUA_KEY_AQUI') {
    geminiKey = window.BOLAO_GEMINI_KEY;
    return geminiKey;
  }
  if (!firebaseDbRef) return null;
  try {
    const db = firebase.database();
    const snap = await db.ref('bolao-cruzeiro-debates/state/geminiKey').once('value');
    geminiKey = snap.val() || null;
    return geminiKey;
  } catch {
    return null;
  }
}

// ── Football Data API ─────────────────────────────────────────

// ── Escudos dos clubes ────────────────────────────────────────────
// Fonte única: ficheiros locais dentro da pasta Escudos/
const LOCAL_CRESTS = {
  // Brasileirão
  'cruzeiro': 'Escudos/cruzeiro.svg.png',
  'cruzeiro ec': 'Escudos/cruzeiro.svg.png',
  'flamengo': 'Escudos/flamengo.svg.png',
  'palmeiras': 'Escudos/palmeiras.svg.png',
  'sao paulo': 'Escudos/sao-paulo.svg.png',
  'são paulo': 'Escudos/sao-paulo.svg.png',
  'sao paulo fc': 'Escudos/sao-paulo.svg.png',
  'são paulo fc': 'Escudos/sao-paulo.svg.png',
  'spfc': 'Escudos/sao-paulo.svg.png',
  'corinthians': 'Escudos/corinthians.svg.png',
  'botafogo': 'Escudos/botafogo.svg.png',
  'fluminense': 'Escudos/fluminense.svg.png',
  'atletico mineiro': 'Escudos/atletico-mineiro.svg.png',
  'atlético mineiro': 'Escudos/atletico-mineiro.svg.png',
  'atletico-mg': 'Escudos/atletico-mineiro.svg.png',
  'atlético-mg': 'Escudos/atletico-mineiro.svg.png',
  'atletico mg': 'Escudos/atletico-mineiro.svg.png',
  'atlético mg': 'Escudos/atletico-mineiro.svg.png',
  'cam': 'Escudos/atletico-mineiro.svg.png',
  'gremio': 'Escudos/gremio.svg.png',
  'grêmio': 'Escudos/gremio.svg.png',
  'internacional': 'Escudos/internacional.svg.png',
  'santos': 'Escudos/santos.svg.png',
  'vasco': 'Escudos/vasco.svg.png',
  'vasco da gama': 'Escudos/vasco.svg.png',
  'bahia': 'Escudos/bahia.svg.png',
  'vitoria': 'Escudos/vitoria.svg.png',
  'vitória': 'Escudos/vitoria.svg.png',
  'athletico-pr': 'Escudos/athletico-pr.svg.png',
  'athletico paranaense': 'Escudos/athletico-pr.svg.png',
  'coritiba': 'Escudos/coritiba.svg.png',
  'bragantino': 'Escudos/bragantino.svg.png',
  'rb bragantino': 'Escudos/bragantino.svg.png',
  'red bull bragantino': 'Escudos/bragantino.svg.png',
  'chapecoense': 'Escudos/chapecoense.svg.png',
  'juventude': 'Escudos/juventude.svg.png',
  'mirassol': 'Escudos/mirassol.svg.png',
  'remo': 'Escudos/remo.svg.png',
  // Copa do Brasil
  'goias': 'Escudos/goias.svg.png',
  'goiás': 'Escudos/goias.svg.png',
  // Libertadores
  'boca juniors': 'Escudos/boca-juniors.svg.png',
  'universidad catolica': 'Escudos/universidad-catolica.svg.png',
  'universidad católica': 'Escudos/universidad-catolica.svg.png',
  'universidade catolica': 'Escudos/universidad-catolica.svg.png',
  'universidade católica': 'Escudos/universidad-catolica.svg.png',
  'barcelona sc': 'Escudos/barcelona-sc.svg.png',
  'barcelona de quito': 'Escudos/barcelona-sc.svg.png',
  'barcelona quito': 'Escudos/barcelona-sc.svg.png'
};

// Atlético Mineiro leva o escudo de cabeça para baixo 😄
const FLIPPED_CRESTS = ['atletico mineiro', 'atlético mineiro', 'atletico-mg', 'atlético-mg'];

function normalizeTeamName(name = '') {
  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

function getLocalCrest(teamName) {
  const normalized = normalizeTeamName(teamName);

  for (const [key, value] of Object.entries(LOCAL_CRESTS)) {
    if (normalizeTeamName(key) === normalized) return value;
  }

  for (const [key, value] of Object.entries(LOCAL_CRESTS)) {
    const nk = normalizeTeamName(key);
    if (normalized.includes(nk) || nk.includes(normalized)) return value;
  }

  return 'Escudos/default.svg';
}

// Gera o HTML de uma imagem de escudo, com suporte a flip para o Galo
function crestImgHTML(url, name, size = 36) {
  const nameLower = (name || '').toLowerCase();
  const isFlipped = FLIPPED_CRESTS.some(n => nameLower.includes(n));
  const flipStyle = isFlipped ? 'transform:rotate(180deg);' : '';
  const title = isFlipped ? `${name} 😄` : name;
  return `<img src="${url}" alt="${name}" title="${title}" width="${size}" height="${size}" style="object-fit:contain;${flipStyle}" onerror="this.onerror=null;this.src='Escudos/default.svg'" />`;
}

const CRUZEIRO_ID = 1625; // ID do Cruzeiro na football-data.org
const BRASILEIRAO_ID = 2013; // ID da Série A

async function fetchFootballData(endpoint) {
  const key = window.BOLAO_FOOTBALL_KEY;
  if (!key || key === 'cole_o_seu_token_aqui') return null;
  const proxies = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ];
  const url = `https://api.football-data.org/v4/${endpoint}`;
  for (const makeUrl of proxies) {
    try {
      const res = await fetch(makeUrl(url), {
        headers: { 'X-Auth-Token': key },
        signal: AbortSignal.timeout(7000)
      });
      if (res.ok) return await res.json();
    } catch { /* tenta próximo */ }
  }
  return null;
}


function renderMatchHeader(containerId, round, extraHTML = '') {
  const el_ = document.getElementById(containerId);
  if (!el_) return;

  const cruzeiroCrest = getLocalCrest('cruzeiro');
  const opponentCrest = getLocalCrest(round.opponent);

  el_.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:10px;">
        ${crestImgHTML(cruzeiroCrest, 'Cruzeiro', 36)}
        <strong style="font-size:1.05rem;">Cruzeiro</strong>
      </div>
      <span style="color:var(--text-3);font-weight:700;font-size:1.1rem;">×</span>
      <div style="display:flex;align-items:center;gap:10px;">
        ${crestImgHTML(opponentCrest, round.opponent, 36)}
        <strong style="font-size:1.05rem;">${round.opponent}</strong>
      </div>
    </div>
    <p style="margin:6px 0 0;color:var(--text-2);font-size:.88rem;">${round.competition}</p>
    ${extraHTML}
  `;
}

async function getCruzeiroContext() {
  // Busca últimos 3 jogos e próximo jogo do Cruzeiro em paralelo
  const [matches] = await Promise.all([
    fetchFootballData(`teams/${CRUZEIRO_ID}/matches?status=FINISHED&limit=3`),
  ]);

  let recentResults = '';
  let formData = '';

  if (matches?.matches?.length) {
    const recent = matches.matches.slice(-3).reverse();
    recentResults = recent.map(m => {
      const home = m.homeTeam.name;
      const away = m.awayTeam.name;
      const gh = m.score.fullTime.home;
      const ga = m.score.fullTime.away;
      const isCruzeiroHome = m.homeTeam.id === CRUZEIRO_ID;
      const cruzeiroGoals = isCruzeiroHome ? gh : ga;
      const opponentGoals = isCruzeiroHome ? ga : gh;
      const opponent = isCruzeiroHome ? away : home;
      const result = cruzeiroGoals > opponentGoals ? 'vitória' : cruzeiroGoals < opponentGoals ? 'derrota' : 'empate';
      return `${result} ${cruzeiroGoals}x${opponentGoals} vs ${opponent} (${m.competition.name})`;
    }).join('; ');

    // Forma recente: V/E/D
    formData = recent.map(m => {
      const isCruzeiroHome = m.homeTeam.id === CRUZEIRO_ID;
      const cg = isCruzeiroHome ? m.score.fullTime.home : m.score.fullTime.away;
      const og = isCruzeiroHome ? m.score.fullTime.away : m.score.fullTime.home;
      return cg > og ? 'V' : cg < og ? 'D' : 'E';
    }).reverse().join('-');
  }

  return { recentResults, formData };
}

async function callGemini(prompt) {
  const key = await loadGeminiKey();
  if (!key) throw new Error('Chave Gemini não disponível. Certifica-te que estás logado como admin.');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 800 }
      })
    }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err?.error?.message || 'Erro na API Gemini.');
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta.';
}

async function aiAnalyzeRound() {
  const btn = el('aiAnalyzeBtn');
  const out = el('aiOutput');

  // Usa a última rodada com resultado lançado (finalizada ou com resultado)
  const round = [...state.rounds]
    .filter(r => r.resultCruzeiro !== null && r.resultOpponent !== null)
    .sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime))[0];

  if (!round) {
    out.textContent = 'Nenhuma rodada com resultado lançado ainda.';
    out.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="ai-spinner"></span> A analisar...';
  out.classList.remove('hidden');
  out.innerHTML = '<span class="ai-loading-text">⚽ A buscar dados e a gerar análise...</span>';

  const roundRanking = getRoundRanking(round);
  const ranking = calculateRankings();
  const footballCtx = await getCruzeiroContext();

  const exactos = roundRanking.filter(r => r.type === 'exato').map(r => r.name);
  const zeros = roundRanking.filter(r => r.points === 0).map(r => r.name);

  const prompt = `Você é o narrador oficial do Bolão Cruzeiro Debates — grupo de amigos apaixonados pelo Cruzeiro. Escreva um comentário pós-jogo APENAS com os dados abaixo. PROIBIDO inventar informações, jogadores, lances ou factos que não constes nos dados fornecidos. Use os nomes reais dos apostadores, provoque quem errou, elogie quem acertou. Português do Brasil, gírias de futebol, emojis, máximo 4 parágrafos.

RESULTADO DO BOLÃO:
Jogo: Cruzeiro ${round.resultCruzeiro}x${round.resultOpponent} ${round.opponent} — ${round.competition}
Acertou placar EXATO: ${exactos.length ? exactos.join(', ') : 'ninguém'}
Não pontuou nada: ${zeros.length ? zeros.join(', ') : 'ninguém'}
Apostas: ${roundRanking.map(r => `${r.name} apostou ${r.bet} → ${r.points}pt (${r.type})`).join('; ')}
Top 3 ranking: ${ranking.slice(0, 3).map(r => `${r.position}º ${r.name} ${r.totalPoints}pts`).join(', ')}
${footballCtx?.recentResults ? `
FORMA RECENTE DO CRUZEIRO (dados reais): ${footballCtx.recentResults}` : ''}
${footballCtx?.formData ? `Forma: ${footballCtx.formData}` : ''}`;

  try {
    const text = await callGemini(prompt);
    out.textContent = text;
    showAiActions(text);
  } catch (e) {
    out.textContent = `Erro: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🏆 Analisar rodada atual';
  }
}

async function aiPredictMatch() {
  const btn = el('aiPredictBtn');
  const out = el('aiOutput');

  // Usa apenas rodada em aberto ou em espera — nunca uma já finalizada
  const sorted = [...state.rounds]
    .sort((a, b) => parseAppDateTime(a.matchTime) - parseAppDateTime(b.matchTime));
  const round = sorted.find(r => ['open', 'upcoming'].includes(effectiveRoundState(r)));

  if (!round) {
    out.textContent = 'Sem rodada aberta ou em espera para prever. Aguarda a próxima rodada ser criada.';
    out.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="ai-spinner"></span> A prever...';
  out.classList.remove('hidden');
  out.innerHTML = '<span class="ai-loading-text">🔮 A analisar histórico e gerar previsão...</span>';

  const ranking = calculateRankings();
  const footballCtx = await getCruzeiroContext();
  const allHistory = ranking.map(u => {
    const h = getUserHistory(u.name).filter(x => x.betLabel !== '-' && x.betLabel !== 'Sem palpite');
    const resumo = h.slice(-5).map(x => `apostou ${x.betLabel} (resultado ${x.resultLabel}, ${x.pointsLabel})`).join('; ');
    return `${u.name}: ${resumo || 'sem apostas ainda'}`;
  });

  const prompt = `Você é o Oráculo do Bolão Cruzeiro Debates. Faça uma previsão para Cruzeiro x ${round.opponent} (${round.competition}) usando APENAS os dados abaixo. PROIBIDO inventar estatísticas, jogadores ou informações que não constem nos dados. Base a previsão no histórico real de apostas de cada jogador. Português do Brasil, divertido, emojis, máximo 4 parágrafos.

PRÓXIMO JOGO: Cruzeiro x ${round.opponent} — ${round.competition}
${footballCtx?.recentResults ? `FORMA RECENTE DO CRUZEIRO (dados reais da API): ${footballCtx.recentResults}` : 'NOTA: dados de forma do Cruzeiro indisponíveis agora.'}
${footballCtx?.formData ? `Sequência de resultados: ${footballCtx.formData}` : ''}

HISTÓRICO DE APOSTAS DOS PARTICIPANTES:
${allHistory.join('\n')}
RANKING: ${ranking.slice(0, 5).map(r => `${r.position}º ${r.name} ${r.totalPoints}pts`).join(' | ')}`;

  try {
    const text = await callGemini(prompt);
    out.textContent = text;
    showAiActions(text, false);
  } catch (e) {
    out.textContent = `Erro: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔮 Gerar previsão';
  }
}

async function aiGenerateWhatsApp() {
  const btn = el('aiWhatsBtn');
  const out = el('aiOutput');
  const round = getCurrentRound();

  btn.disabled = true;
  btn.innerHTML = '<span class="ai-spinner"></span> A criar mensagem...';
  out.classList.remove('hidden');
  out.innerHTML = '<span class="ai-loading-text">📲 A preparar mensagem para o grupo...</span>';

  const ranking = calculateRankings();
  const roundRanking = getRoundRanking(round);

  const lider = ranking[0];
  const lanterna = ranking[ranking.length - 1];
  const prompt = `Crie uma mensagem para o grupo de WhatsApp do Bolão Cruzeiro Debates. Escreva em português do Brasil, estilo animado de grupo de amigos. Use os nomes reais. Provoque o último colocado pelo nome com bom humor, elogie o líder. Inclua o ranking completo formatado para WhatsApp. Use emojis 💙⚽🏆🔥. Máximo 20 linhas.

RANKING COMPLETO: ${ranking.map(r => `${r.position}º ${r.name} — ${r.totalPoints} pts (${r.exact} exatos)`).join(' | ')}
LÍDER: ${lider?.name} com ${lider?.totalPoints} pontos
LANTERNA: ${lanterna?.name} com ${lanterna?.totalPoints} pontos
${round ? `PRÓXIMO JOGO: Cruzeiro x ${round.opponent} — ${round.competition}` : ''}
${roundRanking.length ? `DESTAQUE DA ÚLTIMA RODADA: ${roundRanking[0]?.name} com ${roundRanking[0]?.points} ponto${roundRanking[0]?.points !== 1 ? 's' : ''}` : ''}`;

  try {
    const text = await callGemini(prompt);
    out.textContent = text;
    showAiActions(text, true);
    const waMsgEl = el('whatsMessage');
    if (waMsgEl) waMsgEl.value = text;
  } catch (e) {
    out.textContent = `Erro: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '📲 Gerar mensagem';
  }
}
function movementHTML(movement, delta) {
  if (movement === 'up') return `<span class="movement up">↑ ${Math.abs(delta)}</span>`;
  if (movement === 'down') return `<span class="movement down">↓ ${Math.abs(delta)}</span>`;
  return `<span class="movement same">—</span>`;
}

function badge(type) {
  if (!type || type === '-') return '-';
  const labels = { exato: 'Exato', parcial: 'Parcial', erro: 'Não pontuou', 'sem aposta': 'Sem palpite' };
  const cls    = { exato: 'exato', parcial: 'parcial', erro: 'erro',         'sem aposta': 'erro' };
  return `<span class="badge ${cls[type] || ''}">${labels[type] || type}</span>`;
}


const AVATAR_COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#10B981', '#F59E0B', '#EF4444', '#06B6D4', '#84CC16', '#F97316', '#6366F1', '#14B8A6'];

function avatarHTML(name) {
  const idx = name.charCodeAt(0) % AVATAR_COLORS.length;
  const color = AVATAR_COLORS[idx];
  const initial = name.charAt(0).toUpperCase();
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${color};color:#fff;font-size:.75rem;font-weight:800;flex-shrink:0;vertical-align:middle;margin-right:6px;">${initial}</span>`;
}

function positionDisplay(pos) {
  if (pos === 1) return '🥇';
  if (pos === 2) return '🥈';
  if (pos === 3) return '🥉';
  return `${pos}º`;
}

function tableHTML(headers, rows, highlightFirst = false) {
  const tbody = rows.map((r, i) => {
    const isFirst = highlightFirst && i === 0;
    const style = isFirst ? ' style="background:rgba(215,184,107,0.10);border-left:3px solid var(--gold);"' : '';
    return `<tr${style}>${r.map(c => `<td>${c}</td>`).join('')}</tr>`;
  }).join('');
  return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${tbody}</tbody></table>`;
}

function mobileCardsHTML(headers, rows, highlightFirst = false, primaryCol = 1, valueCol = 2) {
  return `<div class="mobile-cards" style="display:none">${rows.map((r, i) => {
    const isFirst = highlightFirst && i === 0;
    const goldStyle = isFirst ? ' mobile-card--gold' : '';
    const pairs = headers.map((h, j) => ({ h, v: r[j] }));
    const primary = pairs[primaryCol] || pairs[0];
    const secondary = pairs[valueCol] || pairs[1];
    const rest = pairs.filter((_, j) => j !== primaryCol && j !== valueCol && j !== 0);
    const pos = pairs[0];
    return `<div class="mobile-card${goldStyle}">
      <div class="mobile-card-top">
        <span class="mobile-card-pos">${pos.v}</span>
        <span class="mobile-card-name">${primary.v}</span>
        <span class="mobile-card-pts">${secondary.h}: <strong>${secondary.v}</strong></span>
      </div>
      ${rest.length ? `<div class="mobile-card-meta">${rest.map(p => `<span><em>${p.h}:</em> ${p.v}</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function responsiveTableHTML(headers, rows, highlightFirst = false, primaryCol = 1, valueCol = 2) {
  return tableHTML(headers, rows, highlightFirst) +
         mobileCardsHTML(headers, rows, highlightFirst, primaryCol, valueCol);
}

function renderLoginOptions() {
  const select = el('loginName');
  select.innerHTML = '<option value="">Selecione...</option>' + state.users.map(u => `<option value="${u.name}">${u.name}</option>`).join('');
}

function updateLoginHint() {
  const name = el('loginName').value;
  const user = state.users.find(u => u.name === name);

  if (!user) {
    el('loginHint').textContent = 'Selecione um participante para continuar.';
    el('loginSubmitBtn').textContent = 'Entrar';
    return;
  }

  if (!user.pin) {
    el('loginHint').textContent = 'Primeiro acesso: defina agora o seu PIN de 4 dígitos.';
    el('loginSubmitBtn').textContent = 'Criar PIN e entrar';
  } else {
    el('loginHint').textContent = 'Acesso existente: insira o PIN já cadastrado.';
    el('loginSubmitBtn').textContent = 'Entrar';
  }
}

async function loginOrRegister(name, pin) {
  const user = state.users.find(u => u.name === name);

  if (!user) {
    showToast('Selecione um nome válido.');
    return false;
  }

  if (!/^\d{4}$/.test(pin)) {
    showToast('O PIN deve ter 4 dígitos.');
    return false;
  }

  const newPinHash = await hashPin(pin, user.id); // current format: pepper + userId + pin
  const oldPinHash = await hashPin(pin);            // legacy format: pepper + pin (no userId)

  if (!user.pin) {
    // First access: store hash with salt
    user.pin = newPinHash;
    saveState('users');
    showToast('PIN criado com sucesso.');
  } else {
    const storedIsHashed = isPinHashed(user.pin);
    const match = storedIsHashed
      ? (user.pin === newPinHash || user.pin === oldPinHash) // accept both hash formats
      : (user.pin === pin);                                  // legacy plain text

    if (!match) {
      showToast('PIN inválido.');
      return false;
    }

    // Migrate plain text OR old hash (no salt) to new hash with userId salt
    if (!storedIsHashed || user.pin === oldPinHash) {
      user.pin = newPinHash;
      saveState('users');
    }
  }

  session.user = user;
  const firebaseUid = getFirebaseUid();
  user.firebaseUid = firebaseUid;
  saveState('users');
  saveSession(user);
  el('logoutBtn').classList.remove('hidden');
  // Inicia/actualiza chat após login — initChat é seguro de chamar múltiplas vezes
  // Garante que o listener admin é registado se o utilizador for admin
  if (firebaseSyncEnabled) initChat();
  navigate('round');
  showToast(`Bem-vindo, ${user.name}.`);
  return true;
}

function logout() {
  session.user = null;
  clearSession();
  el('logoutBtn').classList.add('hidden');
  navigate('home');
}

function renderSidebarUser() {
  const user = currentUser();
  el('sidebarUserName').textContent = user ? user.name : 'Visitante';
  el('sidebarUserMeta').textContent = user ? (user.isAdmin ? 'Administrador' : 'Participante') : 'Faça login para apostar';
  el('adminNavBtn').classList.toggle('hidden', !user?.isAdmin);
  // Sync bottom nav admin button
  const bottomNavAdmin = el('bottomNavAdmin');
  if (bottomNavAdmin) bottomNavAdmin.classList.toggle('hidden', !user?.isAdmin);
}

function renderHome() {
  const user = currentUser();
  const round = getCurrentRound();

  // Toggle guest vs logged-in sections
  el('homeGuest').classList.toggle('hidden', !!user);
  el('homeUser').classList.toggle('hidden', !user);

  // ── Render next match info (both states have their own element) ──
  const matchExtraHTML = round ? `
    <p style="margin:4px 0 0;">${formatDateTime(round.matchTime)}</p>
    <p class="highlight" style="margin:4px 0 0;">${roundStateLabel(round)}</p>
    ${effectiveRoundState(round) === 'open' ? (() => {
      const missing = getMissingBettors(round);
      return missing.length
        ? `<p class="highlight" style="margin:4px 0 0;">⚠️ Faltam: ${missing.map(u => u.name).join(', ')}</p>`
        : `<p class="highlight" style="margin:4px 0 0;">✅ Todos já apostaram</p>`;
    })() : ''}
  ` : '';

  // Guest state
  if (!user) {
    renderLoginOptions();
    updateLoginHint();
    const nm = el('homeNextMatch');
    if (nm) {
      if (round) renderMatchHeader('homeNextMatch', round, matchExtraHTML);
      else nm.innerHTML = '<p class="muted">Nenhuma rodada disponível.</p>';
    }

    const lastFinalized = [...state.rounds]
      .filter(r => effectiveRoundState(r) === 'finalized' && r.resultCruzeiro !== null)
      .sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime))[0];
    const perfectInLast = lastFinalized
      ? getRoundRanking(lastFinalized).filter(r => r.type === 'exato').map(r => r.name)
      : [];
    const lhc = el('lastHighlightCard');
    if (lhc) {
      const lastClosedG = [...state.rounds]
        .filter(r => {
          const rs = effectiveRoundState(r);
          return (rs === 'finalized' || rs === 'result' || rs === 'closed') && r.resultCruzeiro !== null && r.resultOpponent !== null;
        })
        .sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime))[0];
      const lastClosedRankingG = lastClosedG ? getRoundRanking(lastClosedG) : [];
      const lastClosedWinnerG = lastClosedRankingG.length ? roundWinnerLabel(lastClosedRankingG) : null;
      const highlightTextG = lastClosedWinnerG
        ? (lastClosedWinnerG.points === 0
            ? 'Ninguém pontuou na última rodada.'
            : `${lastClosedWinnerG.text} ${lastClosedWinnerG.names.length > 1 ? 'foram os jogadores' : 'foi o jogador'} da última rodada com ${lastClosedWinnerG.points} ponto${lastClosedWinnerG.points !== 1 ? 's' : ''}.`)
        : state.lastRoundHighlight.text;
      lhc.innerHTML = `
        ${perfectInLast.length ? `<p style="color:var(--gold);font-weight:700">🏆 Rodada perfeita: ${formatNames(perfectInLast)}!</p>` : ''}
        <p class="highlight">🔥 ${highlightTextG}</p>
      `;
    }

    const upcoming = [...state.rounds]
      .filter(r => effectiveRoundState(r) === 'upcoming')
      .sort((a, b) => parseAppDateTime(a.matchTime) - parseAppDateTime(b.matchTime));
    const upcomingPanel = el('homeUpcomingPanel');
    if (upcomingPanel) {
      upcomingPanel.classList.toggle('hidden', !upcoming.length);
      const upcomingWrap = el('homeUpcomingRounds');
      if (upcomingWrap) upcomingWrap.innerHTML = upcoming.map(r => `
        <div style="padding:8px 0;border-bottom:1px solid var(--line);">
          <p style="margin:0"><strong>Cruzeiro x ${r.opponent}</strong></p>
          <p style="margin:2px 0;font-size:.85rem;color:var(--text-2)">${r.competition} — ${formatDateTime(r.matchTime)}</p>
        </div>
      `).join('');
    }
    return;
  }

  // Logged-in state
  const userRanking = calculateRankings().find(x => x.name === user.name);
  const nmLogged = el('homeNextMatchLogged');
  if (nmLogged) {
    if (round) renderMatchHeader('homeNextMatchLogged', round, matchExtraHTML);
    else nmLogged.innerHTML = '<p class="muted">Nenhuma rodada disponível.</p>';
  }

  const lhcLogged = el('lastHighlightCardLogged');
  if (lhcLogged) {
    const lastClosed = [...state.rounds]
      .filter(r => {
        const rs = effectiveRoundState(r);
        return (rs === 'finalized' || rs === 'result' || rs === 'closed') && r.resultCruzeiro !== null && r.resultOpponent !== null;
      })
      .sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime))[0];
    const lastClosedRanking = lastClosed ? getRoundRanking(lastClosed) : [];
    const lastClosedWinner = lastClosedRanking.length ? roundWinnerLabel(lastClosedRanking) : null;
    const highlightText = lastClosedWinner
      ? (lastClosedWinner.points === 0
          ? 'Ninguém pontuou na última rodada.'
          : `${lastClosedWinner.text} ${lastClosedWinner.names.length > 1 ? 'foram os jogadores' : 'foi o jogador'} da última rodada com ${lastClosedWinner.points} ponto${lastClosedWinner.points !== 1 ? 's' : ''}.`)
      : state.lastRoundHighlight.text;
    lhcLogged.innerHTML = `<p class="highlight">🔥 ${highlightText}</p>`;
  }

  const welcome = el('homeUserWelcome');
  if (welcome && userRanking) {
    const bet = round ? getBet(round.id, user.name) : null;
    const betStatus = round && effectiveRoundState(round) === 'open'
      ? (bet
          ? `<p style="color:var(--green)">✅ Apostaste ${bet.cruzeiroGoals}x${bet.opponentGoals}</p>`
          : `<p style="color:var(--yellow)">⚠️ Você ainda não apostou nesta rodada! <button class="btn btn-primary" style="padding:6px 12px;font-size:.85rem;margin-top:6px;" onclick="navigate('round')">Apostar agora</button></p>`)
      : '';
    welcome.innerHTML = `
      <h2 style="margin:8px 0 4px;font-size:1.6rem;font-weight:900;letter-spacing:-0.02em">${user.name} 👋</h2>
      <p class="muted" style="margin:0 0 12px">${user.isAdmin ? 'Administrador' : 'Participante'}</p>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:12px;">
        <div><span class="mini-label">Posição</span><div style="font-size:1.4rem;font-weight:800">${userRanking.position}º</div></div>
        <div><span class="mini-label">Pontos</span><div style="font-size:1.4rem;font-weight:800">${userRanking.totalPoints}</div></div>
        <div><span class="mini-label">Exatos</span><div style="font-size:1.4rem;font-weight:800">${userRanking.exact}</div></div>
        <div><span class="mini-label">Parciais</span><div style="font-size:1.4rem;font-weight:800">${userRanking.partial}</div></div>
      </div>
      ${betStatus}
      <div class="change-pin-wrap">
        <button class="ios-btn ios-btn-gray" id="changePinToggleBtn">🔑 Alterar PIN</button>
        <div class="change-pin-form hidden" id="changePinFormInline">
          <div class="change-pin-fields">
            <label>PIN atual<input type="password" id="pinOldInput" inputmode="numeric" maxlength="4" placeholder="••••" /></label>
            <label>Novo PIN<input type="password" id="pinNewInput" inputmode="numeric" maxlength="4" placeholder="••••" /></label>
            <label>Confirmar<input type="password" id="pinConfirmInput" inputmode="numeric" maxlength="4" placeholder="••••" /></label>
          </div>
          <div class="change-pin-actions">
            <button class="ios-btn ios-btn-green" id="pinSaveBtn">✅ Salvar novo PIN</button>
            <button class="ios-btn ios-btn-gray" id="pinCancelBtn">Cancelar</button>
          </div>
          <div class="change-pin-msg hidden" id="changePinMsg"></div>
        </div>
      </div>
    `;
    // Attach events after innerHTML is set
    el('changePinToggleBtn')?.addEventListener('click', () => {
      const form = el('changePinFormInline');
      const isHidden = form.classList.toggle('hidden');
      el('changePinToggleBtn').textContent = isHidden ? '🔑 Alterar PIN' : '✖ Fechar';
      if (!isHidden) el('pinOldInput')?.focus();
    });
    el('pinCancelBtn')?.addEventListener('click', () => {
      el('changePinFormInline')?.classList.add('hidden');
      el('changePinToggleBtn').textContent = '🔑 Alterar PIN';
    });
    el('pinSaveBtn')?.addEventListener('click', () => changeOwnPin());
  }
}

function renderDashboard() {
  const user = currentUser();
  const round = getCurrentRound();

  if (!user || !round) {
    el('dashboardNextMatch').innerHTML = '<p>Faça login para acompanhar a rodada.</p>';
    el('userPerformanceCard').innerHTML = '<p class="muted">Sem dados disponíveis.</p>';
    el('quickHistory').innerHTML = '<p class="muted">Sem histórico visível.</p>';
    el('betForm').classList.add('hidden');
    el('betConfirmation').classList.add('hidden');
    el('roundStatusPill').textContent = '-';
    stopCountdown();
    return;
  }

  const userRanking = calculateRankings().find(x => x.name === user.name);
  const bet = getBet(round.id, user.name);
  const stateNow = effectiveRoundState(round);

  el('roundStatusPill').textContent = roundStateLabel(round);
  el('roundStatusPill').classList.toggle('upcoming', effectiveRoundState(round) === 'upcoming');

  // Barra de progresso de apostas
  const totalUsers = state.users.length;
  const betsPlaced = getBetsArray().filter(b => b.roundId === round.id).length;
  const progressPct = totalUsers > 0 ? Math.round((betsPlaced / totalUsers) * 100) : 0;
  const progressBar = stateNow === 'open' ? `
    <div style="margin-top:10px;">
      <div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--text-2);margin-bottom:4px;">
        <span>Apostas recebidas</span>
        <span>${betsPlaced}/${totalUsers}</span>
      </div>
      <div style="background:rgba(255,255,255,.08);border-radius:999px;height:8px;overflow:hidden;">
        <div style="background:${progressPct === 100 ? 'var(--green)' : 'var(--accent)'};width:${progressPct}%;height:100%;border-radius:999px;transition:width .4s ease;"></div>
      </div>
    </div>` : '';

  const dashboardExtra = `
    <p style="margin:6px 0 2px;"><strong>Jogo:</strong> ${formatDateTime(round.matchTime)}</p>
    <p style="margin:0 0 2px;"><strong>Prazo:</strong> ${formatDateTime(round.deadline)} (${APP_TIMEZONE_LABEL})</p>
    ${progressBar}
  `;
  renderMatchHeader('dashboardNextMatch', round, dashboardExtra);

  el('userPerformanceCard').innerHTML = userRanking ? `
    <p><strong>Posição atual:</strong> ${userRanking.position}º</p>
    <p><strong>Pontos:</strong> ${userRanking.totalPoints}</p>
    <p><strong>Exatos:</strong> ${userRanking.exact}, <strong>Parciais:</strong> ${userRanking.partial}</p>
  ` : '<p class="muted">Sem dados.</p>';

  el('deadlineText').textContent = `Apostas encerram em ${formatDateTime(round.deadline)}, ${APP_TIMEZONE_LABEL}.`;
  startCountdown(round.deadline);

  el('betForm').classList.remove('hidden');
  el('betCruzeiro').value = bet?.cruzeiroGoals ?? '';
  el('betOpponent').value = bet?.opponentGoals ?? '';

  // Banner de notificação de aposta em falta
  const bannerEl = el('betMissingBanner');
  if (bannerEl) {
    const showBanner = stateNow === 'open' && !bet;
    bannerEl.classList.toggle('hidden', !showBanner);
  }

  // Atualizar labels com o nome real do adversário e jogo
  const betTitle = el('betFormTitle');
  const betOpponentLabel = el('betOpponentLabel');
  if (betTitle) betTitle.textContent = `Fazer aposta — Cruzeiro x ${round.opponent}`;
  if (betOpponentLabel) betOpponentLabel.firstChild.textContent = round.opponent;

  const disabled = stateNow !== 'open';
  Array.from(el('betForm').querySelectorAll('input, button')).forEach(node => node.disabled = disabled);

  if (bet) {
    el('betConfirmation').classList.remove('hidden');
    el('betConfirmation').innerHTML = `<strong>Palpite registrado:</strong> ${bet.cruzeiroGoals}x${bet.opponentGoals}<br><span class="muted">Última gravação: ${formatDateTime(bet.updatedAt)}</span>`;
  } else {
    el('betConfirmation').classList.add('hidden');
  }

 const history = getUserHistory(user.name).slice(-5).reverse();
el('quickHistory').innerHTML = history.length
  ? `<ul>${history.map(item => {
      let lineText = '';

      if (item.betLabel === 'Sem palpite' || item.betLabel === '-') {
        lineText = `${item.title}, sem palpite`;
      } else if (item.pointsLabel === '-') {
        lineText = `${item.title}, ${item.betLabel}, aguardando resultado`;
      } else {
        lineText = `${item.title}, ${item.betLabel}, ${item.pointsLabel}`;
      }

      return `<li>${lineText}</li>`;
    }).join('')}</ul>`
  : '<p class="muted">Ainda não há histórico deste jogador.</p>';
}

function renderRanking() {
  const ranking = calculateRankings();
  const roundRanking = getRoundRanking();
  const consistency = getConsistencyRanking();

  if (!roundRanking.length) {
    el('roundRankingWrap').innerHTML = '<p class="muted">O destaque da rodada aparece quando o resultado é lançado.</p>';
  } else {
    const winner      = roundWinnerLabel(roundRanking);
    const movementBest = [...ranking].sort((a, b) => b.movementDelta - a.movementDelta || a.name.localeCompare(b.name))[0];
    const winnerLabel  = winner.points === 0
      ? '<span class="muted">Ninguém pontuou nesta rodada</span>'
      : `<span class="highlight">${winner.text}</span>`;

    el('roundRankingWrap').innerHTML = `
      <p><span class="highlight">Jogador(es) da rodada:</span> ${winnerLabel}</p>
      <p><span class="highlight">Maior subida:</span> ${movementBest ? `${movementBest.name} (${movementBest.movementDelta > 0 ? '+' + movementBest.movementDelta : movementBest.movementDelta})` : '—'}</p>
      ${responsiveTableHTML(['Pos.', 'Nome', 'Aposta', 'Pontos', 'Tipo'], roundRanking.map(item => [`${item.position}º`, item.name, item.bet, String(item.points), badge(item.type)]))}
    `;
  }

  // Streak column in overall ranking
  el('overallRankingWrap').innerHTML = responsiveTableHTML(
    ['Pos.', 'Nome', 'Pontos', 'Mov.', 'Exatos', 'Parciais', 'Sequência'],
    ranking.map(item => [
      positionDisplay(item.position),
      avatarHTML(item.name) + ' ' + item.name,
      String(item.totalPoints),
      movementHTML(item.movement, item.movementDelta),
      String(item.exact),
      String(item.partial),
      item.roundScores.length ? currentStreak(item.roundScores) : '—'
    ]),
    true
  );

  el('consistencyWrap').innerHTML = responsiveTableHTML(
    ['Pos.', 'Nome', 'Média', 'Pontuou', 'Zeros', 'Sem palpite', 'Rodadas'],
    consistency.map(item => [
      positionDisplay(item.position),
      avatarHTML(item.name) + ' ' + item.name,
      item.average.toFixed(2),
      String(item.scoringRounds),
      String(item.zeroRounds),
      String(item.missedRounds),
      String(item.roundsPlayed)
    ]),
    true
  );
}

function renderRoundViewSelect() {
  const select = el('roundViewSelect');
  if (!select) return;

  // Ordenar rodadas da mais recente para a mais antiga
  const sorted = [...state.rounds].sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime));

  // Guardar seleção atual se já existir
  const current = select.value;

  select.innerHTML = sorted.map(r => {
    const label = `${r.title} — Cruzeiro x ${r.opponent}`;
    return `<option value="${r.id}">${label}</option>`;
  }).join('');

  // Restaurar seleção ou usar rodada atual por defeito
  if (current && sorted.find(r => r.id === current)) {
    select.value = current;
  } else {
    const defaultRound = getCurrentRound();
    if (defaultRound) select.value = defaultRound.id;
  }
}

function renderRound() {
  renderRoundViewSelect();

  const select = el('roundViewSelect');
  const selectedId = select?.value;
  const round = selectedId ? state.rounds.find(r => r.id === selectedId) : getCurrentRound();

  if (!round) {
    el('roundSummary').innerHTML = '<p>Nenhuma rodada disponível.</p>';
    el('roundTableWrap').innerHTML = '';
    return;
  }

 const hasResult =
  Number.isInteger(round.resultCruzeiro) &&
  Number.isInteger(round.resultOpponent);
  const resultText = hasResult ? `${round.resultCruzeiro}x${round.resultOpponent}` : 'Ainda não lançado';

  const roundRanking = getRoundRanking(round);

  // Aposta mais popular
  const allBets = getBetsArray().filter(b => b.roundId === round.id);
  const betCounts = {};
  allBets.forEach(b => {
    const key = `${b.cruzeiroGoals}x${b.opponentGoals}`;
    betCounts[key] = (betCounts[key] || 0) + 1;
  });
  const popularBet = Object.entries(betCounts).sort((a, b) => b[1] - a[1])[0];
  const popularBetText = popularBet
    ? `${popularBet[0]} (${popularBet[1]} aposta${popularBet[1] > 1 ? 's' : ''})`
    : '—';

  // Winner label — só após resultado
  const winner = hasResult && roundRanking.length ? roundWinnerLabel(roundRanking) : null;
  const winnerText = !winner
    ? ''
    : winner.points === 0
      ? '<p><strong>Jogador(es) da rodada:</strong> <span class="muted">Ninguém pontuou</span></p>'
      : `<p><strong>Jogador(es) da rodada:</strong> <span class="highlight">${winner.text}</span></p>`;

  // Rodada perfeita — só após resultado
  const perfectPlayers = hasResult ? roundRanking.filter(r => r.type === 'exato').map(r => r.name) : [];
  const perfectText = perfectPlayers.length
    ? `<p>🏆 <strong>Rodada perfeita:</strong> <span class="highlight" style="color:var(--gold)">${formatNames(perfectPlayers)} acertar${perfectPlayers.length > 1 ? 'am' : 'ou'} o placar exato!</span></p>`
    : '';

  el('roundSummary').innerHTML = `
    <span class="mini-label">Resumo</span>
    <h3>${round.title}</h3>
    <p><strong>Jogo:</strong> Cruzeiro x ${round.opponent}</p>
    <p><strong>Competição:</strong> ${round.competition}</p>
    <p><strong>Estado:</strong> ${roundStateLabel(round)}</p>
    <p><strong>Fecho:</strong> ${formatDateTime(round.deadline)} (${APP_TIMEZONE_LABEL})</p>
    <p><strong>Resultado real:</strong> ${resultText}</p>
    <p><strong>Aposta mais popular:</strong> ${popularBetText}</p>
    ${winnerText}
    ${perfectText}
  `;

  const rows = state.users.map(user => {
    const bet   = getBet(round.id, user.name);
    const score = bet && hasResult
      ? scorePrediction(bet.cruzeiroGoals, bet.opponentGoals, round.resultCruzeiro, round.resultOpponent)
      : null;
    const noBetWithResult = !bet && hasResult;

    return [
      user.name,
      bet             ? `${bet.cruzeiroGoals}x${bet.opponentGoals}` : (noBetWithResult ? 'Sem palpite' : '—'),
      noBetWithResult ? '0'               : (score ? String(score.points) : '—'),
      noBetWithResult ? badge('sem aposta') : (score ? badge(score.type)  : '—')
    ];
  });

  el('roundTableWrap').innerHTML = responsiveTableHTML(['Nome', 'Aposta', 'Pontos', 'Tipo de acerto'], rows);
}

// Called only when state changes (result saved, round finalized).
// Never called from render functions — render must remain side-effect free.
// Receives the round being edited explicitly to avoid acting on the wrong round.
function updateRoundHighlight(round = getCurrentRound()) {
  const roundRanking = getRoundRanking(round);
  if (!roundRanking.length) return;

  const winner = roundWinnerLabel(roundRanking);
  const nextText = winner.points === 0
    ? 'Ninguém pontuou nesta rodada.'
    : `${winner.text} ${winner.names.length > 1 ? 'foram os jogadores' : 'foi o jogador'} da rodada com ${winner.points} ponto${winner.points !== 1 ? 's' : ''}.`;
  const nextPlayer = winner.names[0] || '';

  if (
    state.lastRoundHighlight?.text   !== nextText ||
    state.lastRoundHighlight?.player !== nextPlayer
  ) {
    state.lastRoundHighlight = { text: nextText, player: nextPlayer };
    // No saveState() here — caller is responsible for persisting
  }
}

function renderHistoryPlayers() {
  const select = el('historyPlayerSelect');
  const current = currentUser()?.name;
  select.innerHTML = state.users.map(u => `<option value="${u.name}">${u.name}</option>`).join('');
  if (current) select.value = current;
}

function renderHistory() {
  renderHistoryPlayers();
  const selected = el('historyPlayerSelect').value || state.users[0]?.name;
  const ranking = calculateRankings().find(x => x.name === selected);
  const history = getUserHistory(selected);

  const profile = bettingProfile(history);
  el('historySummary').innerHTML = ranking ? `
    <div class="notice">
      <strong>${selected}</strong><br>
      Total acumulado: ${ranking.totalPoints} pontos<br>
      Exatos: ${ranking.exact}, Parciais: ${ranking.partial}<br>
      Perfil de apostador: ${profile}
      ${ranking.roundScores.length ? `<br>Sequência atual: ${currentStreak(ranking.roundScores)}` : ''}
    </div>
  ` : '';

  el('historyTableWrap').innerHTML = responsiveTableHTML(
    ['Rodada', 'Jogo', 'Competição', 'Palpite', 'Resultado', 'Pontos', 'Tipo'],
    history.map(item => [
      item.title,
      `Cruzeiro x ${item.opponent}`,
      item.competition,
      item.betLabel,
      item.resultLabel,
      item.pointsLabel,
      item.type !== '-' ? badge(item.type) : '-'
    ])
  );
}

function renderStats() {
  const stats = getStatsSummary();
  const ranking = calculateRankings();

  // Split stats: first 9 are global metrics, rest are player profiles
  const globalStats = stats.slice(0, 9);
  const profileStats = stats.slice(9);

  // Build ranking evolution data — compare basePoints vs totalPoints
  const evolutionData = [...ranking]
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .map(u => ({
      name: u.name,
      base: u.basePoints,
      earned: u.totalPoints - u.basePoints,
      total: u.totalPoints
    }));

  // Build accuracy breakdown (exato / parcial / erro) per player
  const accuracyData = ranking.map(u => ({
    name: u.name,
    exact: u.exact,
    partial: u.partial,
    zero: u.zeroRounds,
    missed: u.missedRounds
  }));

  const wrap = el('statsGrid');
  wrap.innerHTML = `
    <div class="stats-section-full">
      <div class="stats-kicker">Métricas gerais</div>
      <div class="stats-global-grid">
        ${globalStats.map(item => `
          <article class="stat-card">
            <div class="label">${item.label}</div>
            <div class="value">${item.value}</div>
          </article>
        `).join('')}
      </div>
    </div>

    <div class="stats-section-full">
      <div class="stats-kicker">Pontuação acumulada por jogador</div>
      <div class="stats-chart-wrap">
        <canvas id="chartPoints" height="260"></canvas>
      </div>
    </div>

    <div class="stats-section-full">
      <div class="stats-kicker">Acertos por jogador (exatos · parciais · zeros · sem palpite)</div>
      <div class="stats-chart-wrap">
        <canvas id="chartAccuracy" height="260"></canvas>
      </div>
    </div>

    <div class="stats-section-full">
      <div class="stats-kicker">Perfis dos apostadores</div>
      <div class="stats-profiles-grid">
        ${profileStats.map(item => `
          <article class="stat-card">
            <div class="label">${item.label.replace('Perfil — ', '')}</div>
            <div class="value" style="font-size:1rem">${item.value}</div>
          </article>
        `).join('')}
      </div>
    </div>
  `;

  // Render charts after DOM is updated
  requestAnimationFrame(() => {
    const isDark = true;
    const gridColor = 'rgba(169,184,212,0.1)';
    const textColor = '#A9B8D4';
    const font = { family: 'Inter, system-ui, sans-serif', size: 12 };

    Chart.defaults.color = textColor;
    Chart.defaults.font = font;

    // ── Chart 1: Pontuação acumulada (stacked bar: base + earned) ──
    const ctx1 = document.getElementById('chartPoints')?.getContext('2d');
    if (ctx1) {
      if (window._chartPoints) window._chartPoints.destroy();
      window._chartPoints = new Chart(ctx1, {
        type: 'bar',
        data: {
          labels: evolutionData.map(d => d.name),
          datasets: [
            {
              label: 'Pontos base',
              data: evolutionData.map(d => d.base),
              backgroundColor: 'rgba(59,130,246,0.45)',
              borderColor: 'rgba(59,130,246,0.9)',
              borderWidth: 1,
              borderRadius: 4,
              borderSkipped: false
            },
            {
              label: 'Pontos ganhos nas rodadas',
              data: evolutionData.map(d => d.earned),
              backgroundColor: 'rgba(57,217,138,0.55)',
              borderColor: 'rgba(57,217,138,0.9)',
              borderWidth: 1,
              borderRadius: 4,
              borderSkipped: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top', labels: { color: textColor, font, boxWidth: 14, padding: 16 } },
            tooltip: {
              callbacks: {
                footer: (items) => {
                  const total = items.reduce((s, i) => s + i.raw, 0);
                  return `Total: ${total} pts`;
                }
              }
            }
          },
          scales: {
            x: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor, font } },
            y: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor, font }, beginAtZero: true }
          }
        }
      });
    }

    // ── Chart 2: Acertos por jogador (stacked horizontal) ──
    const ctx2 = document.getElementById('chartAccuracy')?.getContext('2d');
    if (ctx2) {
      if (window._chartAccuracy) window._chartAccuracy.destroy();
      window._chartAccuracy = new Chart(ctx2, {
        type: 'bar',
        data: {
          labels: accuracyData.map(d => d.name),
          datasets: [
            {
              label: 'Exatos (3 pts)',
              data: accuracyData.map(d => d.exact),
              backgroundColor: 'rgba(57,217,138,0.7)',
              borderColor: 'rgba(57,217,138,1)',
              borderWidth: 1,
              borderRadius: 3
            },
            {
              label: 'Parciais (1 pt)',
              data: accuracyData.map(d => d.partial),
              backgroundColor: 'rgba(255,215,107,0.7)',
              borderColor: 'rgba(255,215,107,1)',
              borderWidth: 1,
              borderRadius: 3
            },
            {
              label: 'Zeros (apostou e errou)',
              data: accuracyData.map(d => d.zero),
              backgroundColor: 'rgba(255,125,125,0.5)',
              borderColor: 'rgba(255,125,125,0.9)',
              borderWidth: 1,
              borderRadius: 3
            },
            {
              label: 'Sem palpite',
              data: accuracyData.map(d => d.missed),
              backgroundColor: 'rgba(107,124,163,0.4)',
              borderColor: 'rgba(107,124,163,0.8)',
              borderWidth: 1,
              borderRadius: 3
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top', labels: { color: textColor, font, boxWidth: 14, padding: 16 } }
          },
          scales: {
            x: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor, font } },
            y: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor, font, stepSize: 1 }, beginAtZero: true }
          }
        }
      });
    }
  });
}




function addPlayer({ name, phone, basePoints }) {
  name = name.trim();
  if (!name) { showToast('O nome não pode estar vazio.'); return false; }
  if (state.users.find(u => u.name.toLowerCase() === name.toLowerCase())) {
    showToast('Já existe um participante com esse nome.'); return false;
  }
  const newUser = {
    id: crypto.randomUUID(),
    name,
    phone: phone?.trim() || '',
    basePoints: Number(basePoints) || 0,
    baseExact: 0,
    basePartial: 0,
    pin: null,
    isAdmin: ADMIN_NAMES.includes(name)
  };
  state.users.push(newUser);
  state.initialRankingSnapshot.push({ name, points: newUser.basePoints });
  saveState('users');
  showToast(`${name} adicionado com sucesso.`);
  return true;
}

function removePlayer(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  if (user.isAdmin) { showToast('Não é possível remover um administrador.'); return; }
  if (!confirm(`Remover "${user.name}"? As apostas deste jogador serão mantidas no histórico.`)) return;
  state.users = state.users.filter(u => u.id !== userId);
  state.initialRankingSnapshot = state.initialRankingSnapshot.filter(s => s.name !== user.name);
  saveState('users');
  renderAdmin();
  showToast(`${user.name} removido.`);
}

function resetPlayerPin(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  if (!confirm(`Resetar o PIN de "${user.name}"? O jogador terá de definir um novo PIN no próximo login.`)) return;
  user.pin = null;
  saveState('users');
  renderPlayersList();
  showToast(`PIN de ${user.name} resetado.`);
}

function renderPlayersList() {
  const wrap = el('playersListWrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:.88rem;">
      <thead><tr>
        <th style="padding:8px 6px;color:var(--text-2);text-align:left;">Nome</th>
        <th style="padding:8px 6px;color:var(--text-2);text-align:left;">Pts base</th>
        <th style="padding:8px 6px;color:var(--text-2);text-align:left;">PIN</th>
        <th style="padding:8px 6px;color:var(--text-2);text-align:left;">Ações</th>
      </tr></thead>
      <tbody>
        ${state.users.map(u => `
          <tr style="border-top:1px solid var(--line);">
            <td style="padding:8px 6px;">${avatarHTML(u.name)}${u.name}${u.isAdmin ? ' <span style="color:var(--gold);font-size:.75rem;">admin</span>' : ''}</td>
            <td style="padding:8px 6px;">${u.basePoints}</td>
            <td style="padding:8px 6px;">${u.pin ? '✅ Definido' : '⚠️ Sem PIN'}</td>
            <td style="padding:8px 6px;display:flex;gap:6px;flex-wrap:wrap;">
              <button class="ios-btn ios-btn-yellow" onclick="resetUserPin('${u.id}')">🔑 Reset PIN</button>
              ${!u.isAdmin ? `<button class="ios-btn ios-btn-red" onclick="removePlayer('${u.id}')">🗑 Remover</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// ── Painel "Ao Vivo" — TheSportsDB (gratuita, sem chave, suporta CORS) ──────
let sofascoreLoading = false;

const THESPORTSDB_TEAM_ID = 134294;  // Cruzeiro masculino

// URL do Cloudflare Worker (proxy próprio para football-data.org sem CORS)
const WORKER_URL = window.BOLAO_WORKER_URL || null;

async function fetchCruzeiroMatches() {
  try {
    const dbUrl = window.BOLAO_FIREBASE_CONFIG?.databaseURL;
    if (!dbUrl) throw new Error('Firebase databaseURL não configurado.');

    const res = await fetch(`${dbUrl}/bolao-cruzeiro-debates/matches.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    return {
      finished: Array.isArray(data?.finished) ? data.finished : [],
      upcoming: Array.isArray(data?.upcoming) ? data.upcoming : [],
      updatedAt: data?.updatedAt || null
    };
  } catch (e) {
    console.error('[fetchCruzeiroMatches]', e);
    return { finished: [], upcoming: [], updatedAt: null };
  }
}

function getOpponentFromMatch(match) {
  const CRUZEIRO_IDS = new Set(['1954', '1625']);
  const home = String(match?.idHomeTeam || '');
  const away = String(match?.idAwayTeam || '');
  if (CRUZEIRO_IDS.has(home)) return match?.strAwayTeam || 'Adversário';
  if (CRUZEIRO_IDS.has(away)) return match?.strHomeTeam || 'Adversário';
  return match?.strAwayTeam || match?.strHomeTeam || 'Adversário';
}

function matchToLocalInput(match) {
  // Os dados do Sofascore vêm em UTC — adiciona 'Z' para forçar interpretação correcta
  const iso = match?.dateEvent && match?.strTime
    ? `${match.dateEvent}T${match.strTime}Z`
    : null;

  if (!iso) return toLocalInputInAppTime(new Date());
  // Converte de UTC para horário de Brasília para o input datetime-local
  return toLocalInputInAppTime(new Date(iso));
}

function getAdminImportableUpcomingMatches() {
  const matches = Array.isArray(state?.externalMatches?.upcoming) ? state.externalMatches.upcoming : [];
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];

  return matches.filter(match => {
    const opponent = normalizeTeamName(getOpponentFromMatch(match));
    const league = normalizeTeamName(match?.strLeague || '');
    const matchDate = match?.dateEvent || '';

    return !rounds.some(round => {
      const roundOpponent = normalizeTeamName(round?.opponent || '');
      const roundLeague = normalizeTeamName(round?.competition || '');
      const roundDate = String(round?.matchTime || '').substring(0, 10);
      return roundOpponent === opponent && roundDate === matchDate && (!league || !roundLeague || roundLeague === league);
    });
  });
}

function getSuggestedResultMatches() {
  const matches = Array.isArray(state?.externalMatches?.finished) ? state.externalMatches.finished : [];
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const suggestions = [];

  rounds.forEach(round => {
    if (round.resultCruzeiro !== null && round.resultOpponent !== null) return;

    const roundOpponent = normalizeTeamName(round?.opponent || '');
    const roundLeague = normalizeTeamName(round?.competition || '');
    const roundMs = parseAppDateTime(round?.matchTime || '');
    if (!roundMs) return;

    const candidate = matches.find(match => {
      const candidateOpponent = normalizeTeamName(getOpponentFromMatch(match));
      if (candidateOpponent !== roundOpponent) return false;

      const candidateLeague = normalizeTeamName(match?.strLeague || '');
      if (roundLeague && candidateLeague && roundLeague !== candidateLeague) return false;

      const matchMs = parseAppDateTime(`${match?.dateEvent || ''}T${match?.strTime || '00:00:00'}`);
      if (!matchMs) return false;
      return Math.abs(roundMs - matchMs) <= 72 * 3600000;
    });

    if (!candidate) return;

    const cruzeiroHome = ['1954', '1625'].includes(String(candidate.idHomeTeam || ''));
    const resultCruzeiro = cruzeiroHome ? (candidate.intHomeScore ?? null) : (candidate.intAwayScore ?? null);
    const resultOpponent = cruzeiroHome ? (candidate.intAwayScore ?? null) : (candidate.intHomeScore ?? null);

    if (resultCruzeiro === null || resultOpponent === null) return;

    suggestions.push({ round, match: candidate, resultCruzeiro, resultOpponent });
  });

  return suggestions;
}

function importUpcomingMatch(match) {
  const localMatchTime = matchToLocalInput(match);
  const matchMs = parseAppDateTime(localMatchTime);
  const deadline = toLocalInputInAppTime(new Date(matchMs - 30 * 60000));

  const round = {
    id: crypto.randomUUID(),
    title: `Rodada ${state.rounds.length + 1}`,
    opponent: getOpponentFromMatch(match),
    competition: match.strLeague || 'Competição',
    matchTime: localMatchTime,
    deadline,
    resultCruzeiro: null,
    resultOpponent: null,
    manualState: 'upcoming',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  state.rounds.unshift(round);
  saveState('admin');
  renderAll('admin');
  const roundSelect = el('roundSelect');
  if (roundSelect) roundSelect.value = round.id;
  populateRoundForm(round.id);
  showToast(`Jogo importado: Cruzeiro x ${round.opponent}.`);
}

function applySuggestedResult(roundId) {
  const suggestion = getSuggestedResultMatches().find(item => item.round.id === roundId);
  if (!suggestion) {
    showToast('Nenhum resultado sugerido encontrado para esta rodada.');
    return;
  }

  suggestion.round.resultCruzeiro = suggestion.resultCruzeiro;
  suggestion.round.resultOpponent = suggestion.resultOpponent;
  suggestion.round.updatedAt = new Date().toISOString();

  saveState('admin');
  renderAll('admin');
  const roundSelect = el('roundSelect');
  if (roundSelect) roundSelect.value = suggestion.round.id;
  populateRoundForm(suggestion.round.id);
  showToast(`Resultado sugerido aplicado em ${suggestion.round.title}.`);
}

function renderAdminMatchAutomation() {
  const importWrap = el('adminImportUpcomingWrap');
  const resultsWrap = el('adminSuggestedResultsWrap');
  if (!importWrap || !resultsWrap) return;

  const importable = getAdminImportableUpcomingMatches();
  const suggestions = getSuggestedResultMatches();

  if (!importable.length) {
    importWrap.innerHTML = '<p class="muted">Nenhum jogo novo disponível para importar neste momento.</p>';
  } else {
    importWrap.innerHTML = `
      <div class="notice" style="margin-bottom:12px;">Jogos encontrados no painel “Cruzeiro ao vivo” e ainda não criados como rodada.</div>
      <table style="width:100%;border-collapse:collapse;font-size:.88rem;">
        <thead><tr>
          <th style="padding:8px 6px;text-align:left;color:var(--text-2);">Jogo</th>
          <th style="padding:8px 6px;text-align:left;color:var(--text-2);">Competição</th>
          <th style="padding:8px 6px;text-align:left;color:var(--text-2);">Data</th>
          <th style="padding:8px 6px;text-align:left;color:var(--text-2);">Ação</th>
        </tr></thead>
        <tbody>
          ${importable.map(match => `
            <tr style="border-top:1px solid var(--line);">
              <td style="padding:8px 6px;">Cruzeiro x ${getOpponentFromMatch(match)}</td>
              <td style="padding:8px 6px;">${match.strLeague || '—'}</td>
              <td style="padding:8px 6px;">${formatDateTime(`${match.dateEvent}T${match.strTime}Z`)}</td>
              <td style="padding:8px 6px;"><button class="ios-btn ios-btn-blue" onclick="importUpcomingMatchById('${match.idEvent}')">Importar</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }

  if (!suggestions.length) {
    resultsWrap.innerHTML = '<p class="muted">Nenhuma rodada pendente com resultado sugerido disponível.</p>';
  } else {
    resultsWrap.innerHTML = `
      <div class="notice" style="margin-bottom:12px;">Resultados encontrados automaticamente nos jogos já concluídos. Revise e aplique manualmente.</div>
      <table style="width:100%;border-collapse:collapse;font-size:.88rem;">
        <thead><tr>
          <th style="padding:8px 6px;text-align:left;color:var(--text-2);">Rodada</th>
          <th style="padding:8px 6px;text-align:left;color:var(--text-2);">Resultado</th>
          <th style="padding:8px 6px;text-align:left;color:var(--text-2);">Fonte</th>
          <th style="padding:8px 6px;text-align:left;color:var(--text-2);">Ação</th>
        </tr></thead>
        <tbody>
          ${suggestions.map(item => `
            <tr style="border-top:1px solid var(--line);">
              <td style="padding:8px 6px;">${item.round.title} · Cruzeiro x ${item.round.opponent}</td>
              <td style="padding:8px 6px;"><strong>${item.resultCruzeiro} x ${item.resultOpponent}</strong></td>
              <td style="padding:8px 6px;">${item.match.strLeague || 'Jogo concluído'}</td>
              <td style="padding:8px 6px;display:flex;gap:8px;flex-wrap:wrap;">
                <button class="ios-btn ios-btn-green" onclick="applySuggestedResult('${item.round.id}')">Aplicar</button>
                <button class="ios-btn ios-btn-gray" onclick="focusRoundFromSuggestion('${item.round.id}')">Abrir rodada</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }
}

function importUpcomingMatchById(idEvent) {
  const match = (state?.externalMatches?.upcoming || []).find(item => String(item.idEvent) === String(idEvent));
  if (!match) {
    showToast('Jogo não encontrado para importação.');
    return;
  }
  importUpcomingMatch(match);
}

function focusRoundFromSuggestion(roundId) {
  const roundSelect = el('roundSelect');
  if (roundSelect) roundSelect.value = roundId;
  populateRoundForm(roundId);
  showToast('Rodada carregada no formulário.');
}

async function renderSofaScore() {
  if (!currentUser()) return;
  const panel = el('sofascoreContent');
  if (!panel) return;

  if (sofascoreLoading) return;
  sofascoreLoading = true;

  panel.innerHTML = `<div class="muted" style="text-align:center;padding:32px 0;"><span class="ai-spinner"></span> A carregar jogos do Cruzeiro...</div>`;

  try {
    const { upcoming, finished, updatedAt } = await fetchCruzeiroMatches();
    state.externalMatches = { upcoming, finished, updatedAt };

    let html = '';

    if (upcoming.length) {
      html += `<div style="margin-bottom:20px;">
        <div class="mini-label" style="margin-bottom:10px;">Próximos jogos</div>
        ${upcoming.map(m => matchRowHTMLSportsDB(m, false)).join('')}
      </div>`;
    }

    if (finished.length) {
      html += `<div>
        <div class="mini-label" style="margin-bottom:10px;">Resultados recentes</div>
        ${finished.map(m => matchRowHTMLSportsDB(m, true)).join('')}
      </div>`;
    }

    if (!html) {
      html = `<p class="muted" style="padding:24px;text-align:center;">Sem jogos disponíveis neste momento.</p>`;
    }

    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
      <span style="font-size:.74rem;color:var(--text-3);">Dados sincronizados via Firebase${state?.externalMatches?.updatedAt ? ' · atualizado ' + formatDateTime(state.externalMatches.updatedAt) : ''}</span>
      <button class="ios-btn ios-btn-gray" style="font-size:.78rem;padding:6px 12px;" onclick="reloadSofaScore()">↻ Atualizar</button>
    </div>`;

    panel.innerHTML = html;

  } catch (e) {
    console.error('[renderSofaScore]', e);
    panel.innerHTML = `
      <p class="muted" style="padding:16px 0 8px;text-align:center;">
        Não foi possível carregar os jogos.<br>
        <span style="font-size:.8rem;">Verifique a ligação à internet.</span>
      </p>
      <div style="text-align:center;margin-top:8px;">
        <button class="ios-btn ios-btn-gray" onclick="reloadSofaScore()">↻ Tentar novamente</button>
      </div>`;
  } finally {
    sofascoreLoading = false;
  }
}

function matchRowHTMLSportsDB(m, isFinished) {
  const homeTeam   = m.strHomeTeam || '?';
  const awayTeam   = m.strAwayTeam || '?';
  const homeBadge  = m.strHomeTeamBadge || getLocalCrest(homeTeam);
  const awayBadge  = m.strAwayTeamBadge || getLocalCrest(awayTeam);
  const competition = m.strLeague || '';

  // Data/hora
  const dateRaw = m.dateEvent && m.strTime
    ? new Date(`${m.dateEvent}T${m.strTime}Z`)
    : m.dateEvent ? new Date(m.dateEvent) : null;
  const dateStr = dateRaw
    ? new Intl.DateTimeFormat('pt-BR', {
        timeZone: APP_TIMEZONE,
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23'
      }).format(dateRaw)
    : '';

  // Resultado
  let scoreHTML = '';
  if (isFinished && m.intHomeScore !== null && m.intAwayScore !== null) {
    const gh = m.intHomeScore ?? '?';
    const ga = m.intAwayScore ?? '?';
    const isCruzeiroHome = homeTeam.toLowerCase().includes('cruzeiro');
    const cg = isCruzeiroHome ? gh : ga;
    const og = isCruzeiroHome ? ga : gh;
    const won  = Number(cg) > Number(og);
    const drew = Number(cg) === Number(og);
    const color = won ? 'var(--green)' : drew ? 'var(--gold)' : 'var(--red)';
    scoreHTML = `<span style="font-size:1.15rem;font-weight:800;color:${color};min-width:52px;text-align:center;">${gh} – ${ga}</span>`;
  } else {
    scoreHTML = `<span style="font-size:.82rem;color:var(--text-3);min-width:52px;text-align:center;">${dateStr}</span>`;
  }

  const homeImg = homeBadge && homeBadge.startsWith('http')
    ? `<img src="${homeBadge}" alt="${homeTeam}" width="24" height="24" style="object-fit:contain;" onerror="this.src='Escudos/default.svg'">`
    : crestImgHTML(getLocalCrest(homeTeam), homeTeam, 24);

  const awayImg = awayBadge && awayBadge.startsWith('http')
    ? `<img src="${awayBadge}" alt="${awayTeam}" width="24" height="24" style="object-fit:contain;" onerror="this.src='Escudos/default.svg'">`
    : crestImgHTML(getLocalCrest(awayTeam), awayTeam, 24);

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);">
      <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
        ${homeImg}
        <span style="font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${homeTeam}</span>
      </div>
      ${scoreHTML}
      <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;justify-content:flex-end;">
        <span style="font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${awayTeam}</span>
        ${awayImg}
      </div>
    </div>
    <div style="font-size:.75rem;color:var(--text-3);padding:2px 0 6px;">${competition}${isFinished ? '' : ' · ' + dateStr}</div>
  `;
}

function reloadSofaScore() {
  sofascoreLoading = false;
  renderSofaScore();
}

async function fetchMatchesFallback(key) { return null; } // já não necessário




function matchRowHTML(m, finished) {
  const isCruzeiroHome = m.homeTeam?.id === CRUZEIRO_ID;
  const homeTeam = m.homeTeam?.shortName || m.homeTeam?.name || '?';
  const awayTeam = m.awayTeam?.shortName || m.awayTeam?.name || '?';
  const homeCrest = getLocalCrest(m.homeTeam?.name || '');
  const awayCrest = getLocalCrest(m.awayTeam?.name || '');
  const competition = m.competition?.name || '';
  const dateStr = m.utcDate
    ? new Intl.DateTimeFormat('pt-BR', { timeZone: APP_TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(m.utcDate))
    : '';

  let scoreHTML = '';
  if (finished && m.score?.fullTime) {
    const gh = m.score.fullTime.home ?? '?';
    const ga = m.score.fullTime.away ?? '?';
    const cruzeiroGoals = isCruzeiroHome ? gh : ga;
    const opponentGoals = isCruzeiroHome ? ga : gh;
    const won  = cruzeiroGoals > opponentGoals;
    const drew = cruzeiroGoals === opponentGoals;
    const resultColor = won ? 'var(--green,#39d98a)' : drew ? 'var(--gold,#ffd76b)' : 'var(--red,#ff6b6b)';
    scoreHTML = `<span style="font-size:1.15rem;font-weight:800;color:${resultColor};min-width:52px;text-align:center;">${gh} – ${ga}</span>`;
  } else {
    scoreHTML = `<span style="font-size:.82rem;color:var(--text-3);min-width:52px;text-align:center;">${dateStr}</span>`;
  }

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);">
      <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
        ${crestImgHTML(homeCrest, homeTeam, 24)}
        <span style="font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${homeTeam}</span>
      </div>
      ${scoreHTML}
      <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;justify-content:flex-end;">
        <span style="font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${awayTeam}</span>
        ${crestImgHTML(awayCrest, awayTeam, 24)}
      </div>
    </div>
    <div style="font-size:.75rem;color:var(--text-3);padding:2px 0 6px;">${competition}${finished ? '' : ' · ' + dateStr}</div>
  `;
}

let chatPublicRef = null;
let chatAdminRef = null;
let chatInitialized = false;
let chatAdminListenerRegistered = false;

function initChat() {
  if (!window.firebase || !window.firebase.database) return;

  const db = firebase.database();
  chatPublicRef = db.ref('bolao-cruzeiro-debates/chat/public');
  chatAdminRef  = db.ref('bolao-cruzeiro-debates/chat/admin');

  // Listener público — regista apenas uma vez
  if (!chatInitialized) {
    chatInitialized = true;

    const publicWrap = document.getElementById('chatMessagesWrapMain');
    if (publicWrap) publicWrap.innerHTML = '';

    chatPublicRef.limitToLast(60).on('child_added', snap => {
      const msg = snap.val();
      if (msg) renderChatMessage(msg, 'chatMessagesWrapMain', snap.key);
    });

    chatPublicRef.on('child_removed', snap => {
      const wrap = document.getElementById('chatMessagesWrapMain');
      if (wrap) {
        const node = wrap.querySelector(`[data-snap-key="${snap.key}"]`);
        if (node) node.remove();
      }
    });
  }

  // Listener admin — regista quando o utilizador já é admin (pode ser chamado múltiplas vezes com segurança)
  if (isAdmin() && !chatAdminListenerRegistered) {
    chatAdminListenerRegistered = true;

    const adminWrap = document.getElementById('chatMessagesWrapAdmin');
    if (adminWrap) adminWrap.innerHTML = '';

    chatAdminRef.limitToLast(60).on('child_added', snap => {
      const msg = snap.val();
      if (msg) renderChatMessage(msg, 'chatMessagesWrapAdmin', snap.key);
    });

    chatAdminRef.on('child_removed', snap => {
      const wrap = document.getElementById('chatMessagesWrapAdmin');
      if (wrap) {
        const node = wrap.querySelector(`[data-snap-key="${snap.key}"]`);
        if (node) node.remove();
      }
    });
  }
}

function renderChatMessage(msg, containerId, snapKey) {
  const user = currentUser();
  const isMe = msg.userName === user?.name;
  const time = new Date(msg.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  // Identificação do remetente — sempre visível
  const senderColor = AVATAR_COLORS[msg.userName.charCodeAt(0) % AVATAR_COLORS.length];
  const senderLabel = isMe
    ? `<span style="font-size:.72rem;color:${senderColor};margin-bottom:3px;font-weight:700;">Você (${msg.userName})</span>`
    : `<span style="font-size:.72rem;color:${senderColor};margin-bottom:3px;font-weight:700;">${msg.userName}</span>`;

  // Botão apagar — visível para o próprio ou para admins
  const canDelete = isMe || isAdmin();
  const deleteBtn = canDelete && snapKey
    ? `<button onclick="deleteChatMessage('${containerId}','${snapKey}')" title="Apagar mensagem" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:.8rem;padding:2px 4px;line-height:1;opacity:.6;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.6">🗑</button>`
    : '';

  const msgHTML = `
    <div data-snap-key="${snapKey || ''}" style="display:flex;flex-direction:column;align-items:${isMe ? 'flex-end' : 'flex-start'};">
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:3px;">
        ${senderLabel}
      </div>
      <div style="display:flex;align-items:flex-end;gap:6px;flex-direction:${isMe ? 'row-reverse' : 'row'};">
        <div style="max-width:78%;padding:10px 14px;border-radius:${isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px'};background:${isMe ? 'var(--active)' : 'rgba(255,255,255,.07)'};color:var(--text);font-size:.92rem;word-break:break-word;">
          ${msg.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
        </div>
        ${deleteBtn}
      </div>
      <span style="font-size:.7rem;color:var(--text-3);margin-top:3px;">${time}</span>
    </div>
  `;

  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.insertAdjacentHTML('beforeend', msgHTML);
  wrap.scrollTop = wrap.scrollHeight;
}

function deleteChatMessage(containerId, snapKey) {
  if (!snapKey) { showToast('ID da mensagem inválido.'); return; }
  if (!confirm('Apagar esta mensagem?')) return;

  const isPublic = containerId === 'chatMessagesWrapMain';
  const ref = isPublic ? chatPublicRef : chatAdminRef;
  if (!ref) { showToast('Chat não disponível — Firebase não ligado.'); return; }

  // Remove direto na ref base do chat, não na query limitToLast
  const baseRef = isPublic
    ? firebase.database().ref('bolao-cruzeiro-debates/chat/public/' + snapKey)
    : firebase.database().ref('bolao-cruzeiro-debates/chat/admin/' + snapKey);

  baseRef.remove()
    .then(() => {
      const wrap = document.getElementById(containerId);
      if (wrap) {
        const node = wrap.querySelector(`[data-snap-key="${snapKey}"]`);
        if (node) node.remove();
      }
      showToast('Mensagem apagada.');
    })
    .catch(err => {
      console.error('[deleteChatMessage] erro Firebase:', err.code, err.message);
      if (err.code === 'PERMISSION_DENIED') {
        showToast('Sem permissão para apagar esta mensagem. Verifique as regras do Firebase.');
      } else {
        showToast('Erro ao apagar: ' + (err.message || err.code));
      }
    });
}

function sendChatMessage(inputId, isAdminChat = false) {
  const user = currentUser();
  if (!user) { showToast('Faça login para usar o chat.'); return; }

  // Garante que as refs estão inicializadas
  if (!chatPublicRef) initChat();

  const ref = isAdminChat ? chatAdminRef : chatPublicRef;
  if (!ref) { showToast('Chat não disponível (Firebase não ligado).'); return; }

  if (isAdminChat && !isAdmin()) { showToast('Apenas admins podem escrever aqui.'); return; }

  const input = document.getElementById(inputId);
  const text = input?.value?.trim();
  if (!text) return;

  // push() direto na ref base — não na query limitToLast()
  ref.push({
    userName: user.name,
    firebaseUid: getFirebaseUid() || '',
    text,
    createdAt: new Date().toISOString()
  }).catch(err => {
    console.error('Erro ao enviar mensagem:', err);
    showToast('Erro ao enviar mensagem.');
  });

  input.value = '';
}

function renderChat() {
  if (!currentUser()) return;
  // Inicia o chat apenas uma vez, depois que o Firebase está pronto
  if (!chatInitialized && firebaseSyncEnabled) initChat();
}

function renderIA() {
  // IA buttons are inside homeUser which is already hidden when not logged in
}

function renderAdmin() {
  const guard = el('adminGuard');
  const content = el('adminContent');

  if (!isAdmin()) {
    guard.classList.remove('hidden');
    content.classList.add('hidden');
    guard.innerHTML = '<p>Apenas Ivo, Samuel e Gabriel podem aceder a esta área.</p>';
    return;
  }

  guard.classList.add('hidden');
  content.classList.remove('hidden');

  // Popula select de rodadas
  const roundSelect = el('roundSelect');
  if (roundSelect) {
    roundSelect.innerHTML = state.rounds
      .slice()
      .sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime))
      .map(r => `<option value="${r.id}">${r.title} — Cruzeiro x ${r.opponent}</option>`)
      .join('');
    if (!roundSelect.value && state.rounds[0]) roundSelect.value = state.rounds[0].id;
    populateRoundForm(roundSelect.value);
  }

  // Apostadores em falta — painel completo
  renderMissingBetsPanel();

  renderPlayersList();
  renderAdminRoundsHistory();
  renderAdminMatchAutomation();

  // Firebase UID
  const uidWrap = el('adminUidDisplay');
  if (uidWrap) {
    const uid = getFirebaseUid();
    uidWrap.innerHTML = uid
      ? `<span class="sidebar-user-label">O teu UID Firebase</span>
         <code style="word-break:break-all;font-size:.82rem;color:var(--accent-soft)">${uid}</code>
         <span class="muted" style="font-size:.78rem">Compartilhe esse valor com o Ivo para ser registrado como admin.</span>`
      : `<span class="muted" style="font-size:.78rem">UID não disponível (modo local).</span>`;
  }
}

function renderAdminRoundsHistory() {
  const wrap = el('adminRoundsHistoryWrap');
  if (!wrap) return;

  const sorted = [...state.rounds].sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime));

  if (!sorted.length) {
    wrap.innerHTML = '<p class="muted">Nenhuma rodada registada.</p>';
    return;
  }

  wrap.innerHTML = sorted.map(r => {
    const betsInRound = getBetsArray().filter(b => b.roundId === r.id);
    const hasResult = Number.isInteger(r.resultCruzeiro) && Number.isInteger(r.resultOpponent);
    const resultLabel = hasResult ? `${r.resultCruzeiro}x${r.resultOpponent}` : 'Aguardando resultado';
    const rr = hasResult ? getRoundRanking(r) : [];
    const winner = rr.length ? roundWinnerLabel(rr) : null;

    return `
      <div style="padding:14px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div>
            <strong>${r.title}</strong>
            <span style="color:var(--text-3);font-size:.82rem;"> — Cruzeiro x ${r.opponent} (${r.competition})</span><br>
            <span style="font-size:.82rem;color:var(--text-2);">${formatDateTime(r.matchTime)} · ${roundStateLabel(r)}</span>
          </div>
          <div style="text-align:right;">
            <span style="font-weight:700;color:${hasResult ? 'var(--green)' : 'var(--text-3)'};">${resultLabel}</span><br>
            <span style="font-size:.78rem;color:var(--text-2);">${betsInRound.length} aposta(s)</span>
            ${winner && winner.points > 0 ? `<br><span style="font-size:.78rem;color:var(--gold);">🏆 ${winner.text}</span>` : ''}
          </div>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="ios-btn ios-btn-blue" onclick="adminSelectRound('${r.id}')">✏️ Editar</button>
          <button class="ios-btn ios-btn-red"  onclick="deleteRound('${r.id}')">🗑 Apagar</button>
        </div>
      </div>
    `;
  }).join('');
}

function adminSelectRound(roundId) {
  // Vai para a tab de rodadas e seleciona a rodada
  const tabBtn = document.querySelector('[data-tab="tab-admin-rounds"]');
  if (tabBtn) tabBtn.click();

  const roundSelect = el('roundSelect');
  if (roundSelect) {
    roundSelect.value = roundId;
    populateRoundForm(roundId);
  }
  showToast('Rodada selecionada para edição.');
}

function deleteRound(roundId) {
  const round = getRound(roundId);
  if (!round) return;
  if (!confirm(`Apagar a rodada "${round.title} — Cruzeiro x ${round.opponent}"?\n\nAs apostas desta rodada também serão removidas.`)) return;

  // Remove apostas da rodada
  Object.keys(state.bets).forEach(betId => {
    if (state.bets[betId]?.roundId === roundId) {
      delete state.bets[betId];
      if (firebaseDbRef) firebaseDbRef.child('bets').child(betId).remove();
    }
  });

  state.rounds = state.rounds.filter(r => r.id !== roundId);
  saveState('admin');
  renderAdmin();
  showToast(`Rodada "${round.title}" apagada.`);
}

// ── Reset de PIN ─────────────────────────────────────────────
async function resetUserPin(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;

  const newPin = prompt(`Novo PIN para ${user.name} (4 dígitos):`);
  if (newPin === null) return; // cancelado
  if (!/^\d{4}$/.test(newPin)) {
    showToast('PIN inválido. Deve ter exatamente 4 dígitos.');
    return;
  }

  const newPinHash = await hashPin(newPin, user.id);
  user.pin = newPinHash;
  saveState('users');
  showToast(`PIN de ${user.name} redefinido com sucesso.`);
  renderPlayersList();
}

// ── Alterar o próprio PIN (pelo utilizador logado) ────────────────────────────
async function changeOwnPin() {
  const user = currentUser();
  if (!user) return;

  const pinMsg = el('changePinMsg');
  const showMsg = (text, isError = false) => {
    if (!pinMsg) return;
    pinMsg.textContent = text;
    pinMsg.className = 'change-pin-msg ' + (isError ? 'change-pin-msg--error' : 'change-pin-msg--ok');
    pinMsg.classList.remove('hidden');
  };

  const oldVal     = el('pinOldInput')?.value.trim();
  const newVal     = el('pinNewInput')?.value.trim();
  const confirmVal = el('pinConfirmInput')?.value.trim();

  if (!/^\d{4}$/.test(oldVal)) { showMsg('PIN atual inválido — deve ter 4 dígitos.', true); return; }
  if (!/^\d{4}$/.test(newVal)) { showMsg('Novo PIN inválido — deve ter 4 dígitos.', true); return; }
  if (newVal !== confirmVal)    { showMsg('Os PINs novos não coincidem.', true); return; }
  if (oldVal === newVal)        { showMsg('O novo PIN é igual ao atual.', true); return; }

  // Verify current PIN
  const currentHash    = await hashPin(oldVal, user.id);
  const currentHashOld = await hashPin(oldVal);           // legacy format
  const storedPin      = user.pin;

  const storedIsHashed = isPinHashed(storedPin);
  const matches = storedIsHashed
    ? (storedPin === currentHash || storedPin === currentHashOld)
    : (storedPin === oldVal);

  if (!matches) { showMsg('PIN atual incorreto.', true); return; }

  // Save new PIN
  const newHash  = await hashPin(newVal, user.id);
  user.pin = newHash;
  saveState('users');

  showMsg('✅ PIN alterado com sucesso!');
  el('pinOldInput').value = '';
  el('pinNewInput').value = '';
  el('pinConfirmInput').value = '';
  setTimeout(() => {
    el('changePinFormInline')?.classList.add('hidden');
    const btn = el('changePinToggleBtn');
    if (btn) btn.textContent = '🔑 Alterar PIN';
  }, 1800);
}

function populateRoundForm(roundId) {
  const round = getRound(roundId);
  if (!round) return;

  el('roundTitle').value = round.title;
  el('roundOpponentName').value = round.opponent;
  el('roundCompetition').value = round.competition;
  el('roundMatchTime').value = round.matchTime;
  el('roundDeadline').value = round.deadline;
  el('roundManualState').value = round.manualState || 'auto';
  el('resultCruzeiro').value = round.resultCruzeiro ?? '';
  el('resultOpponent').value = round.resultOpponent ?? '';
}

function renderPrint(type = 'ranking') {
  const round = getCurrentRound();
  const ranking = calculateRankings();
  const roundRanking = getRoundRanking(round);

  const header = `
    <div class="print-brand">
      <img src="Bolao1.png" alt="Logo do bolão" />
      <div>
        <div class="print-kicker">Bolão do Cruzeiro Debates</div>
        <h2>${type === 'round' ? 'Resumo da rodada' : 'Ranking geral'}</h2>
        <p>Gerado em ${formatDateTime(new Date().toISOString())}</p>
      </div>
    </div>
  `;

  el('printSheet').innerHTML = type === 'round' && round
    ? header + `
      <p><strong>${round.title}</strong>, Cruzeiro x ${round.opponent}, ${round.competition}</p>
      <p><strong>Resultado real:</strong> ${round.resultCruzeiro ?? '-'}x${round.resultOpponent ?? '-'}</p>
      <p><strong>Jogador da rodada:</strong> ${roundRanking[0]?.name || '-'}</p>
      ${tableHTML(['Pos.', 'Nome', 'Aposta', 'Pontos', 'Tipo'], roundRanking.map(item => [`${item.position}º`, item.name, item.bet, String(item.points), badge(item.type)]))}
    `
    : header + `
      <p><strong>Destaque:</strong> ${state.lastRoundHighlight.text}</p>
      ${tableHTML(['Pos.', 'Nome', 'Pontos', 'Mov.', 'Exatos', 'Parciais'], ranking.map(item => [`${item.position}º`, item.name, String(item.totalPoints), movementHTML(item.movement, item.movementDelta), String(item.exact), String(item.partial)]))}
    `;
}

function generateWhatsAppMessage() {
  const ranking = calculateRankings().slice(0, 5);
  const round = getCurrentRound();
  const roundRanking = getRoundRanking(round);

  const highlight = roundRanking[0]
    ? `🔥 Destaque: ${roundRanking[0].name}${roundRanking[0].type === 'exato' ? ' (placar exato)' : ''}`
    : `🔥 Destaque: ${state.lastRoundHighlight.player}`;

  return [
    '🏆 Bolão Cruzeiro Debates',
    '',
    '📊 Ranking atualizado:',
    ...ranking.map(item => `${item.position}º ${item.name} - ${item.totalPoints} pts`),
    '',
    highlight,
    '',
    round ? `⚽ Próximo jogo: Cruzeiro x ${round.opponent}, ${round.competition}` : ''
  ].filter(Boolean).join('\n');
}

function openWhatsAppShare() {
  const url = `https://wa.me/?text=${encodeURIComponent(generateWhatsAppMessage())}`;
  window.open(url, '_blank');
}

function startCountdown(deadlineIso) {
  stopCountdown();

  const update = () => {
    const diff = parseAppDateTime(deadlineIso) - Date.now();

    if (diff <= 0) {
      el('countdown').textContent = 'Encerrado';
      return;
    }

    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);

    const timeStr = `${days}d ${String(hours).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
    const cdEl = el('countdown');
    cdEl.textContent = timeStr;
    // Urgente: menos de 1 hora
    const isUrgent = diff < 3600000;
    cdEl.classList.toggle('countdown-urgent', isUrgent);
  };

  update();
  countdownTimer = setInterval(update, 1000);
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
}

function showToast(msg) {
  const toast = el('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden', 'hiding');
  // Force reflow so re-triggering the animation works when called in quick succession
  void toast.offsetWidth;
  toast.style.animation = 'none';
  void toast.offsetWidth;
  toast.style.animation = '';

  clearTimeout(showToast._timer);
  clearTimeout(showToast._fadeTimer);
  showToast._timer = setTimeout(() => {
    toast.classList.add('hiding');
    showToast._fadeTimer = setTimeout(() => toast.classList.add('hidden'), 180);
  }, 2200);
}

function quickState(stateName) {
  const round = getRound(el('roundSelect').value);
  if (!round) return;

  round.manualState = stateName;
  round.updatedAt = new Date().toISOString();
  updateRoundHighlight(round);
  saveState('admin');
  renderAll(currentRoute);
  showToast(`Rodada definida como ${roundStateLabel(round)}.`);
}

function updatePageMeta(route) {
  const titles = {
    home:    ['Bolão do Cruzeiro Debates', 'Organização, competição e identidade forte do Cruzeiro.'],
    round:   ['Rodada', 'Aposta, countdown e detalhes da rodada atual.'],
    ranking: ['Ranking & Estatísticas', 'Classificação geral, destaques e métricas do bolão.'],
    history: ['Histórico', 'Todos os palpites, resultados e pontos.'],
    admin:   ['Painel admin', 'Gestão completa das rodadas e resultados.'],
    print:   ['Versão para impressão', 'Versão limpa para captura de tela, impressão ou PDF.']
  };

  const meta = titles[route] || titles['home'];
  el('pageTitle').textContent = meta[0];
  el('pageSubtitle').textContent = meta[1];
}

function navigate(route) {
  currentRoute = route;
  views.forEach(view => el(`view-${view}`).classList.remove('active'));
  el(`view-${route}`).classList.add('active');
  document.querySelectorAll('.menu-item[data-route]').forEach(btn => btn.classList.toggle('active', btn.dataset.route === route));
  document.querySelectorAll('.bottom-nav-item[data-route]').forEach(btn => btn.classList.toggle('active', btn.dataset.route === route));
  updatePageMeta(route);
  renderAll(route);
  el('sidebar').classList.remove('open');
  // Scroll to top on mobile navigation
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Maps each route to the render functions it needs.
// Always-rendered (sidebar, logout btn, page meta) run unconditionally.
const ROUTE_RENDERS = {
  home:      ['renderHome', 'renderSofaScore', 'renderChat'],
  round:     ['renderDashboard', 'renderRound'],
  ranking:   ['renderRanking'],
  history:   ['renderHistory'],
  stats:     ['renderStats'],
  admin:     ['renderAdmin'],
  print:     ['renderCurrentPrint']
};

// Thin wrapper so renderPrint (which takes printMode) fits the ROUTE_RENDERS
// call-by-name model. printMode is the module-level variable set before navigate().
function renderCurrentPrint() {
  renderPrint(printMode);
}

function renderAll(route) {
  const target = route || currentRoute || 'home';
  currentRoute = target;

  // Always update shared chrome
  el('logoutBtn').classList.toggle('hidden', !session.user);
  renderSidebarUser();
  updatePageMeta(target);

  // Render only the functions relevant to this route
  const fn_map = {
    renderHome, renderLoginOptions, updateLoginHint, renderDashboard,
    renderRanking, renderRound, renderHistory, renderStats, renderAdmin,
    renderSofaScore, renderChat, renderCurrentPrint
  };
  (ROUTE_RENDERS[target] || []).forEach(fnName => {
    if (fn_map[fnName]) fn_map[fnName]();
  });
}

function setupEvents() {
  document.querySelectorAll('[data-route]').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.route)));
  el('menuBtn').addEventListener('click', () => el('sidebar').classList.toggle('open'));
  el('logoutBtn').addEventListener('click', logout);
  el('shareTopBtn').addEventListener('click', openWhatsAppShare);
  el('shareRankingBtn').addEventListener('click', openWhatsAppShare);
  el('shareRoundBtn').addEventListener('click', openWhatsAppShare);
  el('openWhatsBtn').addEventListener('click', openWhatsAppShare);

  // Tab switching — robusto para qualquer .tab-bar
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const bar = btn.closest('.tab-bar');
    if (!bar) return;

    // Marca botão activo
    bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const targetId = btn.dataset.tab;
    if (!targetId) return;

    // O container é o pai do tab-bar.
    // Procura panes no container directo OU num wrapper explícito (adminTabsContainer).
    const container = bar.parentElement;

    // Tenta primeiro no container directo, depois sobe um nível se não encontrar panes
    let panes = Array.from(container.querySelectorAll(':scope > .tab-pane'));
    if (!panes.length) {
      panes = Array.from((container.parentElement || container).querySelectorAll(':scope > .tab-pane'));
    }

    panes.forEach(pane => {
      const isTarget = pane.id === targetId;
      pane.classList.toggle('hidden', !isTarget);
      pane.classList.toggle('active', isTarget);
    });

    // Trigger específico para certas abas
    if (targetId === 'tab-stats') renderStats();
    if (targetId === 'tab-admin-history') renderAdminRoundsHistory();
    if (targetId === 'tab-admin-players') renderPlayersList();
    if (targetId === 'tab-admin-chat' && isAdmin() && firebaseSyncEnabled) initChat();
  });

  el('loginName').addEventListener('change', updateLoginHint);
  el('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await loginOrRegister(el('loginName').value, el('loginPin').value.trim());
  });

  el('betForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const user = currentUser();
    const round = getCurrentRound();

    if (!user || !round) return;

    const roundState = effectiveRoundState(round);
    if (roundState === 'upcoming') {
      showToast('As apostas desta rodada ainda não estão abertas.');
      return;
    }
    if (roundState !== 'open') {
      showToast('As apostas desta rodada estão encerradas.');
      return;
    }

    upsertBet({
      roundId: round.id,
      userName: user.name,
      cruzeiroGoals: Number(el('betCruzeiro').value),
      opponentGoals: Number(el('betOpponent').value)
    });

    renderAll('round');
  });

  el('historyPlayerSelect').addEventListener('change', renderHistory);
  el('roundViewSelect')?.addEventListener('change', renderRound);
  el('roundSelect').addEventListener('change', (e) => populateRoundForm(e.target.value));

  el('roundForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const round = getRound(el('roundSelect').value);
    if (!round) return;

    const matchTimeVal = el('roundMatchTime').value;
    const deadlineVal  = el('roundDeadline').value;

    if (!matchTimeVal || !deadlineVal) {
      showToast('Preencha data do jogo e fecho das apostas.');
      return;
    }

    const matchMs    = parseAppDateTime(matchTimeVal);
    const deadlineMs = parseAppDateTime(deadlineVal);

    if (deadlineMs >= matchMs) {
      showToast('⚠️ O fecho das apostas deve ser antes do início do jogo.');
      return;
    }

    const manualStateVal = el('roundManualState').value;

    if (deadlineMs < Date.now() && manualStateVal === 'auto') {
      showToast('Aviso: o prazo de apostas já passou.');
    }

    round.title          = el('roundTitle').value.trim();
    round.opponent       = el('roundOpponentName').value.trim();
    round.competition    = el('roundCompetition').value.trim();
    round.matchTime      = matchTimeVal;
    round.deadline       = deadlineVal;
    round.manualState    = manualStateVal;
    round.resultCruzeiro = el('resultCruzeiro').value === '' ? null : Number(el('resultCruzeiro').value);
    round.resultOpponent = el('resultOpponent').value === '' ? null : Number(el('resultOpponent').value);
    round.updatedAt      = new Date().toISOString();

    updateRoundHighlight(round);
    saveState('admin');
    renderAll('admin');
    showToast('Rodada salva.');
  });

  el('newRoundBtn').addEventListener('click', () => {
    const todayParts = getZonedParts(new Date(), APP_TIMEZONE);
    const targetDate = new Date(Date.UTC(
      Number(todayParts.year),
      Number(todayParts.month) - 1,
      Number(todayParts.day) + 7
    ));
    const yyyy = targetDate.getUTCFullYear();
    const mm   = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(targetDate.getUTCDate()).padStart(2, '0');

    const matchTime = toLocalInputInAppTime(new Date(parseAppDateTime(`${yyyy}-${mm}-${dd}T20:00`)));
    const deadline  = toLocalInputInAppTime(new Date(parseAppDateTime(`${yyyy}-${mm}-${dd}T19:30`)));

    const round = {
      id: crypto.randomUUID(),
      title: `Rodada ${state.rounds.length + 1}`,
      opponent: 'Novo adversário',
      competition: 'Brasileirão',
      matchTime,
      deadline,
      resultCruzeiro: null,
      resultOpponent: null,
      manualState: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    state.rounds.unshift(round);
    saveState('admin');
    renderAdmin();
    el('roundSelect').value = round.id;
    populateRoundForm(round.id);
    renderHome();
    showToast('Nova rodada criada.');
  });

  el('addPlayerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const ok = addPlayer({
      name: el('newPlayerName').value,
      phone: el('newPlayerPhone').value,
      basePoints: el('newPlayerPoints').value
    });
    if (ok) {
      el('addPlayerForm').reset();
      el('newPlayerPoints').value = '0';
      renderAdmin();
    }
  });

  el('openRoundBtn').addEventListener('click', () => quickState('open'));
  el('closeRoundBtn').addEventListener('click', () => quickState('closed'));
  el('finalizeRoundBtn').addEventListener('click', () => quickState('finalized'));
  el('recalcBtn').addEventListener('click', () => {
    saveState('admin');
    renderAll(currentRoute);
    showToast('Ranking recalculado.');
  });
  el('generateWhatsBtn').addEventListener('click', () => {
    el('whatsMessage').value = generateWhatsAppMessage();
    showToast('Mensagem gerada.');
  });
  el('copyWhatsBtn').addEventListener('click', async () => {
    const text = el('whatsMessage').value || generateWhatsAppMessage();
    await navigator.clipboard.writeText(text);
    showToast('Mensagem copiada.');
  });

  el('printRankingBtn').addEventListener('click', () => {
    printMode = 'ranking';
    navigate('print');
  });

  el('printRoundBtn').addEventListener('click', () => {
    printMode = 'round';
    navigate('print');
  });

  el('triggerPrintBtn').addEventListener('click', () => window.print());

  // Chat público
  el('chatSendBtnMain')?.addEventListener('click', () => sendChatMessage('chatInputMain', false));
  el('chatInputMain')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage('chatInputMain', false); });

  // Chat admin
  el('chatSendBtnAdmin')?.addEventListener('click', () => sendChatMessage('chatInputAdmin', true));
  el('chatInputAdmin')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage('chatInputAdmin', true); });

  // Chat iniciado ao carregar home se utilizador estiver logado


  el('aiAnalyzeBtn')?.addEventListener('click', aiAnalyzeRound);
  el('aiPredictBtn')?.addEventListener('click', aiPredictMatch);
  el('aiWhatsBtn')?.addEventListener('click', aiGenerateWhatsApp);
}

async function init() {
  await initializeDataSource();
  setupEvents();
  el('logoutBtn').classList.toggle('hidden', !session.user);
  // Se já há sessão restaurada (reload da página), inicia o chat
  if (session.user && firebaseSyncEnabled && !chatInitialized) initChat();
  // Regenerate lastRoundHighlight from current data to fix any stale Firebase text
  regenLastRoundHighlight();
  renderAll(session.user ? 'round' : 'home');
}

// Regenerates lastRoundHighlight from the most recent finalized round with a result.
// Fixes stale text stored in Firebase from older app versions.
function regenLastRoundHighlight() {
  const lastFinalized = [...state.rounds]
    .filter(r => r.resultCruzeiro !== null && r.resultOpponent !== null)
    .sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime))[0];

  if (!lastFinalized) return;
  updateRoundHighlight(lastFinalized);
  // Persist correction silently only if text changed (saveState calls Firebase)
  if (firebaseSyncEnabled && firebaseDbRef) {
    firebaseDbRef.update({ lastRoundHighlight: state.lastRoundHighlight });
  }
}

init();
// ── PWA Service Worker Registration ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('SW registration failed:', err));
  });
}
