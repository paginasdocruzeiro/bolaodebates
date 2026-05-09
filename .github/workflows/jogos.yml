name: Fetch Matches Cruzeiro

on:
  workflow_dispatch:
  schedule:
    # Roda a cada 4 horas.
    # São 2 chamadas à API por execução, cerca de 360 chamadas/mês.
    - cron: "0 */4 * * *"

jobs:
  fetch:
    runs-on: ubuntu-latest

    steps:
      - name: Fetch matches and sync Firebase
        env:
          RAPIDAPI_KEY: ${{ secrets.RAPIDAPI_KEY }}
          FIREBASE_DB_URL: ${{ secrets.FIREBASE_DB_URL }}
          FIREBASE_SECRET: ${{ secrets.FIREBASE_SECRET }}
        run: |
          set -e

          TEAM_ID=1954
          BASE_PATH="bolao-cruzeiro-debates"

          if [ -z "$RAPIDAPI_KEY" ]; then
            echo "Missing RAPIDAPI_KEY"
            exit 1
          fi

          if [ -z "$FIREBASE_DB_URL" ]; then
            echo "Missing FIREBASE_DB_URL"
            exit 1
          fi

          if [ -z "$FIREBASE_SECRET" ]; then
            echo "Missing FIREBASE_SECRET"
            exit 1
          fi

          curl -s --request GET \
            "https://sofascore.p.rapidapi.com/teams/get-last-matches?teamId=${TEAM_ID}&pageIndex=0" \
            --header "x-rapidapi-host: sofascore.p.rapidapi.com" \
            --header "x-rapidapi-key: ${RAPIDAPI_KEY}" > /tmp/last.json

          curl -s --request GET \
            "https://sofascore.p.rapidapi.com/teams/get-next-matches?teamId=${TEAM_ID}&pageIndex=0" \
            --header "x-rapidapi-host: sofascore.p.rapidapi.com" \
            --header "x-rapidapi-key: ${RAPIDAPI_KEY}" > /tmp/next.json

          curl -s \
            "${FIREBASE_DB_URL}/${BASE_PATH}/state.json?auth=${FIREBASE_SECRET}" > /tmp/state.json

          echo "LAST response: $(cat /tmp/last.json | head -c 200)"
          echo "NEXT response: $(cat /tmp/next.json | head -c 200)"
          echo "STATE response: $(cat /tmp/state.json | head -c 200)"

          node <<'NODE'
          const fs = require('fs');

          const TEAM_ID = '1954';
          const APP_TIME_ZONE = 'America/Sao_Paulo';
          const nowIso = new Date().toISOString();

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
            allowManualOverride: true
          };

          function readJson(file, fallback) {
            try {
              const txt = fs.readFileSync(file, 'utf8');

              if (!txt || txt === 'null') return fallback;

              return JSON.parse(txt);
            } catch (err) {
              console.error('JSON read error:', file, err.message);
              return fallback;
            }
          }

          function getZonedParts(date, timeZone = APP_TIME_ZONE) {
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

            return Object.fromEntries(
              parts
                .filter(part => part.type !== 'literal')
                .map(part => [part.type, part.value])
            );
          }

          function getTimeZoneOffsetMs(date, timeZone = APP_TIME_ZONE) {
            const parts = getZonedParts(date, timeZone);

            const asUTC = Date.UTC(
              Number(parts.year),
              Number(parts.month) - 1,
              Number(parts.day),
              Number(parts.hour),
              Number(parts.minute),
              Number(parts.second || 0)
            );

            return asUTC - date.getTime();
          }

          function toAppLocalInput(ms) {
            if (!Number.isFinite(ms) || ms <= 0) return '';

            const parts = getZonedParts(new Date(ms), APP_TIME_ZONE);

            return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
          }

          function parseMs(value) {
            if (!value) return NaN;

            if (/Z$|[+-]\d{2}:?\d{2}$/.test(value)) {
              const ms = Date.parse(value);
              return Number.isFinite(ms) ? ms : NaN;
            }

            const [datePart, timePart = '00:00'] = String(value).split('T');
            const [year, month, day] = datePart.split('-').map(Number);
            const [hour, minute] = timePart.split(':').map(Number);

            if (![year, month, day, hour, minute].every(Number.isFinite)) {
              return NaN;
            }

            const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
            const offset = getTimeZoneOffsetMs(guess, APP_TIME_ZONE);

            return guess.getTime() - offset;
          }

          function durationMs(value, unit) {
            const n = Number(value);
            if (!Number.isFinite(n)) return 0;

            if (unit === 'days') return n * 24 * 60 * 60 * 1000;
            if (unit === 'hours') return n * 60 * 60 * 1000;
            return n * 60 * 1000;
          }

          const last = readJson('/tmp/last.json', { events: [] });
          const next = readJson('/tmp/next.json', { events: [] });
          const state = readJson('/tmp/state.json', {}) || {};

          if (!Array.isArray(state.rounds)) {
            state.rounds = [];
          }

          const automation = {
            ...DEFAULT_AUTOMATION,
            ...(state.settings?.automation || state.automation || {})
          };

          function adapt(e) {
            const homeId = e.homeTeam?.id != null ? String(e.homeTeam.id) : '';
            const awayId = e.awayTeam?.id != null ? String(e.awayTeam.id) : '';
            const startMs = Number(e.startTimestamp || 0) * 1000;

            return {
              idEvent: String(e.id),
              idHomeTeam: homeId,
              idAwayTeam: awayId,
              strHomeTeam: e.homeTeam?.shortName || e.homeTeam?.name || '',
              strAwayTeam: e.awayTeam?.shortName || e.awayTeam?.name || '',
              strLeague: e.tournament?.name || e.season?.tournament?.name || '',
              dateEvent: startMs ? toAppLocalInput(startMs).slice(0, 10) : '',
              strTime: startMs ? toAppLocalInput(startMs).slice(11) : '',
              matchTime: startMs ? toAppLocalInput(startMs) : '',
              startTimestamp: Number(e.startTimestamp || 0),
              intHomeScore: e.homeScore?.current ?? null,
              intAwayScore: e.awayScore?.current ?? null,
              statusType: e.status?.type || '',
              statusDescription: e.status?.description || '',
              winnerCode: e.winnerCode ?? null
            };
          }

          function isCruzeiroHome(match) {
            return String(match.idHomeTeam) === TEAM_ID;
          }

          function opponentName(match) {
            return isCruzeiroHome(match) ? match.strAwayTeam : match.strHomeTeam;
          }

          function isFinished(match) {
            const type = String(match.statusType || '').toLowerCase();

            return [
              'finished',
              'afterextra',
              'afterpenalties',
              'ended'
            ].includes(type);
          }

          function scoreForCruzeiro(match) {
            if (match.intHomeScore === null || match.intAwayScore === null) {
              return null;
            }

            return {
              cruzeiro: isCruzeiroHome(match) ? match.intHomeScore : match.intAwayScore,
              opponent: isCruzeiroHome(match) ? match.intAwayScore : match.intHomeScore
            };
          }

          function safeId() {
            if (global.crypto?.randomUUID) {
              return global.crypto.randomUUID();
            }

            return 'round-' + Date.now() + '-' + Math.random().toString(16).slice(2);
          }

          function getRoundNumber(round) {
            if (Number.isFinite(Number(round.roundNumber))) {
              return Number(round.roundNumber);
            }

            const title = String(round.title || '');
            const match = title.match(/rodada\s*(\d+)/i);

            if (match) return Number(match[1]);

            return 0;
          }

          function nextRoundNumber(rounds) {
            const max = rounds.reduce((acc, round) => {
              return Math.max(acc, getRoundNumber(round));
            }, 0);

            return max + 1;
          }

          function findExistingRound(rounds, match) {
            const externalId = String(match.idEvent);

            const byExternalId = rounds.find(round => {
              return String(round.externalId || round.idEvent || '') === externalId;
            });

            if (byExternalId) return byExternalId;

            const matchMs = parseMs(match.matchTime);
            const opponent = opponentName(match).toLowerCase();

            return rounds.find(round => {
              const roundMs = parseMs(round.matchTime);

              if (!Number.isFinite(matchMs) || !Number.isFinite(roundMs)) {
                return false;
              }

              const sameWindow = Math.abs(matchMs - roundMs) <= 6 * 60 * 60 * 1000;
              const sameOpponent = String(round.opponent || '').toLowerCase() === opponent;

              return sameWindow && sameOpponent;
            }) || null;
          }

          function calculateTimes(matchTime) {
            const matchMs = parseMs(matchTime);

            return {
              autoOpenAt: toAppLocalInput(matchMs - durationMs(automation.openBeforeValue, automation.openBeforeUnit)),
              deadline: toAppLocalInput(matchMs - durationMs(automation.closeBeforeValue, automation.closeBeforeUnit))
            };
          }

          function upsertUpcomingRound(match) {
            if (!automation.enabled || !automation.autoCreateRounds) return false;
            if (!match.idEvent || !match.matchTime) return false;

            let round = findExistingRound(state.rounds, match);
            const matchMs = parseMs(match.matchTime);

            if (!Number.isFinite(matchMs)) return false;

            const times = calculateTimes(match.matchTime);

            if (!round) {
              const number = nextRoundNumber(state.rounds);

              round = {
                id: safeId(),
                roundNumber: number,
                title: `Rodada ${number}`,
                opponent: opponentName(match),
                competition: match.strLeague || 'Jogo do Cruzeiro',
                matchTime: match.matchTime,
                autoOpenAt: times.autoOpenAt,
                deadline: times.deadline,
                resultCruzeiro: null,
                resultOpponent: null,
                manualState: automation.newRoundDefaultMode || 'auto',
                externalId: String(match.idEvent),
                source: 'sofascore',
                cruzeiroIsHome: isCruzeiroHome(match),
                homeTeam: match.strHomeTeam,
                awayTeam: match.strAwayTeam,
                createdAt: nowIso,
                updatedAt: nowIso
              };

              state.rounds.push(round);

              console.log(`Imported new round: ${round.title} - Cruzeiro x ${round.opponent}`);

              return true;
            }

            round.externalId = String(match.idEvent);
            round.source = round.source || 'sofascore';
            round.opponent = round.opponent || opponentName(match);
            round.competition = round.competition || match.strLeague || 'Jogo do Cruzeiro';
            round.matchTime = match.matchTime;
            round.autoOpenAt = times.autoOpenAt;
            round.deadline = times.deadline;
            round.cruzeiroIsHome = isCruzeiroHome(match);
            round.homeTeam = match.strHomeTeam;
            round.awayTeam = match.strAwayTeam;
            round.updatedAt = nowIso;

            if (!Number.isFinite(Number(round.roundNumber))) {
              round.roundNumber = getRoundNumber(round) || nextRoundNumber(state.rounds.filter(r => r !== round));
            }

            if (!round.title || !/rodada\s*\d+/i.test(round.title)) {
              round.title = `Rodada ${round.roundNumber}`;
            }

            return true;
          }

          function applyFinishedResult(match) {
            if (!automation.enabled || !automation.autoApplyResults) return false;
            if (!isFinished(match)) return false;

            const score = scoreForCruzeiro(match);

            if (!score) return false;

            const round = findExistingRound(state.rounds, match);

            if (!round) return false;

            if (round.manualState === 'finalized') {
              console.log(`Skipping finalized round: ${round.title || round.id}`);
              return false;
            }

            const alreadyHasResult =
              round.resultCruzeiro !== null &&
              round.resultCruzeiro !== undefined &&
              round.resultOpponent !== null &&
              round.resultOpponent !== undefined;

            if (alreadyHasResult && round.resultSource && round.resultSource !== 'api') {
              console.log(`Skipping manual result: ${round.title || round.id}`);
              return false;
            }

            if (alreadyHasResult && !round.resultSource) {
              console.log(`Skipping existing result without source: ${round.title || round.id}`);
              return false;
            }

            round.resultCruzeiro = score.cruzeiro;
            round.resultOpponent = score.opponent;
            round.resultSource = 'api';
            round.resultUpdatedAt = nowIso;
            round.externalId = String(match.idEvent);
            round.updatedAt = nowIso;

            if (!round.manualState || round.manualState === 'auto') {
              round.manualState = 'auto';
            }

            console.log(`Applied API result: ${round.title || round.id} = Cruzeiro ${score.cruzeiro} x ${score.opponent} ${round.opponent}`);

            return true;
          }

          const finished = (last.events || [])
            .sort((a, b) => b.startTimestamp - a.startTimestamp)
            .slice(0, 10)
            .map(adapt);

          const upcoming = (next.events || [])
            .sort((a, b) => a.startTimestamp - b.startTimestamp)
            .slice(0, 10)
            .map(adapt);

          upcoming.slice(0, 5).forEach(upsertUpcomingRound);
          finished.forEach(applyFinishedResult);

          state.rounds.sort((a, b) => parseMs(a.matchTime) - parseMs(b.matchTime));

          const externalMatches = {
            finished: finished.slice(0, 5),
            upcoming: upcoming.slice(0, 5),
            updatedAt: nowIso
          };

          if (!state.settings || typeof state.settings !== 'object') {
            state.settings = {};
          }

          state.settings.automation = {
            ...automation,
            updatedAt: automation.updatedAt || nowIso
          };

          const statePatch = {
            externalMatches,
            rounds: state.rounds,
            settings: state.settings
          };

          fs.writeFileSync('/tmp/state-patch.json', JSON.stringify(statePatch));
          fs.writeFileSync('/tmp/matches.json', JSON.stringify(externalMatches));
          NODE

          echo "State patch: $(cat /tmp/state-patch.json | head -c 500)"

          STATE_RESPONSE=$(curl -s -X PATCH \
            -H "Content-Type: application/json" \
            --data-binary @/tmp/state-patch.json \
            "${FIREBASE_DB_URL}/${BASE_PATH}/state.json?auth=${FIREBASE_SECRET}")

          echo "Firebase state response: $(echo "$STATE_RESPONSE" | head -c 300)"

          MATCHES_RESPONSE=$(curl -s -X PUT \
            -H "Content-Type: application/json" \
            --data-binary @/tmp/matches.json \
            "${FIREBASE_DB_URL}/${BASE_PATH}/matches.json?auth=${FIREBASE_SECRET}")

          echo "Firebase matches response: $(echo "$MATCHES_RESPONSE" | head -c 300)"

          if echo "$STATE_RESPONSE" | grep -qi '"error"'; then
            echo "Firebase state update returned error"
            exit 1
          fi

          if echo "$MATCHES_RESPONSE" | grep -qi '"error"'; then
            echo "Firebase matches update returned error"
            exit 1
          fi

          echo "Done"
