// Simula a integração do cliente: conecta no Rabbit (conexão de SAÍDA,
// o cliente não abre porta nenhuma) e consome a fila da empresa.
import amqp from 'amqp-connection-manager';

const { RABBITMQ_URL, QUEUE } = process.env;
const PROCESSING_MS = Number(process.env.PROCESSING_MS ?? 0);

if (!RABBITMQ_URL || !QUEUE) {
  console.error('Defina RABBITMQ_URL e QUEUE no .env (copie da tela do lab)');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toLocaleTimeString(), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connection = amqp.connect([RABBITMQ_URL]);

connection.on('connect', ({ url }) => log('conectado em', String(url).replace(/:[^:@/]+@/, ':***@')));
connection.on('disconnect', ({ err }) => log('desconectado:', err?.message));
connection.on('connectFailed', ({ err }) => log('falha ao conectar:', err?.message));

const channel = connection.createChannel({
  setup: async (ch) => {
    // Recebe no máximo 10 mensagens sem ack por vez
    await ch.prefetch(10);

    // Só consome. Não chame assertQueue: o usuário não tem permissão de
    // configure e o Rabbit recusaria (ACCESS_REFUSED).
    await ch.consume(QUEUE, async (msg) => {
      if (!msg) return;
      const event = JSON.parse(msg.content.toString());

      log(
        `${msg.fields.routingKey}`,
        `| ${event.data?.visitorName ?? ''}`,
        msg.fields.redelivered ? '| (reentregue)' : ''
      );

      if (PROCESSING_MS) await sleep(PROCESSING_MS);

      // Ack só depois de processar: se o processo cair antes, o Rabbit
      // devolve a mensagem para a fila e ela é entregue de novo.
      ch.ack(msg);
    });

    log(`consumindo a fila ${QUEUE}`);
  },
});

channel.on('error', (err) => log('erro no canal:', err.message));

process.on('SIGINT', async () => {
  log('encerrando');
  await connection.close();
  process.exit(0);
});
