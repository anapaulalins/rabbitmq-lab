import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { getLoadTestStatus, MAX_RATE, startLoadTest, stopLoadTest } from './loadTest.js';
import { getRabbitStatus, publishEvent } from './rabbitmq.js';
import {
  bindChildToParentQueue,
  deprovisionCompanyEventStream,
  getCompanyQueueStats,
  provisionCompanyEventStream,
  unbindChildFromParentQueue,
} from './rabbitmqAdmin.js';
import * as store from './store.js';

const app = express();
app.use(express.json());

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function loadCompany(req, res, next) {
  const company = store.getCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Empresa não encontrada' });
  req.company = company;
  next();
}

app.get('/api/status', (req, res) => {
  res.json({ rabbit: getRabbitStatus() });
});

app.get('/api/companies', (req, res) => {
  res.json(store.listCompanies());
});

app.post(
  '/api/companies',
  asyncRoute(async (req, res) => {
    const name = req.body?.name?.trim();
    const parentCompanyId = req.body?.parentCompanyId || null;
    if (!name) return res.status(400).json({ error: 'Informe o nome' });

    let parent = null;
    if (parentCompanyId) {
      parent = store.getCompany(parentCompanyId);
      if (!parent) return res.status(400).json({ error: 'Empresa mãe não encontrada' });
      if (parent.parentCompanyId) {
        return res.status(400).json({ error: 'Uma filha não pode ter filhas (um nível só)' });
      }
    }

    const company = store.createCompany(name, parentCompanyId);

    // Igual ao syncParentEventStreamBinding do projeto real: a empresa já foi
    // salva, então uma falha no Rabbit não desfaz a criação, só avisa.
    let warning;
    if (parent?.eventStreamEnabled) {
      try {
        await bindChildToParentQueue(parent.id, company.id);
      } catch (err) {
        warning = `Empresa criada, mas a fila da mãe não foi ligada: ${err.message}`;
        console.error(`[api] ${warning}`);
      }
    }

    res.status(201).json({ company, warning });
  })
);

app.delete(
  '/api/companies/:id',
  loadCompany,
  asyncRoute(async (req, res) => {
    const { company } = req;

    if (store.listChildren(company.id).length) {
      return res.status(400).json({ error: 'Remova as filhas antes da empresa mãe' });
    }

    if (company.eventStreamEnabled) {
      await deprovisionCompanyEventStream(company.id);
    }

    const parent = company.parentCompanyId && store.getCompany(company.parentCompanyId);
    if (parent?.eventStreamEnabled) {
      await unbindChildFromParentQueue(parent.id, company.id);
    }

    store.removeCompany(company.id);
    res.status(204).end();
  })
);

// Liga/desliga a fila da empresa. Equivale ao PATCH com eventStreamEnabled
// no projeto real: o Rabbit é configurado ANTES de salvar no "banco".
app.patch(
  '/api/companies/:id/event-stream',
  loadCompany,
  asyncRoute(async (req, res) => {
    const enabled = req.body?.enabled === true;
    const { company } = req;

    if (company.eventStreamEnabled === enabled) {
      return res.json({ company });
    }

    let credentials;
    if (enabled) {
      // Empresa mãe: a fila também recebe os eventos das filhas
      const childIds = store.listChildren(company.id).map((c) => c.id);
      credentials = await provisionCompanyEventStream(company.id, childIds);
    } else {
      await deprovisionCompanyEventStream(company.id);
    }

    const updated = store.updateCompany(company.id, { eventStreamEnabled: enabled });
    // A senha só aparece nesta resposta; não é salva em lugar nenhum
    res.json({ company: updated, credentials });
  })
);

app.get(
  '/api/companies/:id/queue',
  loadCompany,
  asyncRoute(async (req, res) => {
    res.json(await getCompanyQueueStats(req.company.id));
  })
);

app.get('/api/companies/:id/visits', loadCompany, (req, res) => {
  res.json(store.listVisits(req.company.id));
});

app.post('/api/companies/:id/visits', loadCompany, (req, res) => {
  const visitorName = req.body?.visitorName?.trim() || 'Visitante';
  const visit = store.createVisit(req.company.id, visitorName);
  const { message } = publishEvent(req.company.id, 'visit', 'created', {
    ...visit,
    companyName: req.company.name,
  });
  res.status(201).json({ visit, event: message });
});

app.patch('/api/companies/:id/visits/:visitId', loadCompany, (req, res) => {
  const visit = store.updateVisit(req.params.visitId, { status: req.body?.status ?? 'checked-in' });
  if (!visit) return res.status(404).json({ error: 'Visita não encontrada' });
  const { message } = publishEvent(req.company.id, 'visit', 'updated', {
    ...visit,
    companyName: req.company.name,
  });
  res.json({ visit, event: message });
});

// ---------- Teste de carga ----------

app.get('/api/load-test', (req, res) => {
  res.json({ ...getLoadTestStatus(), maxRate: MAX_RATE });
});

app.post('/api/load-test', (req, res) => {
  const rate = Number(req.body?.rate);
  const durationSeconds = Number(req.body?.durationSeconds);
  const companies = (req.body?.companyIds ?? []).map(store.getCompany).filter(Boolean);

  if (!companies.length) return res.status(400).json({ error: 'Escolha ao menos uma empresa' });
  if (!(rate >= 1 && rate <= MAX_RATE)) {
    return res.status(400).json({ error: `A taxa deve ficar entre 1 e ${MAX_RATE} eventos/s` });
  }
  if (!(durationSeconds >= 1 && durationSeconds <= 600)) {
    return res.status(400).json({ error: 'A duração deve ficar entre 1 e 600 segundos' });
  }

  try {
    res.status(201).json(startLoadTest({ companies, rate, durationSeconds }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.delete('/api/load-test', (req, res) => {
  res.json(stopLoadTest());
});

// Front-end React já compilado (npm run build copia para ./public)
const publicDir = path.resolve('public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
}

app.use((err, req, res, next) => {
  // fetch esconde o motivo real (ex.: ECONNREFUSED, timeout) em err.cause
  const message = err.cause ? `${err.message}: ${err.cause.code ?? err.cause.message}` : err.message;
  console.error(`[api] ${req.method} ${req.path}: ${message}`);
  res.status(502).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`[api] ouvindo na porta ${config.port}`);
});
