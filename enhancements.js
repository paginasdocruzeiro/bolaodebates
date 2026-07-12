(() => {
  'use strict';

  const ENHANCEMENT_VERSION = '2026.07.12';
  const AUDIT_KEY = 'bolaoCruzeiroDebates.audit.v1';
  const THEME_KEY = 'bolaoCruzeiroDebates.theme';
  const BACKUP_KEY = 'bolaoCruzeiroDebates.lastBackup';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const activeUsers = () => (state?.users || []).filter(user => user.active !== false);
  const finishedRounds = () => [...(state?.rounds || [])]
    .filter(round => Number.isInteger(round.resultCruzeiro) && Number.isInteger(round.resultOpponent))
    .sort((a,b) => parseAppDateTime(a.matchTime) - parseAppDateTime(b.matchTime));

  function ensureDom() {
    if (!document.querySelector('.skip-link')) {
      document.body.insertAdjacentHTML('afterbegin', '<a class="skip-link" href="#mainContent">Pular para o conteúdo</a>');
      document.querySelector('main.content')?.setAttribute('id', 'mainContent');
    }
    const toast = el('toast');
    toast?.setAttribute('role', 'status');
    toast?.setAttribute('aria-live', 'polite');
    document.documentElement.lang = 'pt-BR';

    if (!el('themeToggleBtn')) {
      const btn = document.createElement('button');
      btn.id = 'themeToggleBtn';
      btn.className = 'ios-btn ios-btn-gray theme-btn';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Alternar tema claro e escuro');
      document.querySelector('.topbar-actions')?.prepend(btn);
      btn.addEventListener('click', toggleTheme);
    }
    if (!el('profileDialog')) {
      document.body.insertAdjacentHTML('beforeend', '<dialog id="profileDialog" class="profile-dialog"><div id="profileDialogContent" class="profile-dialog-inner"></div></dialog>');
    }
  }

  function applyTheme(theme = localStorage.getItem(THEME_KEY) || 'dark') {
    document.documentElement.dataset.theme = theme;
    const btn = el('themeToggleBtn');
    if (btn) btn.textContent = theme === 'light' ? '🌙 Escuro' : '☀️ Claro';
  }
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    if (currentRoute === 'ranking') renderRanking();
  }

  function getAchievements(name) {
    const ranking = calculateRankings().find(item => item.name === name);
    if (!ranking) return [];
    const history = getUserHistory(name).filter(item => item.pointsValue !== null);
    const achievements = [];
    if (ranking.position === 1) achievements.push(['👑','Líder','Está no topo do ranking']);
    if (ranking.exact >= 3) achievements.push(['🎯','Sniper',`${ranking.exact} placares exatos`]);
    if (ranking.scoringRounds >= 4) achievements.push(['🔥','Embalado',`Pontuou em ${ranking.scoringRounds} rodadas`]);
    const streak = currentStreak(ranking.roundScores);
    if (String(streak).includes('🔥') || String(streak).includes('🎯')) achievements.push(['⚡','Em sequência',String(streak).replace(/<[^>]+>/g,'')]);
    const bets = history.filter(item => item.betLabel !== '-' && item.betLabel !== 'Sem palpite');
    if (bets.length && ranking.zeroRounds === 0) achievements.push(['🧱','Regular','Ainda não zerou quando apostou']);
    if (ranking.position === calculateRankings().length && calculateRankings().length > 1) achievements.push(['🏮','Guardião da lanterna','A reação começa na próxima rodada']);
    if (!ranking.missedRounds && ranking.roundsPlayed >= 3) achievements.push(['✅','Sempre presente','Não perdeu nenhuma rodada']);
    return achievements.slice(0, 5);
  }

  function achievementHTML(name) {
    const items = getAchievements(name);
    return items.length
      ? `<div class="achievement-list">${items.map(item => `<span class="achievement" title="${esc(item[2])}">${item[0]} ${esc(item[1])}</span>`).join('')}</div>`
      : '<p class="muted">As conquistas aparecem conforme as rodadas avançam.</p>';
  }

  function personalSummary(name) {
    const rank = calculateRankings().find(item => item.name === name);
    const rounds = finishedRounds();
    const lastRound = rounds[rounds.length - 1];
    if (!rank) return '';
    let lastLine = 'Ainda não há rodada finalizada.';
    if (lastRound) {
      const bet = getBet(lastRound.id, name);
      const result = bet ? scorePrediction(bet.cruzeiroGoals, bet.opponentGoals, lastRound.resultCruzeiro, lastRound.resultOpponent) : null;
      lastLine = bet
        ? `Na última rodada você apostou ${bet.cruzeiroGoals}x${bet.opponentGoals} e ganhou ${result.points} ponto${result.points !== 1 ? 's' : ''}.`
        : 'Você ficou sem palpite na última rodada.';
    }
    const scores = rank.roundScores.map(item => item.points);
    const best = scores.length ? Math.max(...scores) : 0;
    return `<div class="enhancement-grid">
      <div><span class="mini-label">Sua posição</span><h3>${rank.position}º lugar · ${rank.totalPoints} pts</h3><p class="muted">${esc(lastLine)}</p></div>
      <div><span class="mini-label">Seu momento</span><h3>${rank.roundScores.length ? currentStreak(rank.roundScores) : 'Primeira rodada'}</h3><p class="muted">Melhor rodada: ${best} ponto${best !== 1 ? 's' : ''} · ${rank.exact} exato${rank.exact !== 1 ? 's' : ''}</p></div>
    </div>${achievementHTML(name)}`;
  }

  function buildNotifications() {
    const user = currentUser();
    if (!user) return [];
    const round = getCurrentRound();
    const notices = [];
    if (round) {
      const status = effectiveRoundState(round);
      const bet = getBet(round.id, user.name);
      if (status === 'open' && !bet) notices.push(['⚠️', 'Você ainda não apostou nesta rodada.', 'round']);
      if (status === 'open') {
        const diff = parseAppDateTime(round.deadline) - Date.now();
        if (diff > 0 && diff <= 7200000) notices.push(['⏳', `Faltam ${Math.max(1, Math.ceil(diff / 60000))} minutos para fechar os palpites.`, 'round']);
      }
      if (bet && status === 'open') notices.push(['✅', `Palpite confirmado: Cruzeiro ${bet.cruzeiroGoals}x${bet.opponentGoals} ${round.opponent}.`, 'round']);
    }
    const last = finishedRounds().at(-1);
    if (last) {
      const bet = getBet(last.id, user.name);
      if (bet) {
        const score = scorePrediction(bet.cruzeiroGoals, bet.opponentGoals, last.resultCruzeiro, last.resultOpponent);
        notices.push(['🏁', `Último resultado: você somou ${score.points} ponto${score.points !== 1 ? 's' : ''}.`, 'history']);
      }
    }
    return notices.slice(0, 4);
  }

  function renderHomeEnhancements() {
    const host = el('homeUser');
    const user = currentUser();
    if (!host || !user) return;
    let section = el('homeEnhancements');
    if (!section) {
      section = document.createElement('section');
      section.id = 'homeEnhancements';
      section.className = 'panel enhancement-section';
      host.prepend(section);
    }
    const notices = buildNotifications();
    section.innerHTML = `<div class="enhancement-title"><div><span class="mini-label">Central pessoal</span><h3>Seu resumo</h3></div></div>
      ${notices.length ? `<div class="notice-list">${notices.map(item => `<button type="button" class="profile-button notice-item" data-enh-route="${item[2]}">${item[0]} ${esc(item[1])}</button>`).join('')}</div>` : ''}
      <div class="enhancement-section">${personalSummary(user.name)}</div>`;
  }

  function openProfile(name) {
    const rank = calculateRankings().find(item => item.name === name);
    const history = getUserHistory(name);
    if (!rank) return;
    const bets = history.filter(item => item.betLabel !== '-' && item.betLabel !== 'Sem palpite');
    const avgGoals = bets.length ? (bets.reduce((sum,item) => sum + Number(item.betLabel.split('x')[0]), 0) / bets.length).toFixed(1) : '—';
    const scored = rank.roundScores.filter(item => item.points > 0).length;
    const content = el('profileDialogContent');
    content.innerHTML = `<div class="dialog-head"><div><span class="mini-label">Perfil do participante</span><h2>${esc(name)}</h2></div><button class="dialog-close" data-close-dialog aria-label="Fechar">✕</button></div>
      <div class="enhancement-grid enhancement-section">
        <div><span class="mini-label">Classificação</span><h3>${rank.position}º · ${rank.totalPoints} pontos</h3></div>
        <div><span class="mini-label">Acertos</span><h3>${rank.exact} exatos · ${rank.partial} parciais</h3></div>
        <div><span class="mini-label">Aproveitamento</span><h3>${rank.roundsPlayed ? Math.round((scored / rank.roundsPlayed) * 100) : 0}%</h3></div>
        <div><span class="mini-label">Média prevista</span><h3>${avgGoals} gol(s) do Cruzeiro</h3></div>
      </div>
      <div class="enhancement-section"><h3>Conquistas</h3>${achievementHTML(name)}</div>
      <div class="enhancement-section"><h3>Últimas rodadas</h3>${responsiveTableHTML(['Rodada','Palpite','Resultado','Pontos'], history.slice(-6).reverse().map(item => [item.title,item.betLabel,item.resultLabel,item.pointsLabel]))}</div>`;
    el('profileDialog').showModal();
  }

  function renderProfileDirectory() {
    const host = el('consistencyWrap')?.closest('.panel')?.parentElement || el('tab-ranking');
    if (!host) return;
    let panel = el('profilesPanel');
    if (!panel) {
      panel = document.createElement('article');
      panel.id = 'profilesPanel';
      panel.className = 'panel enhancement-section';
      host.appendChild(panel);
    }
    panel.innerHTML = `<span class="mini-label">Participantes</span><h3>Perfis e conquistas</h3><div class="profile-directory">${calculateRankings().map(item => `<button type="button" class="profile-button profile-tile" data-profile="${esc(item.name)}"><strong>${positionDisplay(item.position)} ${esc(item.name)}</strong><br><span class="muted">${item.totalPoints} pts · ${item.exact} exatos</span>${achievementHTML(item.name)}</button>`).join('')}</div>`;
  }

  function rankingTimelineData() {
    const users = activeUsers();
    const rounds = finishedRounds();
    const totals = Object.fromEntries(users.map(user => [user.name, Number(user.basePoints || 0)]));
    const positions = Object.fromEntries(users.map(user => [user.name, []]));
    const labels = ['Início'];
    const initial = [...users].sort((a,b) => totals[b.name] - totals[a.name]);
    initial.forEach((user,index) => positions[user.name].push(index + 1));
    rounds.forEach(round => {
      users.forEach(user => {
        const bet = getBet(round.id, user.name);
        if (bet) totals[user.name] += scorePrediction(bet.cruzeiroGoals, bet.opponentGoals, round.resultCruzeiro, round.resultOpponent).points;
      });
      [...users].sort((a,b) => totals[b.name] - totals[a.name] || a.name.localeCompare(b.name)).forEach((user,index) => positions[user.name].push(index + 1));
      labels.push(round.title || `R${labels.length}`);
    });
    return { labels, users, positions };
  }

  function renderEvolutionChart() {
    const stats = el('statsGrid');
    if (!stats) return;
    let section = el('rankingEvolutionPanel');
    if (!section) {
      section = document.createElement('div');
      section.id = 'rankingEvolutionPanel';
      section.className = 'stats-section-full';
      stats.appendChild(section);
    }
    section.innerHTML = '<div class="stats-kicker">Evolução da classificação por rodada</div><div class="stats-chart-wrap chart-panel"><canvas id="chartRankingEvolution" aria-label="Evolução das posições no ranking"></canvas></div>';
    const data = rankingTimelineData();
    const ctx = el('chartRankingEvolution')?.getContext('2d');
    if (!ctx) return;
    if (typeof Chart === 'undefined') {
      drawEvolutionCanvas(ctx, data);
      return;
    }
    window._chartRankingEvolution?.destroy();
    const colors = ['#60a5fa','#34d399','#fbbf24','#f87171','#c084fc','#22d3ee','#fb923c','#a3e635','#f472b6','#818cf8','#2dd4bf'];
    window._chartRankingEvolution = new Chart(ctx, { type:'line', data:{ labels:data.labels, datasets:data.users.map((user,index) => ({ label:user.name, data:data.positions[user.name], borderColor:colors[index % colors.length], backgroundColor:colors[index % colors.length], pointRadius:3, tension:.25 })) }, options:{ responsive:true, maintainAspectRatio:false, animation:{duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:250}, scales:{ y:{ reverse:true, min:1, max:Math.max(2,data.users.length), ticks:{stepSize:1}, title:{display:true,text:'Posição'} } }, plugins:{ tooltip:{callbacks:{label:ctx => `${ctx.dataset.label}: ${ctx.parsed.y}º`}} } } });
  }

  function drawEvolutionCanvas(ctx, data) {
    const canvas = ctx.canvas;
    const width = Math.max(620, canvas.clientWidth || 900);
    const height = 320;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio;
    ctx.setTransform(ratio,0,0,ratio,0,0);
    const colors = ['#60a5fa','#34d399','#fbbf24','#f87171','#c084fc','#22d3ee','#fb923c','#a3e635','#f472b6','#818cf8','#2dd4bf'];
    const left=42, right=18, top=18, bottom=54, plotW=width-left-right, plotH=height-top-bottom;
    ctx.clearRect(0,0,width,height); ctx.font='12px system-ui'; ctx.lineWidth=1;
    ctx.strokeStyle='rgba(148,163,184,.22)'; ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--text-2') || '#94a3b8';
    for(let pos=1;pos<=data.users.length;pos++) { const y=top+((pos-1)/Math.max(1,data.users.length-1))*plotH; ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();ctx.fillText(`${pos}º`,8,y+4); }
    data.labels.forEach((label,index)=>{ const x=left+(index/Math.max(1,data.labels.length-1))*plotW; ctx.save();ctx.translate(x,height-10);ctx.rotate(-.42);ctx.fillText(String(label).slice(0,13),0,0);ctx.restore(); });
    data.users.forEach((user,userIndex)=>{ const values=data.positions[user.name];ctx.strokeStyle=colors[userIndex%colors.length];ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=2;ctx.beginPath();values.forEach((pos,index)=>{const x=left+(index/Math.max(1,data.labels.length-1))*plotW;const y=top+((pos-1)/Math.max(1,data.users.length-1))*plotH;if(index===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();const last=values.at(-1);if(last){const x=width-right;const y=top+((last-1)/Math.max(1,data.users.length-1))*plotH;ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();}});
    canvas.setAttribute('aria-label',`Evolução do ranking em ${data.labels.length-1} rodadas para ${data.users.length} participantes.`);
  }

  function ensureSimulator() {
    const host = el('tab-ranking');
    if (!host || el('rankingSimulator')) return;
    host.insertAdjacentHTML('beforeend', `<article class="panel enhancement-section" id="rankingSimulator"><span class="mini-label">Cenários</span><h3>Simulador de ranking</h3><p class="muted">Escolha um placar hipotético para a rodada atual.</p><div class="simulator-score"><label>Cruzeiro<input id="simCruzeiro" type="number" min="0" max="20" value="2"></label><span class="versus">x</span><label>Adversário<input id="simOpponent" type="number" min="0" max="20" value="1"></label></div><div id="simulatorOutput" class="enhancement-section"></div></article>`);
    ['simCruzeiro','simOpponent'].forEach(id => el(id)?.addEventListener('input', renderSimulator));
    renderSimulator();
  }

  function renderSimulator() {
    const out = el('simulatorOutput');
    if (!out) return;
    const round = getCurrentRound();
    if (!round || Number.isInteger(round.resultCruzeiro)) { out.innerHTML = '<p class="muted">O simulador fica disponível quando existe uma rodada sem resultado.</p>'; return; }
    const cg = Number(el('simCruzeiro')?.value); const og = Number(el('simOpponent')?.value);
    if (!Number.isInteger(cg) || !Number.isInteger(og) || cg < 0 || og < 0 || cg > 20 || og > 20) { out.innerHTML = '<p class="muted">Informe um placar entre 0 e 20.</p>'; return; }
    const projected = calculateRankings().map(item => {
      const bet = getBet(round.id, item.name);
      const added = bet ? scorePrediction(bet.cruzeiroGoals, bet.opponentGoals, cg, og).points : 0;
      return {...item, added, projected:item.totalPoints + added};
    }).sort((a,b) => b.projected - a.projected || b.exact - a.exact || a.name.localeCompare(b.name));
    out.innerHTML = `<p><strong>Se o jogo terminar Cruzeiro ${cg}x${og} ${esc(round.opponent)}:</strong></p>${responsiveTableHTML(['Pos.','Nome','Pontos atuais','Nesta rodada','Total'], projected.map((item,index) => [`${index+1}º`,item.name,String(item.totalPoints),`+${item.added}`,String(item.projected)]), true)}`;
  }

  function privacyRoundTable() {
    const roundId = el('roundViewSelect')?.value;
    const round = roundId ? getRound(roundId) : getCurrentRound();
    if (!round || isAdmin() || !['open','upcoming'].includes(effectiveRoundState(round))) return;
    const user = currentUser();
    const rows = activeUsers().map(player => {
      const own = player.name === user?.name;
      const bet = own ? getBet(round.id, player.name) : null;
      return [player.name, own && bet ? `${bet.cruzeiroGoals}x${bet.opponentGoals}` : own ? 'Sem palpite' : '🔒 Oculto até o encerramento', '—', '—'];
    });
    el('roundTableWrap').innerHTML = responsiveTableHTML(['Nome','Aposta','Pontos','Tipo de acerto'], rows);
    const summary = el('roundSummary');
    if (summary) Array.from(summary.querySelectorAll('p')).filter(p => p.textContent.includes('Aposta mais popular')).forEach(p => p.innerHTML = '<strong>Aposta mais popular:</strong> 🔒 Revelada após o encerramento');
  }

  function showBetConfirmation(payload) {
    const host = el('betConfirmation') || el('betForm')?.parentElement;
    if (!host) return;
    host.classList.remove('hidden');
    host.innerHTML = `<div class="bet-confirmation-card"><strong>✅ Palpite confirmado</strong><p>Cruzeiro ${payload.cruzeiroGoals}x${payload.opponentGoals} ${esc(getRound(payload.roundId)?.opponent || '')}</p><p class="muted">Pode ser alterado até ${formatDateTime(getRound(payload.roundId)?.deadline)}.</p><button type="button" class="ios-btn ios-btn-green" id="shareBetConfirmation">📲 Compartilhar confirmação</button></div>`;
    el('shareBetConfirmation')?.addEventListener('click', () => window.open(`https://wa.me/?text=${encodeURIComponent(`✅ Meu palpite no Bolão Cruzeiro Debates: Cruzeiro ${payload.cruzeiroGoals}x${payload.opponentGoals} ${getRound(payload.roundId)?.opponent || ''}`)}`, '_blank'));
  }

  function auditEntries() { try { return JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]'); } catch { return []; } }
  function recordAudit(action, details = '') {
    const entry = { id:crypto.randomUUID(), at:new Date().toISOString(), user:currentUser()?.name || 'Sistema', action, details };
    const entries = [entry, ...auditEntries()].slice(0, 150);
    localStorage.setItem(AUDIT_KEY, JSON.stringify(entries));
    if (isAdmin() && firebaseDbRef) firebaseDbRef.child('auditLog').child(entry.id).set(entry).catch(() => {});
    renderAudit();
  }

  function ensureAdminTools() {
    const tabs = el('adminTabBar'); const container = el('adminTabsContainer');
    if (!tabs || !container || el('tab-admin-tools-button')) return;
    tabs.insertAdjacentHTML('beforeend','<button class="tab-btn" id="tab-admin-tools-button" data-tab="tab-admin-tools">🧰 Ferramentas</button>');
    container.insertAdjacentHTML('beforeend', `<div id="tab-admin-tools" class="tab-pane hidden"><div class="admin-tools"><article class="panel"><span class="mini-label">Segurança operacional</span><h3>Backup e restauração</h3><p class="muted" id="lastBackupLabel"></p><div class="inline-actions"><button type="button" class="ios-btn ios-btn-blue" id="exportBackupBtn">⬇️ Exportar JSON</button><label class="ios-btn ios-btn-yellow" for="importBackupInput">⬆️ Restaurar backup</label><input class="sr-only-enhanced" id="importBackupInput" type="file" accept="application/json"></div></article><article class="panel"><span class="mini-label">Participantes</span><h3>Ativos, PIN e atividade</h3><div id="participantTools"></div></article><article class="panel"><span class="mini-label">Histórico administrativo</span><h3>Registro de alterações</h3><div id="auditLog" class="audit-list"></div></article></div></div>`);
    el('exportBackupBtn').addEventListener('click', exportBackup);
    el('importBackupInput').addEventListener('change', importBackup);
    renderAdminTools();
  }

  function renderAdminTools() {
    if (!isAdmin()) return;
    const last = localStorage.getItem(BACKUP_KEY);
    const label = el('lastBackupLabel'); if (label) label.textContent = last ? `Último backup: ${new Date(last).toLocaleString('pt-BR')}` : 'Nenhum backup exportado neste dispositivo.';
    const wrap = el('participantTools');
    if (wrap) wrap.innerHTML = responsiveTableHTML(['Estado','Nome','Último palpite','Ações'], [...state.users].sort((a,b) => a.name.localeCompare(b.name)).map(user => {
      const bets = getBetsArray().filter(bet => bet.userName === user.name).sort((a,b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
      const lastBet = bets[0] ? new Date(bets[0].updatedAt || bets[0].createdAt).toLocaleDateString('pt-BR') : 'Nunca';
      return [`<span class="status-dot ${user.active === false ? 'off':''}"></span>${user.active === false ? 'Inativo':'Ativo'}`, user.name, lastBet, `<button class="ios-btn ios-btn-gray" data-toggle-user="${esc(user.id)}">${user.active === false ? 'Ativar':'Inativar'}</button> <button class="ios-btn ios-btn-yellow" data-reset-pin="${esc(user.id)}">Redefinir PIN</button>`];
    }));
    renderAudit();
  }

  function exportBackup() {
    const payload = { format:'bolao-cruzeiro-backup', version:2, exportedAt:new Date().toISOString(), state, audit:auditEntries() };
    const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `bolao-backup-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href);
    localStorage.setItem(BACKUP_KEY,new Date().toISOString()); recordAudit('Backup exportado'); renderAdminTools();
  }
  async function importBackup(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()); const incoming = parsed.state || parsed;
      if (!incoming.users || !incoming.rounds || !confirm(`Restaurar backup de ${parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString('pt-BR') : 'data desconhecida'}? O estado atual será substituído.`)) return;
      state = normalizeState(incoming); persistLocalState();
      if (firebaseDbRef) await firebaseDbRef.set(state);
      if (Array.isArray(parsed.audit)) localStorage.setItem(AUDIT_KEY,JSON.stringify(parsed.audit));
      recordAudit('Backup restaurado', file.name); renderAll('admin'); showToast('Backup restaurado com sucesso.');
    } catch (error) { showToast('Backup inválido: ' + error.message); }
    finally { event.target.value=''; }
  }
  function renderAudit() {
    const wrap = el('auditLog'); if (!wrap) return;
    const entries = auditEntries();
    wrap.innerHTML = entries.length ? entries.map(entry => `<div class="audit-row"><span>${new Date(entry.at).toLocaleString('pt-BR')}<br><strong>${esc(entry.user)}</strong></span><span>${esc(entry.action)}${entry.details ? `<br><span class="muted">${esc(entry.details)}</span>`:''}</span></div>`).join('') : '<p class="muted">As próximas alterações administrativas aparecerão aqui.</p>';
  }

  function renderResultPreview() {
    const form = el('roundForm'); if (!form || !isAdmin()) return;
    let preview = el('resultPreview');
    if (!preview) { preview=document.createElement('div'); preview.id='resultPreview'; preview.className='result-preview'; form.appendChild(preview); }
    const round = getRound(el('roundSelect')?.value); const cg=Number(el('resultCruzeiro')?.value); const og=Number(el('resultOpponent')?.value);
    if (!round || el('resultCruzeiro')?.value==='' || el('resultOpponent')?.value==='') { preview.innerHTML='<strong>Prévia do resultado</strong><p class="muted">Preencha o placar para visualizar a pontuação antes de salvar.</p>'; return; }
    const projected = activeUsers().map(user => { const bet=getBet(round.id,user.name); const score=bet?scorePrediction(bet.cruzeiroGoals,bet.opponentGoals,cg,og):{points:0,type:'sem aposta'}; return {name:user.name,bet:bet?`${bet.cruzeiroGoals}x${bet.opponentGoals}`:'—',...score}; }).sort((a,b)=>b.points-a.points||a.name.localeCompare(b.name));
    preview.innerHTML=`<strong>Prévia: Cruzeiro ${cg}x${og} ${esc(round.opponent)}</strong>${responsiveTableHTML(['Nome','Palpite','Pontos','Tipo'],projected.map(item=>[item.name,item.bet,String(item.points),badge(item.type)]))}`;
  }

  function toggleParticipant(id) {
    const user=state.users.find(item=>item.id===id); if(!user||!isAdmin()) return;
    user.active=user.active===false; saveState('users'); recordAudit(user.active===false?'Participante inativado':'Participante ativado',user.name); renderAdminTools(); renderAll('admin');
  }
  function resetParticipantPin(id) {
    const user=state.users.find(item=>item.id===id); if(!user||!isAdmin()||!confirm(`Redefinir o PIN de ${user.name}?`)) return;
    user.pin=null; saveState('users'); recordAudit('PIN redefinido',user.name); showToast(`PIN de ${user.name} redefinido.`); renderAdminTools();
  }

  function installUpdatePrompt() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(registration => {
      registration.addEventListener('updatefound', () => {
        const worker=registration.installing; if(!worker) return;
        worker.addEventListener('statechange', () => { if(worker.state==='installed' && navigator.serviceWorker.controller) showUpdateBanner(worker); });
      });
    });
  }
  function showUpdateBanner(worker) {
    if (el('updateBanner')) return;
    document.body.insertAdjacentHTML('beforeend','<div class="update-banner" id="updateBanner" role="status"><span>Uma nova versão do bolão está disponível.</span><button class="ios-btn ios-btn-blue" id="applyUpdateBtn">Atualizar</button></div>');
    el('applyUpdateBtn').addEventListener('click',()=>{worker.postMessage({type:'SKIP_WAITING'}); location.reload();});
  }

  function wireEvents() {
    document.addEventListener('click', event => {
      const profile=event.target.closest('[data-profile]'); if(profile) openProfile(profile.dataset.profile);
      if(event.target.closest('[data-close-dialog]')) el('profileDialog')?.close();
      const route=event.target.closest('[data-enh-route]'); if(route) navigate(route.dataset.enhRoute);
      const toggle=event.target.closest('[data-toggle-user]'); if(toggle) toggleParticipant(toggle.dataset.toggleUser);
      const reset=event.target.closest('[data-reset-pin]'); if(reset) resetParticipantPin(reset.dataset.resetPin);
    });
    ['resultCruzeiro','resultOpponent','roundSelect'].forEach(id => { el(id)?.addEventListener('input',renderResultPreview); el(id)?.addEventListener('change',renderResultPreview); });
    el('roundForm')?.addEventListener('submit', event => {
      const hasResult=el('resultCruzeiro')?.value!=='' && el('resultOpponent')?.value!=='';
      if(hasResult && !confirm('Confirma o resultado e a pontuação mostrada na prévia?')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      recordAudit('Rodada salva',el('roundTitle')?.value || '');
    },true);
    el('addPlayerForm')?.addEventListener('submit',()=>recordAudit('Participante adicionado',el('newPlayerName')?.value || ''),true);
  }

  function wrapCore() {
    const originalCalculate=calculateRankings;
    calculateRankings=function enhancedCalculateRankings(){ return originalCalculate().filter(item => item.active !== false); };
    const originalLoginOptions=renderLoginOptions;
    renderLoginOptions=function enhancedLoginOptions(){ originalLoginOptions(); Array.from(el('loginName')?.options || []).forEach(option => { const user=state.users.find(item=>item.name===option.value); if(user?.active===false) option.remove(); }); };
    const originalHome=renderHome;
    renderHome=function enhancedHome(){ originalHome(); renderHomeEnhancements(); renderDesignHome(); renderGuestPreviewV2(); celebrateExactV2(); };
    const originalRanking=renderRanking;
    renderRanking=function enhancedRanking(){ originalRanking(); renderPodiumV2(); renderProfileDirectory(); ensureSimulator(); };
    const originalHistory=renderHistory;
    renderHistory=function enhancedHistory(){ originalHistory(); const selected=el('historyPlayerSelect')?.value; if(selected){ const summary=el('historySummary'); summary?.insertAdjacentHTML('beforeend',`<div class="enhancement-section"><button type="button" class="ios-btn ios-btn-blue" data-profile="${esc(selected)}">Ver perfil completo</button>${achievementHTML(selected)}</div>`); renderTimelineV2(selected); } };
    const originalStats=renderStats;
    renderStats=function enhancedStats(){ originalStats(); requestAnimationFrame(renderEvolutionChart); };
    const originalRound=renderRound;
    renderRound=function enhancedRound(){ originalRound(); privacyRoundTable(); enhanceScoreControls(); updateNavAttention(); };
    const originalAdmin=renderAdmin;
    renderAdmin=function enhancedAdmin(){ originalAdmin(); ensureAdminTools(); renderAdminTools(); renderResultPreview(); };
    const originalUpsert=upsertBet;
    upsertBet=function enhancedUpsert(payload){ const result=originalUpsert(payload); showBetConfirmation(payload); return result; };
  }


  function renderDesignHome() {
    const user = currentUser();
    const host = user ? el('homeUser') : el('homeGuest');
    const round = getCurrentRound();
    if (!host || !round) return;
    let hero = el('matchHeroV2');
    if (!hero) {
      hero = document.createElement('section');
      hero.id = 'matchHeroV2';
      hero.className = 'match-hero-v2';
      host.prepend(hero);
    }
    const bet = user ? getBet(round.id, user.name) : null;
    const status = effectiveRoundState(round);
    const canBet = user && status === 'open';
    const scoreCenter = bet
      ? `<div class="hero-score-v2" aria-label="Seu palpite: Cruzeiro ${bet.cruzeiroGoals} a ${bet.opponentGoals} ${esc(round.opponent)}"><strong>${bet.cruzeiroGoals}</strong><span>×</span><strong>${bet.opponentGoals}</strong><small>seu palpite</small></div>`
      : '<div class="hero-score-v2 hero-score-empty"><strong>–</strong><span>×</span><strong>–</strong><small>aguardando palpite</small></div>';
    hero.innerHTML = `<div class="hero-atmosphere" aria-hidden="true">✦ ✧ ✦</div>
      <div class="hero-meta-v2"><span>${esc(round.competition)}</span><strong>${formatDateTime(round.matchTime)}</strong></div>
      <div class="hero-matchup-v2">
        <div class="hero-team-v2"><img src="${getLocalCrest('cruzeiro')}" alt="Escudo do Cruzeiro"><strong>Cruzeiro</strong></div>
        ${scoreCenter}
        <div class="hero-team-v2"><img src="${getLocalCrest(round.opponent)}" alt="Escudo do ${esc(round.opponent)}"><strong>${esc(round.opponent)}</strong></div>
      </div>
      <div class="hero-actions-v2">
        <span class="hero-status-v2 ${status}">${roundStateLabel(round)}</span>
        ${canBet ? '<button type="button" class="hero-cta-v2" data-enh-route="round">Fazer ou alterar palpite</button>' : user ? `<span class="hero-deadline-v2">Fecho: ${formatDateTime(round.deadline)}</span>` : '<span class="hero-deadline-v2">Entre para participar</span>'}
      </div>`;
    host.classList.add('has-match-hero-v2');
    updateNavAttention();
  }

  function enhanceScoreControls() {
    ['betCruzeiro','betOpponent'].forEach(id => {
      const input = el(id);
      if (!input || input.closest('.score-stepper-v2')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'score-stepper-v2';
      input.parentNode.insertBefore(wrapper, input);
      const minus = document.createElement('button');
      minus.type='button'; minus.className='score-step-v2'; minus.textContent='−'; minus.setAttribute('aria-label','Diminuir placar');
      const plus = document.createElement('button');
      plus.type='button'; plus.className='score-step-v2'; plus.textContent='+'; plus.setAttribute('aria-label','Aumentar placar');
      wrapper.append(minus,input,plus);
      const change = delta => {
        const current = Number(input.value || 0);
        input.value = String(Math.max(0,Math.min(20,current+delta)));
        input.classList.remove('score-pop-v2'); void input.offsetWidth; input.classList.add('score-pop-v2');
        input.dispatchEvent(new Event('input',{bubbles:true}));
        if (navigator.vibrate) navigator.vibrate(18);
      };
      minus.addEventListener('click',()=>change(-1)); plus.addEventListener('click',()=>change(1));
    });
  }

  function renderPodiumV2() {
    const ranking = calculateRankings();
    const host = el('tab-ranking');
    if (!host || !ranking.length) return;
    let podium = el('podiumV2');
    if (!podium) {
      podium = document.createElement('section');
      podium.id = 'podiumV2';
      podium.className = 'podium-v2';
      host.prepend(podium);
    }
    const first=ranking[0], second=ranking[1], third=ranking[2];
    const card = (item,place,medal) => item ? `<button type="button" class="podium-place-v2 podium-${place}" data-profile="${esc(item.name)}"><span class="podium-medal-v2">${medal}</span><span class="avatar-v2">${esc(item.name.charAt(0))}</span><strong>${esc(item.name)}</strong><b>${item.totalPoints} pts</b><small>${item.exact} exato${item.exact!==1?'s':''}</small><span class="podium-block-v2">${place}º</span></button>` : '';
    podium.innerHTML = `<div class="podium-heading-v2"><div><span class="mini-label">Disputa pelo topo</span><h3>Pódio geral</h3></div><span class="podium-season-v2">Temporada 2026</span></div><div class="podium-stage-v2">${card(second,2,'🥈')}${card(first,1,'🥇')}${card(third,3,'🥉')}</div>`;
  }

  function renderTimelineV2(name) {
    const history = getUserHistory(name);
    const host = el('historyTableWrap')?.parentElement;
    if (!host) return;
    let timeline = el('historyTimelineV2');
    if (!timeline) {
      timeline=document.createElement('section');
      timeline.id='historyTimelineV2';
      timeline.className='timeline-v2';
      host.insertBefore(timeline,el('historyTableWrap'));
    }
    const entries=history.filter(item=>item.resultLabel!=='A definir').slice(-8).reverse();
    timeline.innerHTML = `<div class="timeline-title-v2"><span class="mini-label">Trajetória recente</span><h3>Linha do tempo</h3></div>${entries.length ? entries.map(item=>`<article class="timeline-item-v2 timeline-${esc(item.type)}"><span class="timeline-dot-v2"></span><div><strong>${esc(item.title)} · Cruzeiro x ${esc(item.opponent)}</strong><p>${esc(item.betLabel)} → ${esc(item.resultLabel)}</p></div><b>${esc(item.pointsLabel)}</b></article>`).join('') : '<div class="empty-state-v2"><span>⚽</span><strong>A bola ainda não rolou</strong><p>As rodadas finalizadas aparecerão aqui.</p></div>'}`;
  }

  function renderGuestPreviewV2() {
    if (currentUser()) return;
    const host=el('homeGuest');
    if(!host) return;
    let preview=el('guestTop3V2');
    if(!preview){ preview=document.createElement('div'); preview.id='guestTop3V2'; preview.className='guest-preview-v2'; host.appendChild(preview); }
    const top=calculateRankings().slice(0,3);
    preview.innerHTML=`<span class="mini-label">Classificação atual</span><h3>Quem está no topo</h3><div class="guest-top3-v2">${top.map((item,index)=>`<div><span>${['🥇','🥈','🥉'][index]}</span><strong>${esc(item.name)}</strong><b>${item.totalPoints} pts</b></div>`).join('')}</div>`;
  }

  function updateNavAttention() {
    const user=currentUser(), round=getCurrentRound();
    const item=document.querySelector('.bottom-nav-item[data-route="round"]');
    if(!item) return;
    const missing=!!(user&&round&&effectiveRoundState(round)==='open'&&!getBet(round.id,user.name));
    item.classList.toggle('needs-attention-v2',missing);
    item.setAttribute('aria-label',missing?'Rodada — palpite pendente':'Rodada');
  }

  function celebrateExactV2() {
    const user=currentUser(); if(!user) return;
    const last=finishedRounds().at(-1); if(!last) return;
    const bet=getBet(last.id,user.name); if(!bet) return;
    const result=scorePrediction(bet.cruzeiroGoals,bet.opponentGoals,last.resultCruzeiro,last.resultOpponent);
    const key=`exact-celebrated:${last.id}:${user.name}`;
    if(result.type!=='exato'||sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key,'1');
    const layer=document.createElement('div'); layer.className='confetti-v2'; layer.setAttribute('aria-hidden','true');
    const colors=['#60a5fa','#d7b86b','#ffffff','#2563eb'];
    for(let i=0;i<28;i++){const bit=document.createElement('i');bit.style.left=`${Math.random()*100}%`;bit.style.background=colors[i%colors.length];bit.style.animationDelay=`${Math.random()*.5}s`;bit.style.transform=`rotate(${Math.random()*180}deg)`;layer.appendChild(bit);}
    document.body.appendChild(layer); setTimeout(()=>layer.remove(),2600);
    showToast('🎯 Placar exato! Você cravou!');
  }

  function initEnhancements() {
    ensureDom(); applyTheme(); wrapCore(); wireEvents(); installUpdatePrompt(); enhanceScoreControls();
    renderAll(currentRoute || (currentUser() ? 'round' : 'home'));
    console.info(`[Bolão] Melhorias ${ENHANCEMENT_VERSION} carregadas.`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',initEnhancements,{once:true});
  else initEnhancements();
})();

