import amqp from 'amqp-connection-manager';
import crypto from 'node:crypto';

import { config } from './config.js';

let connected = false;

const connection = amqp.connect([config.rabbitmqUrl]);

connection.on('connect', () => {
  connected = true;
  console.log('[rabbitmq] conectado');
});

connection.on('disconnect', ({ err }) => {
  connected = false;
  console.error(`[rabbitmq] desconectado: ${err?.message}`);
});

connection.on('connectFailed', ({ err }) => {
  console.error(`[rabbitmq] falha ao conectar: ${err?.message}`);
});

const channel = connection.createChannel({
  json: true,
  confirm: true,
  setup: (ch) => ch.assertExchange(config.exchange, 'topic', { durable: true }),
});

export function getRabbitStatus() {
  return {
    connected,
    // Mensagens que a API aceitou mas ainda não conseguiu entregar ao Rabbit
    // (ficam na memória do processo: se a API reiniciar agora, elas se perdem)
    pendingPublishes: channel.queueLength(),
  };
}

/**
 * Publica no exchange com routing key company.<companyId>.<entity>.<action>.
 * Não espera a confirmação, igual ao hook publishEvent do projeto real:
 * a requisição HTTP responde na hora mesmo com o Rabbit fora do ar.
 */
export function publishEvent(companyId, entity, action, data) {
  const message = {
    eventId: crypto.randomUUID(),
    entity,
    action,
    companyId,
    occurredAt: new Date().toISOString(),
    data,
  };

  channel
    .publish(config.exchange, `company.${companyId}.${entity}.${action}`, message, {
      persistent: true,
      messageId: message.eventId,
      contentType: 'application/json',
    })
    .catch((err) =>
      console.error(`[rabbitmq] falha ao publicar ${message.eventId}: ${err.message}`)
    );

  return message;
}
