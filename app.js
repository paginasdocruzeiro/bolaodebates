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
const views = ['home', 'login', 'dashboard', 'ranking', 'round', 'history', 'stats', 'admin', 'ia', 'print'];
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
    bets: [],
    lastRoundHighlight: {
      text: 'Pedro Lucas, único com acerto exato, foi o destaque da última rodada.',
      player: 'Pedro Lucas'
    },
    initialRankingSnapshot: SEED_USERS.map(u => ({ name: u.name, points: u.basePoints }))
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

  return {
    users: mergedUsers,
    rounds: Array.isArray(raw.rounds) ? raw.rounds : base.rounds,
    bets: Array.isArray(raw.bets) ? raw.bets : [],
    lastRoundHighlight: raw.lastRoundHighlight || base.lastRoundHighlight,
    initialRankingSnapshot: Array.isArray(raw.initialRankingSnapshot)
      ? raw.initialRankingSnapshot
      : base.initialRankingSnapshot
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

function saveState() {
  applyAdminFlags();
  persistLocalState();
  if (firebaseDbRef) {
    // Use update() instead of set() to merge with existing Firebase data,
    // preventing accidental overwrite of nodes not present in local state.
    firebaseDbRef.update({
      users:                  state.users,
      rounds:                 state.rounds,
      bets:                   state.bets,
      lastRoundHighlight:     state.lastRoundHighlight,
      initialRankingSnapshot: state.initialRankingSnapshot
    });
  }
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
  const betsForRound = state.bets.filter(b => b.roundId === round.id).length;
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
  return state.bets.find(b => b.roundId === roundId && b.userName === userName);
}

function getMissingBettors(round = getCurrentRound()) {
  if (!round || effectiveRoundState(round) !== 'open') return [];
  return state.users.filter(user => !getBet(round.id, user.name));
}

function generateMissingBetsMessage() {
  const round = getCurrentRound();
  if (!round) return 'Sem rodada ativa.';

  const missing = getMissingBettors(round);

  if (!missing.length) {
    return `✅ Todos já apostaram para Cruzeiro x ${round.opponent}`;
  }

  const list = missing.map(u => u.phone ? `${u.name} (${u.phone})` : u.name).join('\n');

  return [
    `⚽ Apostadores em falta para Cruzeiro x ${round.opponent}`,
    '',
    list,
    '',
    `Prazo: ${formatDateTime(round.deadline)}, ${APP_TIMEZONE_LABEL}.`
  ].join('\n');
}

function openMissingBetsWhatsApp() {
  const round = getCurrentRound();
  if (!round) { showToast("Sem rodada ativa."); return; }

  const missing = getMissingBettors(round);
  if (!missing.length) { showToast("Todos já apostaram!"); return; }

  const withPhone = missing.filter(u => u.phone);
  const withoutPhone = missing.filter(u => !u.phone);

  if (!withPhone.length) {
    const url = `https://wa.me/?text=${encodeURIComponent(generateMissingBetsMessage())}`;
    window.open(url, "_blank");
    return;
  }

  const deadline = formatDateTime(round.deadline);
  const msg = encodeURIComponent(
    `⚽ Olá! Ainda não apostaste no Bolão Cruzeiro Debates para o jogo Cruzeiro x ${round.opponent}.\n\nPrazo: ${deadline}, ${APP_TIMEZONE_LABEL}.\n\nAcede aqui: https://paginasdocruzeiro.github.io/bolaodebates/`
  );

  withPhone.forEach((user, i) => {
    const phone = user.phone.replace(/\D/g, "");
    setTimeout(() => {
      window.open(`https://wa.me/${phone}?text=${msg}`, "_blank");
    }, i * 600);
  });

  if (withoutPhone.length) {
    setTimeout(() => {
      showToast(`Sem número: ${withoutPhone.map(u => u.name).join(", ")}`);
    }, withPhone.length * 600 + 200);
  }
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

  if (existing) {
    existing.cruzeiroGoals = cruzeiroGoals;
    existing.opponentGoals = opponentGoals;
    existing.updatedAt = nowIso;
    showToast('Palpite atualizado com sucesso.');
  } else {
    state.bets.push({
      id: crypto.randomUUID(),
      roundId,
      userName,
      cruzeiroGoals,
      opponentGoals,
      createdAt: nowIso,
      updatedAt: nowIso
    });
    showToast('Palpite registado com sucesso.');
  }

  saveState();
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

    state.rounds.forEach((round) => {
      if (round.resultCruzeiro === null || round.resultOpponent === null) return;

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
      const hasResult = round.resultCruzeiro !== null && round.resultOpponent !== null;
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
        pointsLabel: didNotBet ? '0 (não apostou)' : (hasResult ? `${score ? score.points : 0} ponto(s)` : '-'),
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
  const sorted = [...roundScores]; // already sorted by round order from calculateRankings
  const last = sorted[sorted.length - 1];
  const scoring = last.points > 0;
  let count = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if ((sorted[i].points > 0) === scoring) count++;
    else break;
  }
  if (scoring) return `🔥 ${count} seguida${count > 1 ? 's' : ''} a pontuar`;
  return `❄️ ${count} seguida${count > 1 ? 's' : ''} sem pontuar`;
}

function getStatsSummary() {
  const ranking = calculateRankings();
  const roundRanking = getRoundRanking();
  const totalBets = state.bets.length;
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
const CRUZEIRO_ID = 1625; // ID do Cruzeiro na football-data.org
const BRASILEIRAO_ID = 2013; // ID da Série A

async function fetchFootballData(endpoint) {
  const key = window.BOLAO_FOOTBALL_KEY;
  if (!key || key === 'cole_o_seu_token_aqui') return null;
  try {
    const res = await fetch(`https://api.football-data.org/v4/${endpoint}`, {
      headers: { 'X-Auth-Token': key }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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
  const round = getCurrentRound();
  if (!round || round.resultCruzeiro === null) {
    out.textContent = 'Esta função só está disponível depois de lançar o resultado da rodada.';
    out.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ A analisar...';
  out.classList.remove('hidden');
  out.textContent = 'A buscar dados e gerar análise...';

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
  const round = getCurrentRound();
  if (!round) {
    out.textContent = 'Sem rodada ativa para prever.';
    out.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ A prever...';
  out.classList.remove('hidden');
  out.textContent = 'A buscar dados e gerar previsão...';

  const ranking = calculateRankings();
  const footballCtx = await getCruzeiroContext();
  const allHistory = ranking.map(u => {
    const h = getUserHistory(u.name).filter(x => x.betLabel !== '-' && x.betLabel !== 'Sem palpite');
    return `${u.name}: ${h.slice(-5).map(x => x.betLabel).join(', ') || 'sem apostas ainda'}`;
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
  btn.textContent = '⏳ A criar mensagem...';
  out.classList.remove('hidden');
  out.textContent = 'A gerar mensagem criativa...';

  const ranking = calculateRankings();
  const roundRanking = getRoundRanking(round);

  const lider = ranking[0];
  const lanterna = ranking[ranking.length - 1];
  const prompt = `Crie uma mensagem para o grupo de WhatsApp do Bolão Cruzeiro Debates. Escreva em português do Brasil, estilo animado de grupo de amigos. Use os nomes reais. Provoque o último colocado pelo nome com bom humor, elogie o líder. Inclua o ranking completo formatado para WhatsApp. Use emojis 💙⚽🏆🔥. Máximo 20 linhas.

RANKING COMPLETO: ${ranking.map(r => `${r.position}º ${r.name} — ${r.totalPoints} pts (${r.exact} exatos)`).join(' | ')}
LÍDER: ${lider?.name} com ${lider?.totalPoints} pontos
LANTERNA: ${lanterna?.name} com ${lanterna?.totalPoints} pontos
${round ? `PRÓXIMO JOGO: Cruzeiro x ${round.opponent} — ${round.competition}` : ''}
${roundRanking.length ? `DESTAQUE DA ÚLTIMA RODADA: ${roundRanking[0]?.name} com ${roundRanking[0]?.points} ponto(s)` : ''}`;

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

function tableHTML(headers, rows) {
  return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
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
    el('loginHint').textContent = 'Acesso existente: introduza o PIN já definido.';
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
    saveState();
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
      saveState();
    }
  }

  session.user = user;
  saveSession(user);
  el('logoutBtn').classList.remove('hidden');
  navigate('dashboard');
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
  el('iaNavBtn')?.classList.toggle('hidden', !user);
}

function renderHome() {
  const round = getCurrentRound();
  el('homeNextMatch').innerHTML = round ? `
    <p><strong>Cruzeiro x ${round.opponent}</strong></p>
    <p>${round.competition}</p>
    <p>${formatDateTime(round.matchTime)}</p>
    <p class="highlight">${roundStateLabel(round)}</p>
  ` : '<p>Nenhuma rodada disponível.</p>';

  if (round && effectiveRoundState(round) === 'open') {
    const missing = getMissingBettors(round);
    el('homeNextMatch').innerHTML += missing.length
      ? `<p class="highlight">⚠️ Apostadores em falta: ${missing.map(u => u.name).join(', ')}</p>`
      : `<p class="highlight">✅ Todos já apostaram nesta rodada</p>`;
  }

  // Check for perfect round in the last finalized round
  const lastFinalized = [...state.rounds]
    .filter(r => effectiveRoundState(r) === 'finalized' && r.resultCruzeiro !== null)
    .sort((a, b) => parseAppDateTime(b.matchTime) - parseAppDateTime(a.matchTime))[0];
  const perfectInLast = lastFinalized
    ? getRoundRanking(lastFinalized).filter(r => r.type === 'exato').map(r => r.name)
    : [];

  el('lastHighlightCard').innerHTML = `
    ${perfectInLast.length ? `<p style="color:var(--gold);font-weight:700">🏆 Rodada perfeita: ${formatNames(perfectInLast)} acertou${perfectInLast.length > 1 ? 'ram' : ''} o placar exacto!</p>` : ''}
    <p class="highlight">🔥 ${state.lastRoundHighlight.text}</p>
    <p class="muted">Destaques e ranking são atualizados automaticamente quando o resultado é lançado.</p>
  `;

  // Upcoming panel — all rounds in upcoming state, sorted by matchTime.
  // Exclude a round only if it is already shown as the active round in homeNextMatch
  // AND its state is open/closed/result (not upcoming).
  const currentRound = getCurrentRound();
  const currentIsActive = currentRound && ['open', 'closed', 'result'].includes(effectiveRoundState(currentRound));
  const upcoming = [...state.rounds]
    .filter(r => {
      const s = effectiveRoundState(r);
      if (s !== 'upcoming') return false;            // only show upcoming rounds here
      if (currentIsActive && r.id === currentRound.id) return false; // already shown as active
      return true;
    })
    .sort((a, b) => parseAppDateTime(a.matchTime) - parseAppDateTime(b.matchTime));

  const upcomingPanel = el('homeUpcomingPanel');
  const upcomingWrap  = el('homeUpcomingRounds');

  if (!upcoming.length) {
    upcomingPanel.classList.add('hidden');
  } else {
    upcomingPanel.classList.remove('hidden');
    upcomingWrap.innerHTML = upcoming.map(r => `
      <div style="padding:8px 0;border-bottom:1px solid var(--line);">
        <p style="margin:0"><strong>Cruzeiro x ${r.opponent}</strong></p>
        <p style="margin:2px 0;font-size:.85rem;color:var(--text-2)">${r.competition} — ${formatDateTime(r.matchTime)}</p>
        <p style="margin:2px 0" class="highlight" style="font-size:.82rem">${roundStateLabel(r)}</p>
      </div>
    `).join('') + (upcoming.length === 0 ? '<p class="muted">Sem rodadas agendadas.</p>' : '');
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
  el('dashboardNextMatch').innerHTML = `
    <p><strong>Cruzeiro x ${round.opponent}</strong></p>
    <p>${round.competition}</p>
    <p><strong>Jogo:</strong> ${formatDateTime(round.matchTime)}</p>
    <p><strong>Fecho:</strong> ${formatDateTime(round.deadline)} (${APP_TIMEZONE_LABEL})</p>
  `;

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

  const disabled = stateNow !== 'open';
  Array.from(el('betForm').querySelectorAll('input, button')).forEach(node => node.disabled = disabled);

  if (bet) {
    el('betConfirmation').classList.remove('hidden');
    el('betConfirmation').innerHTML = `<strong>Palpite registado:</strong> ${bet.cruzeiroGoals}x${bet.opponentGoals}<br><span class="muted">Última gravação: ${formatDateTime(bet.updatedAt)}</span>`;
  } else {
    el('betConfirmation').classList.add('hidden');
  }

  const history = getUserHistory(user.name).slice(-5).reverse();
  el('quickHistory').innerHTML = history.length
    ? `<ul>${history.map(item => `<li>${item.title}, ${item.betLabel}, ${item.pointsLabel}</li>`).join('')}</ul>`
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
      ${tableHTML(['Pos.', 'Nome', 'Aposta', 'Pontos', 'Tipo'], roundRanking.map(item => [`${item.position}º`, item.name, item.bet, String(item.points), badge(item.type)]))}
    `;
  }

  // Streak column in overall ranking
  el('overallRankingWrap').innerHTML = tableHTML(
    ['Pos.', 'Nome', 'Pontos', 'Mov.', 'Exatos', 'Parciais', 'Sequência'],
    ranking.map(item => [
      `${item.position}º`,
      item.name,
      String(item.totalPoints),
      movementHTML(item.movement, item.movementDelta),
      String(item.exact),
      String(item.partial),
      item.roundScores.length ? currentStreak(item.roundScores) : '—'
    ])
  );

  el('consistencyWrap').innerHTML = tableHTML(
    ['Pos.', 'Nome', 'Média', 'Pontuou', 'Zeros', 'Sem palpite', 'Rodadas'],
    consistency.map(item => [
      `${item.position}º`,
      item.name,
      item.average.toFixed(2),
      String(item.scoringRounds),
      String(item.zeroRounds),    // apostou e errou — clean field, no subtraction
      String(item.missedRounds),  // não apostou — clean field
      String(item.roundsPlayed)
    ])
  );
}

function renderRound() {
  const round = getCurrentRound();

  if (!round) {
    el('roundSummary').innerHTML = '<p>Nenhuma rodada disponível.</p>';
    el('roundTableWrap').innerHTML = '';
    return;
  }

  const resultText = round.resultCruzeiro !== null && round.resultOpponent !== null
    ? `${round.resultCruzeiro}x${round.resultOpponent}`
    : 'Ainda não lançado';

  const roundRanking = getRoundRanking(round);

  // Most popular bet
  const allBets = state.bets.filter(b => b.roundId === round.id);
  const betCounts = {};
  allBets.forEach(b => {
    const key = `${b.cruzeiroGoals}x${b.opponentGoals}`;
    betCounts[key] = (betCounts[key] || 0) + 1;
  });
  const popularBet = Object.entries(betCounts).sort((a, b) => b[1] - a[1])[0];
  const popularBetText = popularBet
    ? `${popularBet[0]} (${popularBet[1]} aposta${popularBet[1] > 1 ? 's' : ''})`
    : '—';

  const hasResult = round.resultCruzeiro !== null && round.resultOpponent !== null;

  // Winner label — only shown after result is known
  const winner = hasResult && roundRanking.length ? roundWinnerLabel(roundRanking) : null;
  const winnerText = !winner
    ? ''
    : winner.points === 0
      ? '<p><strong>Jogador(es) da rodada:</strong> <span class="muted">Ninguém pontuou</span></p>'
      : `<p><strong>Jogador(es) da rodada:</strong> <span class="highlight">${winner.text}</span></p>`;

  // Rodada perfeita — only shown after result is known
  const perfectPlayers = hasResult ? roundRanking.filter(r => r.type === 'exato').map(r => r.name) : [];
  const perfectText = perfectPlayers.length
    ? `<p>🏆 <strong>Rodada perfeita:</strong> <span class="highlight" style="color:var(--gold)">${formatNames(perfectPlayers)} acertou${perfectPlayers.length > 1 ? 'ram' : ''} o placar exacto!</span></p>`
    : '';

  el('roundSummary').innerHTML = `
    <span class="mini-label">Resumo</span>
    <h3>${round.title}</h3>
    <p><strong>Jogo:</strong> Cruzeiro x ${round.opponent}</p>
    <p><strong>Competição:</strong> ${round.competition}</p>
    <p><strong>Estado:</strong> ${roundStateLabel(round)}</p>
    <p><strong>Fecho:</strong> ${formatDateTime(round.deadline)} (${APP_TIMEZONE_LABEL})</p>
    <p><strong>Resultado real:</strong> ${hasResult ? resultText : 'A definir'}</p>
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
      bet              ? `${bet.cruzeiroGoals}x${bet.opponentGoals}` : (noBetWithResult ? 'Sem palpite' : '—'),
      noBetWithResult  ? '0'                 : (score ? String(score.points) : '—'),
      noBetWithResult  ? badge('sem aposta') : (score ? badge(score.type)    : '—')
    ];
  });

  el('roundTableWrap').innerHTML = tableHTML(['Nome', 'Aposta', 'Pontos', 'Tipo de acerto'], rows);

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
    : `${winner.text} foi${winner.names.length > 1 ? 'am' : ''} o${winner.names.length > 1 ? 's' : ''} jogador${winner.names.length > 1 ? 'es' : ''} da rodada com ${winner.points} ponto(s).`;
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
      ${ranking.roundScores.length ? `<br>Sequência actual: ${currentStreak(ranking.roundScores)}` : ''}
    </div>
  ` : '';

  el('historyTableWrap').innerHTML = tableHTML(
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
  el('statsGrid').innerHTML = stats.map(item => `
    <article class="stat-card">
      <div class="label">${item.label}</div>
      <div class="value">${item.value}</div>
    </article>
  `).join('');
}


function renderIA() {
  // Apenas utilizadores logados
  if (!currentUser()) {
    navigate('login');
    return;
  }
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
  saveState();
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
  saveState();
  renderAdmin();
  showToast(`${user.name} removido.`);
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
        <th style="padding:8px 6px;"></th>
      </tr></thead>
      <tbody>
        ${state.users.map(u => `
          <tr style="border-top:1px solid var(--line);">
            <td style="padding:8px 6px;">${u.name}${u.isAdmin ? ' <span style="color:var(--gold);font-size:.75rem;">admin</span>' : ''}</td>
            <td style="padding:8px 6px;">${u.basePoints}</td>
            <td style="padding:8px 6px;">${u.pin ? '✅' : '—'}</td>
            <td style="padding:8px 6px;">
              ${!u.isAdmin ? `<button class="btn btn-ghost" style="padding:6px 10px;font-size:.78rem;" onclick="removePlayer('${u.id}')">Remover</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
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

  el('roundSelect').innerHTML = state.rounds.map(r => `<option value="${r.id}">${r.title}, Cruzeiro x ${r.opponent}</option>`).join('');
  if (!el('roundSelect').value && state.rounds[0]) el('roundSelect').value = state.rounds[0].id;
  populateRoundForm(el('roundSelect').value);

  const missingWrap = el('missingBetsAdminWrap');
  if (missingWrap) {
    const round = getCurrentRound();
    const missing = getMissingBettors(round);

    missingWrap.innerHTML = round && effectiveRoundState(round) === 'open'
      ? (missing.length
          ? `<p><strong>Apostadores em falta:</strong> ${missing.map(u => u.name).join(', ')}</p>`
          : `<p><strong>Apostadores em falta:</strong> ninguém, todos já apostaram.</p>`)
      : '<p><strong>Apostadores em falta:</strong> sem rodada aberta.</p>';
  }

  renderPlayersList();

  // Show Firebase UID so admins can share it for registration in adminUids
  const uidWrap = el('adminUidDisplay');
  if (uidWrap) {
    const uid = getFirebaseUid();
    uidWrap.innerHTML = uid
      ? `<span class="sidebar-user-label">O teu UID Firebase</span>
         <code style="word-break:break-all;font-size:.82rem;color:var(--accent-soft)">${uid}</code>
         <span class="muted" style="font-size:.78rem">Partilha este valor com o Ivo para ficares registado como admin.</span>`
      : `<span class="muted" style="font-size:.78rem">UID não disponível (modo local).</span>`;
  }
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

    el('countdown').textContent = `${days}d ${String(hours).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
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
  saveState();
  renderAll(currentRoute);
  showToast(`Rodada definida como ${roundStateLabel(round)}.`);
}

function updatePageMeta(route) {
  const titles = {
    home: ['Bolão do Cruzeiro Debates', 'Organização, competição e identidade forte do Cruzeiro.'],
    login: ['Entrar', 'Acesso simples com nome e PIN.'],
    dashboard: ['Dashboard', 'Visão rápida da rodada e do seu desempenho.'],
    ranking: ['Ranking', 'Classificação geral, rodada e consistência.'],
    round: ['Rodada', 'Transparência total da rodada atual.'],
    history: ['Histórico', 'Todos os palpites, resultados e pontos.'],
    stats: ['Estatísticas', 'Indicadores gerais do bolão.'],
    admin: ['Painel admin', 'Gestão completa das rodadas e resultados.'],
    print: ['Modo printável', 'Versão limpa para screenshot, impressão ou PDF.']
  };

  el('pageTitle').textContent = titles[route][0];
  el('pageSubtitle').textContent = titles[route][1];
}

function navigate(route) {
  currentRoute = route;
  views.forEach(view => el(`view-${view}`).classList.remove('active'));
  el(`view-${route}`).classList.add('active');
  document.querySelectorAll('.menu-item[data-route]').forEach(btn => btn.classList.toggle('active', btn.dataset.route === route));
  updatePageMeta(route);
  renderAll(route);
  el('sidebar').classList.remove('open');
}

// Maps each route to the render functions it needs.
// Always-rendered (sidebar, logout btn, page meta) run unconditionally.
const ROUTE_RENDERS = {
  home:      ['renderHome'],
  login:     ['renderLoginOptions', 'updateLoginHint'],
  dashboard: ['renderLoginOptions', 'updateLoginHint', 'renderDashboard'],
  ranking:   ['renderRanking'],
  round:     ['renderRound'],
  history:   ['renderHistory'],
  stats:     ['renderStats'],
  admin:     ['renderAdmin'],
  ia:        ['renderIA'],
  print:     ['renderCurrentPrint']  // consistent with the rest of the routing system
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
    renderIA, renderCurrentPrint
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
  el('missingBetsBtn')?.addEventListener('click', openMissingBetsWhatsApp);

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

    renderAll('dashboard');
  });

  el('historyPlayerSelect').addEventListener('change', renderHistory);
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
      // Warn but don't block — admin may be editing a past round
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

    updateRoundHighlight(round); // pass edited round explicitly, not getCurrentRound()
    saveState();
    renderAll('admin');
    showToast('Rodada guardada.');
  });

  el('newRoundBtn').addEventListener('click', () => {
    // Get today's date parts in app timezone, then compose target strings directly.
    // No manual UTC offset arithmetic — toLocalInputInAppTime handles the conversion.
    const todayParts = getZonedParts(new Date(), APP_TIMEZONE);
    const targetDate = new Date(Date.UTC(
      Number(todayParts.year),
      Number(todayParts.month) - 1,
      Number(todayParts.day) + 7
    ));
    const yyyy = targetDate.getUTCFullYear();
    const mm   = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(targetDate.getUTCDate()).padStart(2, '0');

    // Build strings in app-timezone format, then round-trip through parseAppDateTime
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
    saveState();
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
    saveState();
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
    navigate('print');  // renderCurrentPrint() is called by ROUTE_RENDERS inside navigate()
  });

  el('printRoundBtn').addEventListener('click', () => {
    printMode = 'round';
    navigate('print');  // renderCurrentPrint() is called by ROUTE_RENDERS inside navigate()
  });

  el('triggerPrintBtn').addEventListener('click', () => window.print());

  el('aiAnalyzeBtn')?.addEventListener('click', aiAnalyzeRound);
  el('aiPredictBtn')?.addEventListener('click', aiPredictMatch);
  el('aiWhatsBtn')?.addEventListener('click', aiGenerateWhatsApp);
  el('iaNavBtn')?.addEventListener('click', () => navigate('ia'));
}

async function init() {
  await initializeDataSource(); // restoreSession() called inside for both local and Firebase paths
  setupEvents();
  el('logoutBtn').classList.toggle('hidden', !session.user);
  renderAll(session.user ? 'dashboard' : 'home');
}

init();
