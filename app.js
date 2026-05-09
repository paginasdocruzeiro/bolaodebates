/*
  Bolão do Cruzeiro Debates — app.js V1 com Configurações de Automação
  Base estável: commit 4a80abf007ae7939dae96c73266be915353079c1
*/

(function loadBolaoAppWithAutomationSettings() {
  const STABLE_APP_URL = 'https://cdn.jsdelivr.net/gh/paginasdocruzeiro/bolaodebates@4a80abf007ae7939dae96c73266be915353079c1/app.js';

  const DEFAULT_AUTOMATION = {
    enabled: true,
    openBetsEnabled: true,
    openBeforeValue: 12,
    openBeforeUnit: 'hours',
    closeBetsEnabled: true,
    closeBeforeValue: 5,
    closeBeforeUnit: 'minutes',
    autoApplyResults: true,
    autoCreateRounds: true,
    newRoundDefaultMode: 'auto',
    allowManualOverride: true,
    updatedAt: null
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src + '?v=automation-settings-v2-20260509';
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Não foi possível carregar a base estável do app.js.'));
      document.head.appendChild(script);
    });
  }

  function q(id) {
    return document.getElementById(id);
  }

  function toast(message) {
    try {
      if (typeof showToast === 'function') {
        showToast(message);
        return;
      }
    } catch {}
    console.log(message);
  }

  function baseStatePath() {
    return window.BOLAO_FIREBASE_PATH || 'bolao-cruzeiro-debates/state';
  }

  function currentFirebaseUid() {
    try {
      return firebase.auth().currentUser?.uid || null;
    } catch {
      return null;
    }
  }

  function appState() {
    try {
      if (typeof state !== 'undefined') return state;
    } catch {}
    return null;
  }

  function automationSettings() {
    const s = appState();
    const saved = s?.settings?.automation || s?.automation || {};
    return { ...DEFAULT_AUTOMATION, ...saved };
  }

  function ensureSettingsInLocalState(nextAutomation) {
    const s = appState();
    if (!s) return;

    if (!s.settings || typeof s.settings !== 'object') {
      s.settings = {};
    }

    s.settings.automation = {
      ...DEFAULT_AUTOMATION,
      ...nextAutomation
    };
  }

  function unitMs(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;

    if (unit === 'days') return n * 24 * 60 * 60 * 1000;
    if (unit === 'hours') return n * 60 * 60 * 1000;
    return n * 60 * 1000;
  }

  function parseMs(value) {
    if (!value) return NaN;

    try {
      if (typeof parseAppDateTime === 'function') {
        const parsed = parseAppDateTime(value);
        return Number.isFinite(parsed) ? parsed : NaN;
      }
    } catch {}

    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }

  function toAppInput(date) {
    try {
      if (typeof toLocalInputInAppTime === 'function') {
        return toLocalInputInAppTime(date);
      }
    } catch {}

    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatDate(value) {
    if (!value) return '—';

    try {
      if (typeof formatDateTime === 'function') return formatDateTime(value);
    } catch {}

    return value;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '—';

    const seconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts = [];
    if (days) parts.push(days + 'd');
    if (hours) parts.push(hours + 'h');
    parts.push(minutes + 'min');

    return parts.join(' ');
  }

  function numberOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function roundNumberFromTitle(title) {
    const match = String(title || '').match(/rodada\s*(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  function nextRoundNumber() {
    const s = appState();
    const rounds = Array.isArray(s?.rounds) ? s.rounds : [];
    return rounds.reduce((max, round) => {
      return Math.max(max, Number(round.roundNumber) || roundNumberFromTitle(round.title) || 0);
    }, 0) + 1;
  }

  function computeTimes(matchTime, automation = automationSettings()) {
    const matchMs = parseMs(matchTime);

    if (!Number.isFinite(matchMs)) {
      return { autoOpenAt: '', deadline: '' };
    }

    const openMs = matchMs - unitMs(automation.openBeforeValue, automation.openBeforeUnit);
    const closeMs = matchMs - unitMs(automation.closeBeforeValue, automation.closeBeforeUnit);

    return {
      autoOpenAt: toAppInput(new Date(openMs)),
      deadline: toAppInput(new Date(closeMs))
    };
  }

  function ensureAdminErrorBox(message, err) {
    const uid = currentFirebaseUid();
    const box = q('adminUidDisplay');

    if (!box) return;

    box.innerHTML = `
      <strong>Erro ao salvar no Firebase</strong>
      <span>${message}</span>
      ${err ? `<span>Erro: ${String(err?.message || err)}</span>` : ''}
      <span>UID atual: <code style="user-select:all;">${uid || 'sem UID'}</code></span>
      <span>Confirme se este UID existe em <code>bolao-cruzeiro-debates/private/adminUids</code> com valor <code>true</code>.</span>
    `;
    box.classList.remove('hidden');
  }

  function overrideEffectiveRoundState() {
    const replacement = function effectiveRoundStateWithAutomation(round) {
      if (!round) return 'none';

      const automation = automationSettings();

      if (automation.allowManualOverride !== false && round.manualState && round.manualState !== 'auto') {
        return round.manualState;
      }

      const hasResult =
        round.resultCruzeiro !== null &&
        round.resultCruzeiro !== undefined &&
        round.resultOpponent !== null &&
        round.resultOpponent !== undefined;

      if (hasResult) return 'result';

      const matchMs = parseMs(round.matchTime);
      if (!Number.isFinite(matchMs)) return 'none';

      if (!automation.enabled) {
        return 'upcoming';
      }

      const nowMs = Date.now();

      const openMs = matchMs - unitMs(automation.openBeforeValue, automation.openBeforeUnit);
      const deadlineMs = matchMs - unitMs(automation.closeBeforeValue, automation.closeBeforeUnit);

      if (automation.closeBetsEnabled && nowMs >= deadlineMs) return 'closed';

      if (!automation.openBetsEnabled) return 'upcoming';

      if (nowMs < openMs) return 'upcoming';

      return 'open';
    };

    try {
      effectiveRoundState = replacement;
    } catch {
      window.effectiveRoundState = replacement;
    }
  }

  function computeStatusFromForm() {
    let round = null;

    try {
      if (typeof getRound === 'function') round = getRound(q('roundSelect')?.value);
    } catch {}

    const draft = {
      ...(round || {}),
      opponent: q('roundOpponentName')?.value || round?.opponent || '',
      matchTime: q('roundMatchTime')?.value || round?.matchTime || '',
      deadline: q('roundDeadline')?.value || round?.deadline || '',
      manualState: q('roundManualState')?.value || round?.manualState || 'auto',
      resultCruzeiro: numberOrNull(q('resultCruzeiro')?.value),
      resultOpponent: numberOrNull(q('resultOpponent')?.value)
    };

    const automation = automationSettings();
    const now = Date.now();
    const matchMs = parseMs(draft.matchTime);
    const openMs = matchMs - unitMs(automation.openBeforeValue, automation.openBeforeUnit);
    const deadlineMs = matchMs - unitMs(automation.closeBeforeValue, automation.closeBeforeUnit);
    const computedOpenInput = Number.isFinite(openMs) ? toAppInput(new Date(openMs)) : '';
    const computedDeadlineInput = Number.isFinite(deadlineMs) ? toAppInput(new Date(deadlineMs)) : '';

    const hasResult =
      draft.resultCruzeiro !== null &&
      draft.resultCruzeiro !== undefined &&
      draft.resultOpponent !== null &&
      draft.resultOpponent !== undefined;

    if (hasResult) {
      return {
        cls: 'result',
        title: 'Resultado lançado',
        desc: `Cruzeiro ${draft.resultCruzeiro} x ${draft.resultOpponent} ${draft.opponent || ''}.`
      };
    }

    if (automation.allowManualOverride !== false && draft.manualState && draft.manualState !== 'auto') {
      const labels = {
        upcoming: 'Em espera',
        open: 'Apostas abertas',
        closed: 'Apostas encerradas',
        finalized: 'Rodada finalizada',
        result: 'Resultado lançado'
      };

      return {
        cls: draft.manualState === 'open' ? 'open' : draft.manualState === 'closed' ? 'closed' : 'manual',
        title: 'Estado manual: ' + (labels[draft.manualState] || draft.manualState),
        desc: 'Esta rodada está em controlo manual. Para usar a automação, escolha “Automático” e salve.'
      };
    }

    if (!automation.enabled) {
      return {
        cls: 'neutral',
        title: 'Automação desligada',
        desc: 'A rodada ficará em espera até um admin definir manualmente o estado.'
      };
    }

    if (!Number.isFinite(matchMs)) {
      return {
        cls: 'neutral',
        title: 'Data do jogo ausente',
        desc: 'Sem data/hora válida, a automação não consegue calcular abertura e fecho.'
      };
    }

    if (automation.closeBetsEnabled && now >= deadlineMs) {
      return {
        cls: 'closed',
        title: 'Apostas encerradas',
        desc: 'Aguardando resultado oficial da API ou lançamento manual pelo admin.'
      };
    }

    if (!automation.openBetsEnabled) {
      return {
        cls: 'waiting',
        title: 'Abertura automática desligada',
        desc: 'As apostas só abrem se um admin mudar o estado manualmente.'
      };
    }

    if (now < openMs) {
      return {
        cls: 'waiting',
        title: 'Apostas abrem em ' + formatDuration(openMs - now),
        desc: `Abertura: ${formatDate(computedOpenInput)}. Fecho: ${formatDate(computedDeadlineInput)}.`
      };
    }

    return {
      cls: 'open',
      title: 'Apostas abertas',
      desc: automation.closeBetsEnabled
        ? 'Fecham em ' + formatDuration(deadlineMs - now) + ', às ' + formatDate(computedDeadlineInput) + '.'
        : 'Fecho automático desligado.'
    };
  }

  function installRibbonStyle() {
    if (q('adminAutoStatusRibbonStyle')) return;

    const style = document.createElement('style');
    style.id = 'adminAutoStatusRibbonStyle';
    style.textContent = `
      .admin-auto-status-ribbon {
        margin: 12px 0 14px;
        padding: 13px 15px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.05);
        color: var(--text-2);
      }
      .admin-auto-status-title {
        font-weight: 800;
        color: var(--text);
        margin-bottom: 4px;
      }
      .admin-auto-status-desc {
        font-size: .88rem;
        line-height: 1.45;
      }
      .admin-auto-status-ribbon.open {
        border-color: rgba(57,217,138,.42);
        background: rgba(57,217,138,.11);
      }
      .admin-auto-status-ribbon.open .admin-auto-status-title {
        color: var(--green);
      }
      .admin-auto-status-ribbon.closed {
        border-color: rgba(255,215,107,.42);
        background: rgba(255,215,107,.10);
      }
      .admin-auto-status-ribbon.closed .admin-auto-status-title {
        color: var(--yellow);
      }
      .admin-auto-status-ribbon.waiting {
        border-color: rgba(96,165,250,.42);
        background: rgba(59,130,246,.10);
      }
      .admin-auto-status-ribbon.waiting .admin-auto-status-title {
        color: var(--accent-soft);
      }
      .admin-auto-status-ribbon.result {
        border-color: rgba(215,184,107,.45);
        background: rgba(215,184,107,.10);
      }
      .admin-auto-status-ribbon.result .admin-auto-status-title {
        color: var(--gold);
      }
      .admin-auto-status-ribbon.manual {
        border-color: rgba(255,125,125,.40);
        background: rgba(255,125,125,.10);
      }
      .admin-auto-status-ribbon.manual .admin-auto-status-title {
        color: var(--red);
      }
      .automation-settings-grid {
        display:grid;
        gap:16px;
        max-width:980px;
      }
      .automation-settings-card {
        padding:18px;
        border:1px solid var(--line);
        border-radius:18px;
        background:linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.025));
      }
      .automation-card-title {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        margin-bottom:12px;
      }
      .automation-card-title strong {
        font-size:1rem;
      }
      .automation-card-title span {
        color:var(--text-2);
        font-size:.84rem;
      }
      .automation-toggle-row {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:18px;
        padding:12px 0;
        border-top:1px solid rgba(255,255,255,.06);
      }
      .automation-toggle-text {
        display:grid;
        gap:3px;
      }
      .automation-toggle-text strong {
        font-size:.94rem;
        color:var(--text);
      }
      .automation-toggle-text span {
        font-size:.82rem;
        color:var(--text-2);
      }
      .automation-toggle-row input[type="checkbox"] {
        width:18px;
        height:18px;
        flex:0 0 auto;
      }
      .automation-row {
        display:grid;
        grid-template-columns: minmax(180px, 1fr) 160px auto;
        gap:12px;
        align-items:end;
        margin-top:12px;
      }
      .automation-field {
        display:grid;
        gap:7px;
        color:var(--text-2);
        font-size:.84rem;
      }
      .automation-field input,
      .automation-field select {
        width:100%;
      }
      .automation-hint {
        color:var(--text-2);
        font-size:.84rem;
        padding-bottom:13px;
      }
      .automation-summary {
        padding:15px 17px;
        border-radius:16px;
        border:1px solid rgba(96,165,250,.35);
        background:rgba(59,130,246,.09);
        color:var(--text-2);
        line-height:1.55;
        max-width:980px;
      }
      .automation-actions {
        display:flex;
        gap:10px;
        flex-wrap:wrap;
      }
      @media (max-width:720px) {
        .automation-row {
          grid-template-columns: 1fr;
        }
        .automation-hint {
          padding-bottom:0;
        }
        .automation-toggle-row {
          align-items:flex-start;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function renderRibbon() {
    installRibbonStyle();

    const manualSelect = q('roundManualState');
    if (!manualSelect) return;

    let ribbon = q('adminRoundAutoStatusRibbon');

    if (!ribbon) {
      ribbon = document.createElement('div');
      ribbon.id = 'adminRoundAutoStatusRibbon';
      ribbon.className = 'admin-auto-status-ribbon neutral';
      manualSelect.closest('label')?.insertAdjacentElement('afterend', ribbon);
    }

    const status = computeStatusFromForm();
    ribbon.className = 'admin-auto-status-ribbon ' + status.cls;
    ribbon.innerHTML = `
      <div class="admin-auto-status-title">${status.title}</div>
      <div class="admin-auto-status-desc">${status.desc}</div>
    `;
  }

  async function saveRoundDirect(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const roundId = q('roundSelect')?.value;
    const matchTimeVal = q('roundMatchTime')?.value || '';
    const deadlineVal = q('roundDeadline')?.value || '';
    const matchMs = parseMs(matchTimeVal);
    const deadlineMs = parseMs(deadlineVal);

    if (!matchTimeVal || !deadlineVal) {
      toast('Preencha data do jogo e fecho das apostas.');
      return false;
    }

    if (Number.isFinite(matchMs) && Number.isFinite(deadlineMs) && deadlineMs >= matchMs) {
      toast('⚠️ O fecho das apostas deve ser antes do início do jogo.');
      return false;
    }

    try {
      if (!window.firebase?.database) {
        toast('Firebase não está disponível.');
        return false;
      }

      const dbRef = firebase.database().ref(baseStatePath());
      const snapshot = await dbRef.once('value');
      const remoteState = snapshot.val() || {};
      const rounds = Array.isArray(remoteState.rounds) ? remoteState.rounds : [];
      let index = rounds.findIndex(round => round.id === roundId);

      if (index === -1) {
        index = rounds.length;
        rounds.push({
          id: roundId || (crypto.randomUUID ? crypto.randomUUID() : 'round-' + Date.now()),
          createdAt: new Date().toISOString()
        });
      }

      const existing = rounds[index] || {};
      const automation = automationSettings();
      const formManualState = q('roundManualState')?.value || automation.newRoundDefaultMode || 'auto';
      const times = computeTimes(matchTimeVal, automation);

      const updatedRound = {
        ...existing,
        title: q('roundTitle')?.value?.trim() || existing.title || 'Rodada',
        opponent: q('roundOpponentName')?.value?.trim() || existing.opponent || '',
        competition: q('roundCompetition')?.value?.trim() || existing.competition || '',
        matchTime: matchTimeVal,
        autoOpenAt: times.autoOpenAt || existing.autoOpenAt || '',
        deadline: formManualState === 'auto' ? (times.deadline || deadlineVal) : deadlineVal,
        manualState: formManualState,
        resultCruzeiro: numberOrNull(q('resultCruzeiro')?.value),
        resultOpponent: numberOrNull(q('resultOpponent')?.value),
        updatedAt: new Date().toISOString()
      };

      const titleRoundNumber = String(updatedRound.title || '').match(/rodada\s*(\d+)/i);

      if (!Number.isFinite(Number(updatedRound.roundNumber)) && titleRoundNumber) {
        updatedRound.roundNumber = Number(titleRoundNumber[1]);
      }

      rounds[index] = updatedRound;

      await dbRef.child('rounds').set(rounds);

      try {
        const localRound = typeof getRound === 'function' ? getRound(updatedRound.id) : null;
        if (localRound) Object.assign(localRound, updatedRound);
      } catch {}

      toast('Rodada salva com sucesso.');
      renderRibbon();

      setTimeout(() => {
        try {
          if (typeof renderAll === 'function') renderAll('admin');
        } catch {}
      }, 100);

      return true;
    } catch (err) {
      console.error('[Bolão] Erro ao salvar rodada:', err);
      ensureAdminErrorBox('O Firebase bloqueou ou falhou ao salvar a rodada.', err);
      toast('Erro ao salvar no Firebase. Veja o UID no painel.');
      return false;
    }
  }

  function installAdminSaveAndRibbon() {
    const form = q('roundForm');

    if (form && !form.dataset.automationHotfixSave) {
      form.dataset.automationHotfixSave = '1';
      form.addEventListener('submit', saveRoundDirect, true);
    }

    ['roundSelect', 'roundManualState', 'roundMatchTime', 'roundDeadline', 'resultCruzeiro', 'resultOpponent', 'roundOpponentName'].forEach(id => {
      const node = q(id);
      if (!node || node.dataset.automationHotfixRibbon) return;

      node.dataset.automationHotfixRibbon = '1';
      node.addEventListener('change', () => setTimeout(renderRibbon, 0));
      node.addEventListener('input', () => setTimeout(renderRibbon, 0));
    });

    renderRibbon();
  }

  async function loadPrivatePhonesDirect() {
    try {
      if (!window.firebase?.database) return {};
      const snap = await firebase.database().ref('bolao-cruzeiro-debates/private/phones').once('value');
      window.__bolaoPrivatePhones = snap.val() || {};
      return window.__bolaoPrivatePhones;
    } catch (err) {
      console.warn('[Bolão] Não foi possível carregar private/phones:', err);
      return {};
    }
  }

  function patchPhoneNumbersInDom() {
    const phones = window.__bolaoPrivatePhones || {};
    const names = Object.keys(phones);

    if (!names.length) return;

    document.querySelectorAll('.missing-check-item').forEach(item => {
      const nameText = item.querySelector('.missing-check-name')?.innerText || item.innerText || '';
      const matchedName = names.find(name => nameText.toLowerCase().includes(name.toLowerCase()));
      if (!matchedName) return;

      const entry = phones[matchedName];
      const phone = typeof entry === 'string' ? entry : entry?.phone;
      if (!phone) return;

      const noPhone = item.querySelector('.missing-check-nophone');
      if (noPhone) {
        noPhone.className = 'missing-check-phone';
        noPhone.textContent = phone;
      }
    });
  }

  function installPrivatePhoneDisplayFix() {
    loadPrivatePhonesDirect().then(() => {
      patchPhoneNumbersInDom();
      setTimeout(patchPhoneNumbersInDom, 600);
      setTimeout(patchPhoneNumbersInDom, 1500);
    });
  }

  function getFieldBool(id) {
    return !!q(id)?.checked;
  }

  function getFieldNumber(id, fallback) {
    const n = Number(q(id)?.value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function unitOptions(selected) {
    return ['minutes', 'hours', 'days'].map(unit => {
      const label = unit === 'minutes' ? 'minutos' : unit === 'hours' ? 'horas' : 'dias';
      return `<option value="${unit}" ${selected === unit ? 'selected' : ''}>${label}</option>`;
    }).join('');
  }

  function automationSummaryHTML(settings) {
    if (!settings.enabled) {
      return 'A automação está desligada. As rodadas dependerão do controlo manual dos admins.';
    }

    const openTxt = settings.openBetsEnabled
      ? `As apostas abrem ${settings.openBeforeValue} ${settings.openBeforeUnit === 'hours' ? 'hora(s)' : settings.openBeforeUnit === 'days' ? 'dia(s)' : 'minuto(s)'} antes do jogo.`
      : 'A abertura automática das apostas está desligada.';

    const closeTxt = settings.closeBetsEnabled
      ? `As apostas fecham ${settings.closeBeforeValue} ${settings.closeBeforeUnit === 'hours' ? 'hora(s)' : settings.closeBeforeUnit === 'days' ? 'dia(s)' : 'minuto(s)'} antes do jogo.`
      : 'O fecho automático das apostas está desligado.';

    const resultTxt = settings.autoApplyResults
      ? 'Resultados são aplicados automaticamente quando a API confirmar jogo finalizado.'
      : 'Resultados precisam ser aplicados manualmente pelos admins.';

    const importTxt = settings.autoCreateRounds
      ? `Novas rodadas são criadas automaticamente em modo "${settings.newRoundDefaultMode}".`
      : 'Novas rodadas não serão criadas automaticamente.';

    return [openTxt, closeTxt, resultTxt, importTxt].join('<br>');
  }

  function settingsPaneHTML() {
    const settings = automationSettings();

    return `
      <section class="panel">
        <span class="mini-label">Configurações</span>
        <h3 style="margin:4px 0 8px;">Configurações das Rodadas Automáticas</h3>
        <p class="muted" style="margin-top:0;margin-bottom:18px;">Defina quando as apostas abrem, quando fecham e como a API deve criar rodadas e aplicar resultados.</p>

        <form id="automationSettingsForm" class="automation-settings-grid">
          <div class="automation-settings-card">
            <div class="automation-card-title">
              <strong>Automação geral</strong>
              <span>Controla todo o comportamento automático</span>
            </div>
            <div class="automation-toggle-row">
              <div class="automation-toggle-text">
                <strong>Ativar automação das rodadas</strong>
                <span>Quando desligado, as rodadas dependem do controlo manual.</span>
              </div>
              <input type="checkbox" id="autoEnabled" ${settings.enabled ? 'checked' : ''}>
            </div>
          </div>

          <div class="automation-settings-card">
            <div class="automation-card-title">
              <strong>Janela de apostas</strong>
              <span>Abertura e fecho calculados a partir do horário do jogo</span>
            </div>

            <div class="automation-toggle-row">
              <div class="automation-toggle-text">
                <strong>Abrir apostas automaticamente</strong>
                <span>Exemplo: 24 horas antes do jogo.</span>
              </div>
              <input type="checkbox" id="openBetsEnabled" ${settings.openBetsEnabled ? 'checked' : ''}>
            </div>

            <div class="automation-row">
              <label class="automation-field">
                Abrir apostas
                <input type="number" id="openBeforeValue" min="0" step="1" value="${settings.openBeforeValue}">
              </label>
              <label class="automation-field">
                Unidade
                <select id="openBeforeUnit">${unitOptions(settings.openBeforeUnit)}</select>
              </label>
              <span class="automation-hint">antes do jogo</span>
            </div>

            <div class="automation-toggle-row" style="margin-top:12px;">
              <div class="automation-toggle-text">
                <strong>Fechar apostas automaticamente</strong>
                <span>Exemplo: 5 minutos antes do jogo.</span>
              </div>
              <input type="checkbox" id="closeBetsEnabled" ${settings.closeBetsEnabled ? 'checked' : ''}>
            </div>

            <div class="automation-row">
              <label class="automation-field">
                Fechar apostas
                <input type="number" id="closeBeforeValue" min="0" step="1" value="${settings.closeBeforeValue}">
              </label>
              <label class="automation-field">
                Unidade
                <select id="closeBeforeUnit">${unitOptions(settings.closeBeforeUnit)}</select>
              </label>
              <span class="automation-hint">antes do jogo</span>
            </div>
          </div>

          <div class="automation-settings-card">
            <div class="automation-card-title">
              <strong>Resultados e importação</strong>
              <span>Como a API alimenta o bolão</span>
            </div>

            <div class="automation-toggle-row">
              <div class="automation-toggle-text">
                <strong>Aplicar resultado automaticamente</strong>
                <span>Usa o placar final quando a API indicar jogo finalizado.</span>
              </div>
              <input type="checkbox" id="autoApplyResults" ${settings.autoApplyResults ? 'checked' : ''}>
            </div>

            <div class="automation-toggle-row">
              <div class="automation-toggle-text">
                <strong>Criar rodadas automaticamente</strong>
                <span>Próximos jogos da API viram novas rodadas.</span>
              </div>
              <input type="checkbox" id="autoCreateRounds" ${settings.autoCreateRounds ? 'checked' : ''}>
            </div>

            <label class="automation-field" style="margin-top:14px;">
              Estado padrão das novas rodadas
              <select id="newRoundDefaultMode">
                <option value="auto" ${settings.newRoundDefaultMode === 'auto' ? 'selected' : ''}>Automático</option>
                <option value="upcoming" ${settings.newRoundDefaultMode === 'upcoming' ? 'selected' : ''}>Em espera</option>
                <option value="open" ${settings.newRoundDefaultMode === 'open' ? 'selected' : ''}>Apostas abertas</option>
                <option value="closed" ${settings.newRoundDefaultMode === 'closed' ? 'selected' : ''}>Apostas encerradas</option>
              </select>
            </label>
          </div>

          <div class="automation-settings-card">
            <div class="automation-card-title">
              <strong>Controlo manual</strong>
              <span>Permite exceções rodada a rodada</span>
            </div>
            <div class="automation-toggle-row">
              <div class="automation-toggle-text">
                <strong>Permitir override manual</strong>
                <span>Admins podem forçar “Apostas abertas”, “Encerradas” ou “Finalizada”.</span>
              </div>
              <input type="checkbox" id="allowManualOverride" ${settings.allowManualOverride !== false ? 'checked' : ''}>
            </div>
          </div>

          <div class="automation-summary" id="automationSettingsSummary">
            ${automationSummaryHTML(settings)}
          </div>

          <div class="automation-actions">
            <button type="submit" class="ios-btn ios-btn-blue">Salvar configurações</button>
            <button type="button" id="automationResetBtn" class="ios-btn ios-btn-gray">Restaurar padrão</button>
            <button type="button" id="automationApplyRoundsBtn" class="ios-btn ios-btn-green">Aplicar nas rodadas automáticas</button>
          </div>
        </form>
      </section>
    `;
  }

  function readAutomationForm() {
    return {
      enabled: getFieldBool('autoEnabled'),
      openBetsEnabled: getFieldBool('openBetsEnabled'),
      openBeforeValue: getFieldNumber('openBeforeValue', DEFAULT_AUTOMATION.openBeforeValue),
      openBeforeUnit: q('openBeforeUnit')?.value || 'hours',
      closeBetsEnabled: getFieldBool('closeBetsEnabled'),
      closeBeforeValue: getFieldNumber('closeBeforeValue', DEFAULT_AUTOMATION.closeBeforeValue),
      closeBeforeUnit: q('closeBeforeUnit')?.value || 'minutes',
      autoApplyResults: getFieldBool('autoApplyResults'),
      autoCreateRounds: getFieldBool('autoCreateRounds'),
      newRoundDefaultMode: q('newRoundDefaultMode')?.value || 'auto',
      allowManualOverride: getFieldBool('allowManualOverride'),
      updatedAt: new Date().toISOString()
    };
  }

  async function saveAutomationSettings(settings) {
    const payload = { ...DEFAULT_AUTOMATION, ...settings, updatedAt: new Date().toISOString() };
    ensureSettingsInLocalState(payload);

    if (window.firebase?.database) {
      await firebase.database().ref(baseStatePath() + '/settings/automation').set(payload);
    }

    try {
      if (typeof persistLocalState === 'function') persistLocalState();
    } catch {}

    return payload;
  }

  async function applyAutomationToRounds(showFinalToast = true) {
    const s = appState();
    if (!s || !Array.isArray(s.rounds)) {
      if (showFinalToast) toast('Estado local ainda não está carregado.');
      return;
    }

    const automation = automationSettings();
    let changed = 0;

    s.rounds.forEach(round => {
      if (!round || !round.matchTime) return;
      if (round.manualState && round.manualState !== 'auto') return;

      const times = computeTimes(round.matchTime, automation);
      if (times.autoOpenAt) round.autoOpenAt = times.autoOpenAt;
      if (times.deadline) round.deadline = times.deadline;
      round.manualState = 'auto';
      round.updatedAt = new Date().toISOString();
      changed++;
    });

    if (window.firebase?.database) {
      await firebase.database().ref(baseStatePath() + '/rounds').set(s.rounds);
    }

    try {
      if (typeof persistLocalState === 'function') persistLocalState();
      if (typeof renderAll === 'function') renderAll('admin');
    } catch {}

    if (showFinalToast) toast(`${changed} rodada(s) automática(s) atualizada(s).`);
  }

  function refreshAutomationSummary() {
    const summary = q('automationSettingsSummary');
    if (!summary) return;
    summary.innerHTML = automationSummaryHTML({ ...DEFAULT_AUTOMATION, ...readAutomationForm() });
  }

  function installAutomationSettingsPanel() {
    const adminContent = q('adminContent') || q('view-admin');
    if (!adminContent) return;

    const tabBar = adminContent.querySelector('.tab-bar');
    if (!tabBar) return;

    if (!q('tab-admin-settings-button')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'tab-admin-settings-button';
      btn.className = 'tab-btn';
      btn.dataset.tab = 'tab-admin-settings';
      btn.textContent = '⚙️ Configurações';
      tabBar.appendChild(btn);
    }

    if (!q('tab-admin-settings')) {
      const pane = document.createElement('div');
      pane.id = 'tab-admin-settings';
      pane.className = 'tab-pane hidden';
      pane.innerHTML = settingsPaneHTML();

      const container = tabBar.parentElement || adminContent;
      container.appendChild(pane);
    }

    const pane = q('tab-admin-settings');
    if (pane && !pane.dataset.automationBound) {
      pane.dataset.automationBound = '1';

      pane.addEventListener('input', refreshAutomationSummary);
      pane.addEventListener('change', refreshAutomationSummary);

      q('automationSettingsForm')?.addEventListener('submit', async event => {
        event.preventDefault();

        try {
          const saved = await saveAutomationSettings(readAutomationForm());
          await applyAutomationToRounds(false);
          toast('Configurações salvas e aplicadas às rodadas automáticas.');
          q('automationSettingsSummary').innerHTML = automationSummaryHTML(saved);
          overrideEffectiveRoundState();
          renderRibbon();
          try {
            if (typeof renderAll === 'function') renderAll('admin');
          } catch {}
        } catch (err) {
          console.error('[Bolão] Erro ao salvar configurações:', err);
          ensureAdminErrorBox('O Firebase bloqueou ou falhou ao salvar as configurações.', err);
          toast('Erro ao salvar configurações.');
        }
      });

      q('automationResetBtn')?.addEventListener('click', async () => {
        try {
          const saved = await saveAutomationSettings(DEFAULT_AUTOMATION);
          pane.innerHTML = settingsPaneHTML();
          delete pane.dataset.automationBound;
          installAutomationSettingsPanel();
          toast('Configurações restauradas.');
          q('automationSettingsSummary').innerHTML = automationSummaryHTML(saved);
        } catch (err) {
          console.error(err);
          toast('Erro ao restaurar padrão.');
        }
      });

      q('automationApplyRoundsBtn')?.addEventListener('click', async () => {
        if (!confirm('Aplicar abertura e fecho automáticos às rodadas que estão em modo Automático?')) return;

        try {
          await applyAutomationToRounds();
        } catch (err) {
          console.error(err);
          ensureAdminErrorBox('O Firebase bloqueou ou falhou ao atualizar as rodadas.', err);
          toast('Erro ao aplicar nas rodadas.');
        }
      });
    }
  }

  function overrideImportUpcomingMatch() {
    const replacement = function importUpcomingMatchWithSettings(match) {
      const automation = automationSettings();
      const localMatchTime = typeof matchToLocalInput === 'function'
        ? matchToLocalInput(match)
        : '';

      const times = computeTimes(localMatchTime, automation);
      const number = nextRoundNumber();

      const round = {
        id: crypto.randomUUID(),
        roundNumber: number,
        title: `Rodada ${number}`,
        opponent: typeof getOpponentFromMatch === 'function' ? getOpponentFromMatch(match) : 'Adversário',
        competition: match.strLeague || 'Competição',
        matchTime: localMatchTime,
        autoOpenAt: times.autoOpenAt,
        deadline: times.deadline,
        resultCruzeiro: null,
        resultOpponent: null,
        manualState: automation.newRoundDefaultMode || 'auto',
        externalId: String(match.idEvent || ''),
        source: 'manual-import',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      try {
        state.rounds.unshift(round);
        if (typeof saveState === 'function') saveState('admin');
        if (typeof renderAll === 'function') renderAll('admin');

        const roundSelect = q('roundSelect');
        if (roundSelect) roundSelect.value = round.id;

        if (typeof populateRoundForm === 'function') populateRoundForm(round.id);

        toast(`Jogo importado: Cruzeiro x ${round.opponent}.`);
      } catch (err) {
        console.error('[Bolão] Erro ao importar jogo:', err);
        toast('Erro ao importar jogo.');
      }
    };

    try {
      importUpcomingMatch = replacement;
    } catch {
      window.importUpcomingMatch = replacement;
    }
  }

  function installHotfixes() {
    overrideEffectiveRoundState();
    overrideImportUpcomingMatch();
    installAdminSaveAndRibbon();
    installPrivatePhoneDisplayFix();
    installAutomationSettingsPanel();
  }

  loadScript(STABLE_APP_URL)
    .then(() => {
      [300, 900, 1800, 3000].forEach(delay => setTimeout(installHotfixes, delay));
      setInterval(installHotfixes, 5000);
    })
    .catch(err => {
      console.error(err);
      document.body.innerHTML = `
        <div style="max-width:680px;margin:48px auto;padding:24px;font-family:system-ui,sans-serif;">
          <h1>Erro ao carregar o Bolão</h1>
          <p>Não foi possível carregar a versão estável do aplicativo.</p>
          <pre style="white-space:pre-wrap;background:#111;color:#eee;padding:16px;border-radius:12px;">${String(err.message || err)}</pre>
        </div>
      `;
    });
})();
