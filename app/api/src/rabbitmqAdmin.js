// Cria e remove usuário/fila por empresa usando a API HTTP de administração
// do RabbitMQ (porta 15672). Mesma lógica do rabbitmqAdmin.ts do projeto real.
import crypto from 'node:crypto';

import { config } from './config.js';

const COMPANY_QUEUES_POLICY = 'company-queues';

export const companyQueueName = (companyId) => `company.${companyId}`;
export const companyUsername = (companyId) => `company_${companyId}`;

// Todos os eventos de uma empresa: company.<companyId>.<entidade>.<ação>
const companyRoutingPattern = (companyId) => `company.${companyId}.#`;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const enc = encodeURIComponent;

async function request(method, path, body, { ignoreNotFound = false } = {}) {
  const { url, username, password } = config.management;
  const response = await fetch(`${url}/api${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  if (response.status === 404 && ignoreNotFound) return null;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function queueBindingsPath(queueCompanyId) {
  const vhost = enc(config.management.vhost);
  return `/bindings/${vhost}/e/${enc(config.exchange)}/q/${enc(companyQueueName(queueCompanyId))}`;
}

async function bindCompany(queueCompanyId, sourceCompanyId) {
  await request('POST', queueBindingsPath(queueCompanyId), {
    routing_key: companyRoutingPattern(sourceCompanyId),
  });
}

async function unbindCompany(queueCompanyId, sourceCompanyId) {
  const path = queueBindingsPath(queueCompanyId);
  const bindings = (await request('GET', path, null, { ignoreNotFound: true })) ?? [];
  const binding = bindings.find((b) => b.routing_key === companyRoutingPattern(sourceCompanyId));

  if (binding) {
    await request('DELETE', `${path}/${enc(binding.properties_key)}`, null, {
      ignoreNotFound: true,
    });
  }
}

/**
 * Deixa a fila ligada exatamente às empresas informadas
 * (ela mesma + as filhas, no caso de uma empresa mãe).
 */
async function reconcileBindings(queueCompanyId, sourceCompanyIds) {
  const path = queueBindingsPath(queueCompanyId);
  const bindings = (await request('GET', path)) ?? [];
  const current = new Set(bindings.map((b) => b.routing_key));
  const wanted = new Set(sourceCompanyIds.map(companyRoutingPattern));

  for (const sourceCompanyId of sourceCompanyIds) {
    if (!current.has(companyRoutingPattern(sourceCompanyId))) {
      await bindCompany(queueCompanyId, sourceCompanyId);
    }
  }

  for (const binding of bindings) {
    if (!wanted.has(binding.routing_key)) {
      await request('DELETE', `${path}/${enc(binding.properties_key)}`, null, {
        ignoreNotFound: true,
      });
    }
  }
}

/**
 * Idempotente: chamar de novo gera nova senha, re-sincroniza os bindings e
 * mantém a fila e as mensagens. Uma empresa mãe recebe também os eventos das filhas.
 */
export async function provisionCompanyEventStream(companyId, childCompanyIds = []) {
  const vhost = enc(config.management.vhost);
  const exchange = enc(config.exchange);
  const queue = companyQueueName(companyId);
  const username = companyUsername(companyId);
  const password = crypto.randomBytes(24).toString('hex');

  await request('PUT', `/exchanges/${vhost}/${exchange}`, {
    type: 'topic',
    durable: true,
  });

  await request('PUT', `/policies/${vhost}/${COMPANY_QUEUES_POLICY}`, {
    pattern: '^company\\.',
    'apply-to': 'queues',
    definition: {
      'message-ttl': config.companyQueues.messageTtlMs,
      'max-length': config.companyQueues.maxLength,
      overflow: 'drop-head',
    },
  });

  await request('PUT', `/queues/${vhost}/${enc(queue)}`, {
    durable: true,
    auto_delete: false,
  });

  await reconcileBindings(companyId, [companyId, ...childCompanyIds]);

  await request('PUT', `/users/${enc(username)}`, { password, tags: '' });

  // Só consome: sem configure/write, leitura apenas da própria fila
  await request('PUT', `/permissions/${vhost}/${enc(username)}`, {
    configure: '^$',
    write: '^$',
    read: `^${escapeRegex(queue)}$`,
  });

  return { url: config.publicUrl, username, password, queue };
}

export async function deprovisionCompanyEventStream(companyId) {
  const vhost = enc(config.management.vhost);
  // Usuário primeiro: derruba a conexão do cliente antes de apagar a fila
  await request('DELETE', `/users/${enc(companyUsername(companyId))}`, null, {
    ignoreNotFound: true,
  });
  await request('DELETE', `/queues/${vhost}/${enc(companyQueueName(companyId))}`, null, {
    ignoreNotFound: true,
  });
}

// Filha entrou numa mãe com fila: a fila da mãe passa a receber os eventos dela
export const bindChildToParentQueue = (parentCompanyId, childCompanyId) =>
  bindCompany(parentCompanyId, childCompanyId);

// Filha saiu da mãe (removida)
export const unbindChildFromParentQueue = (parentCompanyId, childCompanyId) =>
  unbindCompany(parentCompanyId, childCompanyId);

/**
 * Números da fila para mostrar na tela.
 */
export async function getCompanyQueueStats(companyId) {
  const vhost = enc(config.management.vhost);
  const queue = await request('GET', `/queues/${vhost}/${enc(companyQueueName(companyId))}`, null, {
    ignoreNotFound: true,
  });
  if (!queue) return null;

  const stats = queue.message_stats ?? {};
  const bindings = (await request('GET', queueBindingsPath(companyId), null, { ignoreNotFound: true })) ?? [];

  return {
    name: queue.name,
    messages: queue.messages ?? 0,
    messagesReady: queue.messages_ready ?? 0,
    messagesUnacked: queue.messages_unacknowledged ?? 0,
    consumers: queue.consumers ?? 0,
    // Taxas calculadas pelo próprio Rabbit (média dos últimos segundos)
    incomingRate: stats.publish_details?.rate ?? 0,
    deliverRate: stats.deliver_get_details?.rate ?? 0,
    ackRate: stats.ack_details?.rate ?? 0,
    boundCompanyIds: bindings
      .map((b) => b.routing_key.match(/^company\.(.+)\.#$/)?.[1])
      .filter(Boolean),
  };
}
