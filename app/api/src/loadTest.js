// Gerador de carga: publica eventos sintéticos de visita numa taxa fixa,
// sem gravar no "banco" (o gargalo seria o arquivo JSON, não o Rabbit).
import crypto from 'node:crypto';

import { getRabbitStatus, publishEvent } from './rabbitmq.js';

export const MAX_RATE = 5000;
const TICK_MS = 50;

let run = null;

function snapshot() {
  if (!run) return { running: false };

  const now = run.finishedAt ?? Date.now();
  const elapsedSeconds = (now - run.startedAt) / 1000;

  return {
    running: !run.finishedAt,
    stoppedEarly: run.stoppedEarly,
    rate: run.rate,
    durationSeconds: run.durationSeconds,
    companies: run.companies.map((c) => c.name),
    target: run.target,
    published: run.published,
    confirmed: run.confirmed,
    failed: run.failed,
    elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
    // Taxa real de confirmação pelo Rabbit (pode ficar abaixo da pedida)
    confirmedPerSecond: elapsedSeconds > 0 ? Math.round(run.confirmed / elapsedSeconds) : 0,
    pendingInApiMemory: getRabbitStatus().pendingPublishes,
  };
}

function finish(stoppedEarly = false) {
  clearInterval(run.timer);
  run.finishedAt = Date.now();
  run.stoppedEarly = stoppedEarly;
  console.log(
    `[load] fim: ${run.published} publicadas, ${run.confirmed} confirmadas, ${run.failed} falhas`
  );
}

/**
 * Publica `rate` eventos por segundo durante `durationSeconds`, distribuindo
 * em round-robin entre as empresas. A cada tick calcula quantos eventos já
 * deveriam ter saído desde o início, então não acumula atraso.
 */
export function startLoadTest({ companies, rate, durationSeconds }) {
  if (run && !run.finishedAt) {
    throw new Error('Já existe um teste de carga rodando');
  }

  run = {
    companies,
    rate,
    durationSeconds,
    target: rate * durationSeconds,
    startedAt: Date.now(),
    published: 0,
    confirmed: 0,
    failed: 0,
  };

  console.log(`[load] início: ${rate}/s por ${durationSeconds}s em ${companies.length} empresa(s)`);

  const current = run;
  current.timer = setInterval(() => {
    const elapsedSeconds = (Date.now() - current.startedAt) / 1000;
    const due = Math.min(current.target, Math.floor(elapsedSeconds * current.rate));

    while (current.published < due) {
      const company = current.companies[current.published % current.companies.length];
      const sequence = current.published + 1;

      const { confirmation } = publishEvent(company.id, 'visit', 'created', {
        id: crypto.randomUUID(),
        companyId: company.id,
        companyName: company.name,
        visitorName: `Carga #${sequence}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        loadTest: true,
      });

      confirmation.then(
        () => current.confirmed++,
        () => current.failed++
      );
      current.published++;
    }

    if (current.published >= current.target) {
      finish();
    }
  }, TICK_MS);

  return snapshot();
}

export function stopLoadTest() {
  if (run && !run.finishedAt) finish(true);
  return snapshot();
}

export const getLoadTestStatus = snapshot;
