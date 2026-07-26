/*
 * Bolão Cruzeiro Debates — correção de persistência e transição de rodadas
 * Versão: 2026-07-26.1
 *
 * Este arquivo é carregado por firebase-config.js após o carregamento da página.
 */
(() => {
  'use strict';

  const HOTFIX_VERSION = '2026-07-26.1';

  function hasResult(round) {
    return round &&
      round.resultCruzeiro !== null && round.resultCruzeiro !== undefined &&
      round.resultOpponent !== null && round.resultOpponent !== undefined;
  }

  function cloneObject(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function reportSaveError(err) {
    console.error('[Hotfix rodadas] Falha ao salvar no Firebase:', err);
    const detail = err?.code || err?.message || String(err || 'erro desconhecido');
    if (typeof showToast === 'function') {
      showToast(`Não foi possível salvar: ${detail}`);
    }
  }

  function installHotfix() {
    if (window.__BOLAO_ROUND_HOTFIX_INSTALLED__) return;

    const required = [
      'state', 'saveState', 'effectiveRoundState', 'getCurrentRound',
      'persistLocalState', 'renderAll', 'showToast'
    ];

    const missing = required.filter(name => {
      try { return typeof eval(name) === 'undefined'; } catch { return true; }
    });

    if (missing.length) {
      console.warn('[Hotfix rodadas] Aplicação ainda não pronta:', missing.join(', '));
      setTimeout(installHotfix, 250);
      return;
    }

    window.__BOLAO_ROUND_HOTFIX_INSTALLED__ = HOTFIX_VERSION;

    // Resultado deve prevalecer sobre estados manuais antigos como “closed”.
    // “finalized” continua sendo o estado definitivo.
    effectiveRoundState = function effectiveRoundStateHotfix(round) {
      if (!round) return 'none';

      if (hasResult(round)) {
        return round.manualState === 'finalized' ? 'finalized' : 'result';
      }

      const settings = typeof getAutomationSettings === 'function'
        ? getAutomationSettings()
        : {
            enabled: true,
            openBetsEnabled: true,
            closeBetsEnabled: true,
            openBeforeValue: 12,
            openBeforeUnit: 'hours',
            closeBeforeValue: 5,
            closeBeforeUnit: 'minutes',
            allowManualOverride: true
          };

      if (settings.allowManualOverride !== false && round.manualState && round.manualState !== 'auto') {
        return round.manualState;
      }

      const matchMs = parseAppDateTime(round.matchTime);
      if (!matchMs || Number.isNaN(matchMs)) return 'none';
      if (!settings.enabled) return 'upcoming';

      const duration = typeof automationUnitMs === 'function'
        ? automationUnitMs
        : ((value, unit) => {
            const n = Number(value) || 0;
            if (unit === 'days') return n * 86400000;
            if (unit === 'hours') return n * 3600000;
            return n * 60000;
          });

      const nowMs = Date.now();
      const openMs = round.autoOpenAt
        ? parseAppDateTime(round.autoOpenAt)
        : matchMs - duration(settings.openBeforeValue, settings.openBeforeUnit);
      const deadlineMs = round.deadline
        ? parseAppDateTime(round.deadline)
        : matchMs - duration(settings.closeBeforeValue, settings.closeBeforeUnit);

      if (settings.closeBetsEnabled && nowMs >= deadlineMs) return 'closed';
      if (!settings.openBetsEnabled || nowMs < openMs) return 'upcoming';
      return 'open';
    };

    // Uma rodada antiga encerrada ou com resultado não pode bloquear a próxima.
    getCurrentRound = function getCurrentRoundHotfix() {
      const rounds = Array.isArray(state?.rounds) ? [...state.rounds] : [];
      const sorted = rounds.sort((a, b) => parseAppDateTime(a.matchTime) - parseAppDateTime(b.matchTime));

      const open = sorted.find(round => effectiveRoundState(round) === 'open');
      if (open) return open;

      const upcoming = sorted.find(round => effectiveRoundState(round) === 'upcoming');
      if (upcoming) return upcoming;

      const pendingResult = [...sorted]
        .reverse()
        .find(round => effectiveRoundState(round) === 'closed' && !hasResult(round));
      if (pendingResult) return pendingResult;

      const latestCompleted = [...sorted]
        .reverse()
        .find(round => ['result', 'finalized', 'closed'].includes(effectiveRoundState(round)));

      return latestCompleted || sorted[sorted.length - 1] || null;
    };

    // O salvamento administrativo não deve incluir settings no mesmo update.
    // Se as regras do Firebase bloquearem settings, toda a gravação da rodada falha.
    saveState = function saveStateHotfix(scope = 'all') {
      applyAdminFlags();
      if (typeof ensureStateSettings === 'function') ensureStateSettings();

      if (state?.users && typeof getPublicUsers === 'function') {
        state.users = getPublicUsers();
      }

      persistLocalState();

      if (!firebaseDbRef) return Promise.resolve({ mode: 'local' });
      if (scope === 'bets') return Promise.resolve({ mode: 'bets-individual' });

      let writePromise;

      if (scope === 'users') {
        writePromise = firebaseDbRef.child('users').set(getPublicUsers());
      } else if (scope === 'admin') {
        writePromise = firebaseDbRef.update({
          rounds: state.rounds,
          lastRoundHighlight: state.lastRoundHighlight,
          initialRankingSnapshot: state.initialRankingSnapshot
        });
      } else {
        writePromise = firebaseDbRef.update({
          users: typeof getPublicUsers === 'function' ? getPublicUsers() : state.users,
          rounds: state.rounds,
          lastRoundHighlight: state.lastRoundHighlight,
          initialRankingSnapshot: state.initialRankingSnapshot
        });
      }

      return writePromise.catch(err => {
        reportSaveError(err);
        throw err;
      });
    };

    // Substitui o comportamento dos botões rápidos para só anunciar sucesso
    // após a confirmação real do Firebase.
    quickState = async function quickStateHotfix(stateName) {
      const round = getRound(el('roundSelect')?.value);
      if (!round) return;

      if (stateName === 'finalized' && !hasResult(round)) {
        showToast('Preencha e salve o resultado antes de finalizar a rodada.');
        return;
      }

      const previous = cloneObject(round);
      round.manualState = stateName;
      round.updatedAt = new Date().toISOString();
      if (stateName === 'finalized') round.finalizedAt = new Date().toISOString();
      updateRoundHighlight(round);

      try {
        await saveState('admin');
        renderAll(currentRoute);
        showToast(`Rodada definida como ${roundStateLabel(round)}.`);
      } catch (err) {
        Object.keys(round).forEach(key => delete round[key]);
        Object.assign(round, previous);
        persistLocalState();
        renderAll(currentRoute);
      }
    };

    // Intercepta o submit antes do listener antigo, que mostrava sucesso sem await.
    document.addEventListener('submit', async event => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || form.id !== 'roundForm') return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const round = getRound(el('roundSelect')?.value);
      if (!round) {
        showToast('Rodada não encontrada.');
        return;
      }

      const matchTimeVal = el('roundMatchTime')?.value;
      const deadlineVal = el('roundDeadline')?.value;
      const manualStateVal = el('roundManualState')?.value || 'auto';
      const resultCruzeiroVal = el('resultCruzeiro')?.value ?? '';
      const resultOpponentVal = el('resultOpponent')?.value ?? '';

      if (!matchTimeVal || !deadlineVal) {
        showToast('Preencha data do jogo e fecho das apostas.');
        return;
      }

      const matchMs = parseAppDateTime(matchTimeVal);
      const deadlineMs = parseAppDateTime(deadlineVal);

      if (!Number.isFinite(matchMs) || !Number.isFinite(deadlineMs)) {
        showToast('Data ou horário inválido.');
        return;
      }

      if (deadlineMs >= matchMs) {
        showToast('O fecho das apostas deve ser antes do início do jogo.');
        return;
      }

      const hasCruzeiroScore = resultCruzeiroVal !== '';
      const hasOpponentScore = resultOpponentVal !== '';

      if (hasCruzeiroScore !== hasOpponentScore) {
        showToast('Preencha os dois lados do resultado.');
        return;
      }

      if (manualStateVal === 'finalized' && !hasCruzeiroScore) {
        showToast('Preencha o resultado antes de finalizar a rodada.');
        return;
      }

      const previous = cloneObject(round);

      round.title = el('roundTitle')?.value.trim() || round.title;
      round.opponent = el('roundOpponentName')?.value.trim() || round.opponent;
      round.competition = el('roundCompetition')?.value.trim() || round.competition;
      round.matchTime = matchTimeVal;
      round.deadline = deadlineVal;
      round.manualState = manualStateVal;
      round.resultCruzeiro = hasCruzeiroScore ? Number(resultCruzeiroVal) : null;
      round.resultOpponent = hasOpponentScore ? Number(resultOpponentVal) : null;
      round.updatedAt = new Date().toISOString();

      if (hasCruzeiroScore) {
        round.resultSource = 'manual';
        round.resultUpdatedAt = new Date().toISOString();
      } else {
        delete round.resultSource;
        delete round.resultUpdatedAt;
      }

      if (manualStateVal === 'finalized') {
        round.finalizedAt = new Date().toISOString();
      } else {
        delete round.finalizedAt;
      }

      updateRoundHighlight(round);

      const submitButton = form.querySelector('[type="submit"]');
      const originalText = submitButton?.textContent;
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Salvando…';
      }

      try {
        await saveState('admin');
        renderAll('admin');
        showToast('Rodada salva no Firebase.');
      } catch (err) {
        Object.keys(round).forEach(key => delete round[key]);
        Object.assign(round, previous);
        persistLocalState();
        renderAll('admin');
      } finally {
        const currentButton = document.querySelector('#roundForm [type="submit"]');
        if (currentButton) {
          currentButton.disabled = false;
          currentButton.textContent = originalText || 'Salvar rodada';
        }
      }
    }, true);

    console.info(`[Hotfix rodadas] Instalado: ${HOTFIX_VERSION}`);
  }

  installHotfix();
})();
