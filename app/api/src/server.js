import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { getRabbitStatus, publishEvent } from './rabbitmq.js';
import {
  deprovisionCompanyEventStream,
  getCompanyQueueStats,
  provisionCompanyEventStream,
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

app.post('/api/companies', (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'Informe o nome' });
  res.status(201).json(store.createCompany(name));
});

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
      credentials = await provisionCompanyEventStream(company.id);
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
  const event = publishEvent(req.company.id, 'visit', 'created', visit);
  res.status(201).json({ visit, event });
});

app.patch('/api/companies/:id/visits/:visitId', loadCompany, (req, res) => {
  const visit = store.updateVisit(req.params.visitId, { status: req.body?.status ?? 'checked-in' });
  if (!visit) return res.status(404).json({ error: 'Visita não encontrada' });
  const event = publishEvent(req.company.id, 'visit', 'updated', visit);
  res.json({ visit, event });
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
