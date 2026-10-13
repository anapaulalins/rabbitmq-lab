// Cria e remove usuário/fila por empresa usando a API HTTP de administração
// do RabbitMQ (porta 15672). Mesma lógica do rabbitmqAdmin.ts do projeto real.
import crypto from 'node:crypto';

import { config } from './config.js';

const COMPANY_QUEUES_POLICY = 'company-queues';

export const companyQueueName = (companyId) => `company.${companyId}`;
export const companyUsername = (companyId) => `company_${companyId}`;

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

/**
 * Idempotente: chamar de novo gera nova senha e mantém a fila e as mensagens.
 */
export async function provisionCompanyEventStream(companyId) {
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

  await request('POST', `/bindings/${vhost}/e/${exchange}/q/${enc(queue)}`, {
    routing_key: `company.${companyId}.#`,
  });

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

/**
 * Números da fila para mostrar na tela (mensagens paradas, consumidores).
 */
export async function getCompanyQueueStats(companyId) {
  const vhost = enc(config.management.vhost);
  const queue = await request('GET', `/queues/${vhost}/${enc(companyQueueName(companyId))}`, null, {
    ignoreNotFound: true,
  });
  if (!queue) return null;

  return {
    name: queue.name,
    messages: queue.messages ?? 0,
    messagesReady: queue.messages_ready ?? 0,
    messagesUnacked: queue.messages_unacknowledged ?? 0,
    consumers: queue.consumers ?? 0,
  };
}
