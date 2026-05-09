/*
  Bolão do Cruzeiro Debates — app.js estabilizado
  Base estável: commit 4a80abf007ae7939dae96c73266be915353079c1
  Hotfixes incluídos:
  - salvamento direto e diagnosticável da rodada admin;
  - ribbon de status automático no painel admin;
  - reforço visual para telefones privados carregados do Firebase;
  - sem patches empilhados no app principal.
*/

(function loadStableBolaoApp() {
  const STABLE_APP_URL = 'https://cdn.jsdelivr.net/gh/paginasdocruzeiro/bolaodebates@4a80abf007ae7939dae96c73266be915353079c1/app.js';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src + '?v=stable-hotfix-20260509-01';
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Não foi possível carregar a versão estável do app.js.'));
      document.head.appendChild(script);
    });
  }

  function toast(message) {
    try {
      if (typeof window.showToast === 'function') {
        window.showToast(message);
        return;
      }
    } catch {}
    console.log(message);
  }

  function q(id) {
    return document.getElementById(id);
  }

  function currentFirebaseUid() {
    try {
      return firebase.auth().currentUser?.uid || null;
    } catch {
      return null;
    }
  }

  function baseStatePath() {
    return window.BOLAO_FIREBASE_PATH || 'bolao-cruzeiro-debates/state';
  }

  function parseMs(value) {
    if (!value) return NaN;

    try {
      if (typeof window.parseAppDateTime === 'function') {
        const parsed = window.parseAppDateTime(value);
        return Number.isFinite(parsed) ? parsed : NaN;
      }
    } catch {}

    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }

  function formatDate(value) {
    if (!value) return '—';

    try {
      if (typeof window.formatDateTime === 'function') return window.formatDateTime(value);
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

  function computeStatusFromForm() {
    const roundId = q('roundSelect')?.value || '';
    let round = null;

    try {
      if (typeof window.getRound === 'function') round = window.getRound(roundId);
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

    const now = Date.now();
    const matchMs = parseMs(draft.matchTime);
    const deadlineMs = draft.deadline ? parseMs(draft.deadline) : matchMs - 5 * 60 * 1000;
    const openMs = draft.autoOpenAt ? parseMs(draft.autoOpenAt) : matchMs - 12 * 60 * 60 * 1000;

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

    if (draft.manualState && draft.manualState !== 'auto') {
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

    if (!Number.isFinite(matchMs)) {
      return {
        cls: 'neutral',
        title: 'Data do jogo ausente',
        desc: 'Sem data/hora válida, a automação não consegue calcular abertura e fecho.'
      };
    }

    if (now < openMs) {
      return {
        cls: 'waiting',
        title: 'Apostas abrem em ' + formatDuration(openMs - now),
        desc: `Abertura automática 12h antes do jogo. Fecho: ${formatDate(draft.deadline)}.`
      };
    }

    if (now >= openMs && now < deadlineMs) {
      return {
        cls: 'open',
        title: 'Apostas abertas',
        desc: 'Fecham em ' + formatDuration(deadlineMs - now) + ', às ' + formatDate(draft.deadline) + '.'
      };
    }

    return {
      cls: 'closed',
      title: 'Apostas encerradas',
      desc: 'Aguardando resultado oficial da API ou lançamento manual pelo admin.'
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
    `;
    document.head.appendChild(style);
  }

  function ensureRibbon() {
    const manualSelect = q('roundManualState');
    if (!manualSelect) return null;

    let ribbon = q('adminRoundAutoStatusRibbon');
    if (ribbon) return ribbon;

    ribbon = document.createElement('div');
    ribbon.id = 'adminRoundAutoStatusRibbon';
    ribbon.className = 'admin-auto-status-ribbon neutral';

    manualSelect.closest('label')?.insertAdjacentElement('afterend', ribbon);
    return ribbon;
  }

  function renderRibbon() {
    installRibbonStyle();

    const ribbon = ensureRibbon();
    if (!ribbon) return;

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
      const updatedRound = {
        ...existing,
        title: q('roundTitle')?.value?.trim() || existing.title || 'Rodada',
        opponent: q('roundOpponentName')?.value?.trim() || existing.opponent || '',
        competition: q('roundCompetition')?.value?.trim() || existing.competition || '',
        matchTime: matchTimeVal,
        deadline: deadlineVal,
        manualState: q('roundManualState')?.value || 'auto',
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
        const localRound = typeof window.getRound === 'function' ? window.getRound(updatedRound.id) : null;
        if (localRound) Object.assign(localRound, updatedRound);
      } catch {}

      toast('Rodada salva com sucesso.');
      renderRibbon();

      setTimeout(() => {
        try {
          if (typeof window.renderAll === 'function') window.renderAll('admin');
        } catch {}
      }, 100);

      return true;
    } catch (err) {
      console.error('[Bolão] Erro ao salvar rodada diretamente:', err);
      ensureAdminErrorBox('O Firebase bloqueou ou falhou ao salvar a rodada.', err);
      toast('Erro ao salvar no Firebase. Veja o UID no painel.');
      return false;
    }
  }

  function installAdminSaveAndRibbon() {
    const form = q('roundForm');

    if (form && !form.dataset.hotfixSave) {
      form.dataset.hotfixSave = '1';
      form.addEventListener('submit', saveRoundDirect, true);
    }

    ['roundSelect', 'roundManualState', 'roundMatchTime', 'roundDeadline', 'resultCruzeiro', 'resultOpponent', 'roundOpponentName'].forEach(id => {
      const node = q(id);
      if (!node || node.dataset.hotfixRibbon) return;

      node.dataset.hotfixRibbon = '1';
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

  function installHotfixes() {
    installAdminSaveAndRibbon();
    installPrivatePhoneDisplayFix();
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
