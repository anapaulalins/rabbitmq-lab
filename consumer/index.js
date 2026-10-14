// Simula a integração do cliente: conecta no Rabbit (conexão de SAÍDA,
// o cliente não abre porta nenhuma) e consome a fila da empresa.
import amqp from 'amqp-connection-manager';

const { RABBITMQ_URL, QUEUE } = process.env;
const PROCESSING_MS = Number(process.env.PROCESSING_MS ?? 0);
const PREFETCH = Number(process.env.PREFETCH ?? 10);
// MODE=stats: em vez de uma linha por evento, um resumo por segundo
// (use no teste de carga; imprimir milhares de linhas/s deixa o consumer lento)
const STATS_MODE = process.env.MODE === 'stats';

if (!RABBITMQ_URL || !QUEUE) {
  console.error('Defina RABBITMQ_URL e QUEUE no .env (copie da tela do lab)');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toLocaleTimeString(), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- estatísticas ----------

const totals = { received: 0, redelivered: 0, byCompany: new Map() };
let perSecond = { received: 0, latencySum: 0, latencyMax: 0 };

function record(event, msg) {
  totals.received++;
  if (msg.fields.redelivered) totals.redelivered++;

  const company = event.data?.companyName ?? event.companyId?.slice(0, 8);
  totals.byCompany.set(company, (totals.byCompany.get(company) ?? 0) + 1);

  // Latência ponta a ponta: da publicação na API até chegar aqui
  const latency = Date.now() - new Date(event.occurredAt).getTime();
  perSecond.received++;
  perSecond.latencySum += latency;
  perSecond.latencyMax = Math.max(perSecond.latencyMax, latency);
}

if (STATS_MODE) {
  setInterval(() => {
    if (!perSecond.received) return;
    const avg = Math.round(perSecond.latencySum / perSecond.received);
    const companies = [...totals.byCompany].map(([name, count]) => `${name}=${count}`).join(' ');
    log(
      `${perSecond.received}/s`,
      `| total ${totals.received}`,
      `| latência média ${avg}ms, máx ${perSecond.latencyMax}ms`,
      totals.redelivered ? `| reentregues ${totals.redelivered}` : '',
      `| ${companies}`
    );
    perSecond = { received: 0, latencySum: 0, latencyMax: 0 };
  }, 1000);
}

// ---------- conexão ----------

const connection = amqp.connect([RABBITMQ_URL]);

connection.on('connect', ({ url }) => log('conectado em', String(url).replace(/:[^:@/]+@/, ':***@')));
connection.on('disconnect', ({ err }) => log('desconectado:', err?.message));
connection.on('connectFailed', ({ err }) => log('falha ao conectar:', err?.message));

const channel = connection.createChannel({
  setup: async (ch) => {
    // Quantas mensagens o Rabbit entrega sem ack. Mais alto = mais vazão,
    // mas mais mensagens reentregues se o consumer cair.
    await ch.prefetch(PREFETCH);

    // Só consome. Não chame assertQueue: o usuário não tem permissão de
    // configure e o Rabbit recusaria (ACCESS_REFUSED).
    await ch.consume(QUEUE, async (msg) => {
      if (!msg) return;
      const event = JSON.parse(msg.content.toString());
      record(event, msg);

      if (!STATS_MODE) {
        log(
          msg.fields.routingKey,
          `| ${event.data?.companyName ?? ''}`,
          `| ${event.data?.visitorName ?? ''}`,
          msg.fields.redelivered ? '| (reentregue)' : ''
        );
      }

      if (PROCESSING_MS) await sleep(PROCESSING_MS);

      // Ack só depois de processar: se o processo cair antes, o Rabbit
      // devolve a mensagem para a fila e ela é entregue de novo.
      ch.ack(msg);
    });

    log(`consumindo a fila ${QUEUE} (prefetch ${PREFETCH}${STATS_MODE ? ', modo stats' : ''})`);
  },
});

channel.on('error', (err) => log('erro no canal:', err.message));

process.on('SIGINT', async () => {
  log(`encerrando · ${totals.received} recebidas no total`);
  await connection.close();
  process.exit(0);
});
