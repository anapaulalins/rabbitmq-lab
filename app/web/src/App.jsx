import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';

// Atualiza um valor a cada `ms` milissegundos
function usePolling(fn, ms, deps) {
  const [value, setValue] = useState(null);
  const refresh = useCallback(() => fn().then(setValue).catch(() => setValue(null)), deps);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, ms);
    return () => clearInterval(timer);
  }, [refresh, ms]);

  return [value, refresh];
}

function RabbitStatus() {
  const [status] = usePolling(api.status, 2000, []);
  const rabbit = status?.rabbit;

  return (
    <div className={`status ${rabbit?.connected ? 'ok' : 'down'}`}>
      <span className="dot" />
      {rabbit?.connected ? 'API conectada ao RabbitMQ' : 'API sem conexão com o RabbitMQ'}
      {rabbit?.pendingPublishes > 0 && (
        <strong> · {rabbit.pendingPublishes} publicação(ões) presas na memória da API</strong>
      )}
    </div>
  );
}

function Credentials({ credentials, onClose }) {
  const envText = [
    `RABBITMQ_URL=${credentials.url.replace('://', `://${credentials.username}:${credentials.password}@`)}`,
    `QUEUE=${credentials.queue}`,
  ].join('\n');

  return (
    <div className="credentials">
      <p>
        <strong>Guarde agora: a senha não será mostrada de novo.</strong> Cole no{' '}
        <code>consumer/.env</code>:
      </p>
      <pre>{envText}</pre>
      {/* navigator.clipboard só existe em HTTPS/localhost; na EC2 via HTTP, selecione o texto */}
      {window.isSecureContext && (
        <button onClick={() => navigator.clipboard.writeText(envText)}>Copiar</button>
      )}
      <button className="secondary" onClick={onClose}>
        Fechar
      </button>
    </div>
  );
}

function QueueStats({ companyId, enabled }) {
  const [stats] = usePolling(
    () => (enabled ? api.queueStats(companyId) : Promise.resolve(null)),
    2000,
    [companyId, enabled]
  );

  if (!enabled) return <p className="muted">Sem fila: os eventos desta empresa são descartados pelo Rabbit.</p>;
  if (!stats) return <p className="muted">Carregando fila…</p>;

  return (
    <div className="stats">
      <div>
        <span>{stats.messagesReady}</span>esperando na fila
      </div>
      <div>
        <span>{stats.messagesUnacked}</span>entregues sem ack
      </div>
      <div className={stats.consumers > 0 ? 'ok' : 'down'}>
        <span>{stats.consumers}</span>consumidor(es)
      </div>
    </div>
  );
}

function CompanyPanel({ company, onChange }) {
  const [credentials, setCredentials] = useState(null);
  const [visitorName, setVisitorName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [visits, refreshVisits] = usePolling(() => api.listVisits(company.id), 5000, [company.id]);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const toggleStream = () =>
    run(async () => {
      const { company: updated, credentials } = await api.setEventStream(
        company.id,
        !company.eventStreamEnabled
      );
      setCredentials(credentials ?? null);
      onChange(updated);
    });

  const createVisit = (count = 1) =>
    run(async () => {
      for (let i = 0; i < count; i++) {
        await api.createVisit(company.id, visitorName || `Visitante ${Date.now() % 10000}`);
      }
      setVisitorName('');
      refreshVisits();
    });

  const checkIn = (visitId) =>
    run(async () => {
      await api.checkIn(company.id, visitId);
      refreshVisits();
    });

  return (
    <section className="card">
      <header>
        <div>
          <h2>{company.name}</h2>
          <code className="muted">{company.id}</code>
        </div>
        <button disabled={busy} onClick={toggleStream} className={company.eventStreamEnabled ? 'danger' : ''}>
          {company.eventStreamEnabled ? 'Desligar fila' : 'Ligar fila (eventStreamEnabled)'}
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {credentials && <Credentials credentials={credentials} onClose={() => setCredentials(null)} />}

      <QueueStats companyId={company.id} enabled={company.eventStreamEnabled} />

      <div className="row">
        <input
          placeholder="Nome do visitante"
          value={visitorName}
          onChange={(e) => setVisitorName(e.target.value)}
        />
        <button disabled={busy} onClick={() => createVisit(1)}>
          Criar visita
        </button>
        <button disabled={busy} className="secondary" onClick={() => createVisit(10)}>
          Criar 10
        </button>
      </div>

      <ul className="visits">
        {visits?.map((visit) => (
          <li key={visit.id}>
            <span>{visit.visitorName}</span>
            <span className="muted">{new Date(visit.createdAt).toLocaleTimeString()}</span>
            {visit.status === 'pending' ? (
              <button className="link" disabled={busy} onClick={() => checkIn(visit.id)}>
                check-in
              </button>
            ) : (
              <span className="tag">{visit.status}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function App() {
  const [companies, setCompanies] = useState([]);
  const [name, setName] = useState('');

  useEffect(() => {
    api.listCompanies().then(setCompanies);
  }, []);

  async function createCompany(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const company = await api.createCompany(name);
    setCompanies((list) => [...list, company]);
    setName('');
  }

  const replaceCompany = (updated) =>
    setCompanies((list) => list.map((c) => (c.id === updated.id ? updated : c)));

  return (
    <main>
      <h1>RabbitMQ Lab</h1>
      <RabbitStatus />

      <form className="row" onSubmit={createCompany}>
        <input placeholder="Nome da empresa" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Criar empresa</button>
      </form>

      {companies.map((company) => (
        <CompanyPanel key={company.id} company={company} onChange={replaceCompany} />
      ))}
    </main>
  );
}
