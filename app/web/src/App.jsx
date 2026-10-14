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

const formatNumber = (n) => Number(n ?? 0).toLocaleString('pt-BR');

function RabbitStatus() {
  const [status] = usePolling(api.status, 2000, []);
  const rabbit = status?.rabbit;

  return (
    <div className={`status ${rabbit?.connected ? 'ok' : 'down'}`}>
      <span className="dot" />
      {rabbit?.connected ? 'API conectada ao RabbitMQ' : 'API sem conexão com o RabbitMQ'}
      {rabbit?.pendingPublishes > 0 && (
        <strong> · {formatNumber(rabbit.pendingPublishes)} publicação(ões) presas na memória da API</strong>
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

function QueueStats({ company, companiesById }) {
  const enabled = company.eventStreamEnabled;
  const [stats] = usePolling(
    () => (enabled ? api.queueStats(company.id) : Promise.resolve(null)),
    2000,
    [company.id, enabled]
  );

  if (!enabled) {
    return <p className="muted">Sem fila: o Rabbit descarta os eventos desta empresa (a não ser que a mãe tenha fila).</p>;
  }
  if (!stats) return <p className="muted">Carregando fila…</p>;

  const childNames = stats.boundCompanyIds
    .filter((id) => id !== company.id)
    .map((id) => companiesById[id]?.name ?? id.slice(0, 8));

  return (
    <>
      <div className="stats">
        <div>
          <span>{formatNumber(stats.messagesReady)}</span>esperando na fila
        </div>
        <div>
          <span>{formatNumber(stats.messagesUnacked)}</span>entregues sem ack
        </div>
        <div className={stats.consumers > 0 ? 'ok' : 'down'}>
          <span>{stats.consumers}</span>consumidor(es)
        </div>
        <div>
          <span>{formatNumber(Math.round(stats.incomingRate))}/s</span>chegando
        </div>
        <div>
          <span>{formatNumber(Math.round(stats.ackRate))}/s</span>consumidas (ack)
        </div>
      </div>
      {childNames.length > 0 && (
        <p className="muted small">
          Esta fila também recebe os eventos de: <strong>{childNames.join(', ')}</strong>
        </p>
      )}
    </>
  );
}

function CompanyPanel({ company, parent, childCompanies, companiesById, onChange, onRemove }) {
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

  const remove = () =>
    run(async () => {
      if (!window.confirm(`Remover ${company.name}?`)) return;
      await api.removeCompany(company.id);
      onRemove(company.id);
    });

  return (
    <section className={`card ${parent ? 'child' : ''}`}>
      <header>
        <div>
          <h2>
            {company.name}{' '}
            {parent && <span className="badge">filha de {parent.name}</span>}
            {childCompanies.length > 0 && <span className="badge parent">mãe de {childCompanies.length}</span>}
          </h2>
          <code className="muted">{company.id}</code>
        </div>
        <div className="actions">
          <button disabled={busy} onClick={toggleStream} className={company.eventStreamEnabled ? 'danger' : ''}>
            {company.eventStreamEnabled ? 'Desligar fila' : 'Ligar fila'}
          </button>
          <button disabled={busy} className="secondary" onClick={remove}>
            Remover
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {credentials && <Credentials credentials={credentials} onClose={() => setCredentials(null)} />}

      <QueueStats company={company} companiesById={companiesById} />

      {parent?.eventStreamEnabled && (
        <p className="muted small">Os eventos desta empresa também vão para a fila de {parent.name}.</p>
      )}

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

function LoadTestPanel({ companies }) {
  const [selected, setSelected] = useState([]);
  const [rate, setRate] = useState(100);
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [error, setError] = useState(null);
  const [status, refresh] = usePolling(api.loadTestStatus, 1000, []);

  // Remove da seleção empresas que foram apagadas
  useEffect(() => {
    setSelected((ids) => ids.filter((id) => companies.some((c) => c.id === id)));
  }, [companies]);

  const toggle = (id) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  async function start() {
    setError(null);
    try {
      await api.startLoadTest({
        companyIds: selected,
        rate: Number(rate),
        durationSeconds: Number(durationSeconds),
      });
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function stop() {
    await api.stopLoadTest();
    refresh();
  }

  const running = status?.running;
  const progress = status?.target ? Math.min(100, (status.published / status.target) * 100) : 0;

  return (
    <section className="card load">
      <header>
        <h2>Teste de carga</h2>
      </header>
      <p className="muted small">
        Publica eventos <code>visit.created</code> sintéticos direto no Rabbit, em round-robin entre as empresas
        escolhidas. Não grava no "banco" do lab.
      </p>

      <div className="chips">
        {companies.map((company) => (
          <label key={company.id} className={selected.includes(company.id) ? 'chip on' : 'chip'}>
            <input
              type="checkbox"
              checked={selected.includes(company.id)}
              onChange={() => toggle(company.id)}
              disabled={running}
            />
            {company.name}
          </label>
        ))}
        {!companies.length && <span className="muted">Crie uma empresa primeiro.</span>}
      </div>

      <div className="row">
        <label className="field">
          Eventos por segundo
          <input
            type="number"
            min="1"
            max={status?.maxRate ?? 5000}
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="field">
          Duração (s)
          <input
            type="number"
            min="1"
            max="600"
            value={durationSeconds}
            onChange={(e) => setDurationSeconds(e.target.value)}
            disabled={running}
          />
        </label>
        {running ? (
          <button className="danger" onClick={stop}>
            Parar
          </button>
        ) : (
          <button onClick={start} disabled={!selected.length}>
            Iniciar ({formatNumber(rate * durationSeconds)} eventos)
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {status?.target > 0 && (
        <>
          <div className="progress">
            <div style={{ width: `${progress}%` }} />
          </div>
          <div className="stats">
            <div>
              <span>{formatNumber(status.published)}</span>publicadas de {formatNumber(status.target)}
            </div>
            <div>
              <span>{formatNumber(status.confirmed)}</span>confirmadas pelo Rabbit
            </div>
            <div className={status.failed ? 'down' : ''}>
              <span>{formatNumber(status.failed)}</span>falhas
            </div>
            <div>
              <span>{formatNumber(status.confirmedPerSecond)}/s</span>
              confirmação real (pedido: {formatNumber(status.rate)}/s)
            </div>
            <div className={status.pendingInApiMemory ? 'down' : ''}>
              <span>{formatNumber(status.pendingInApiMemory)}</span>presas na memória da API
            </div>
          </div>
          <p className="muted small">
            {running ? 'Rodando' : status.stoppedEarly ? 'Interrompido' : 'Concluído'} · {status.elapsedSeconds}s ·{' '}
            {status.companies?.join(', ')}
          </p>
        </>
      )}
    </section>
  );
}

export default function App() {
  const [companies, setCompanies] = useState([]);
  const [name, setName] = useState('');
  const [parentCompanyId, setParentCompanyId] = useState('');
  const [message, setMessage] = useState(null);

  useEffect(() => {
    api.listCompanies().then(setCompanies);
  }, []);

  const companiesById = Object.fromEntries(companies.map((c) => [c.id, c]));
  // Só empresas sem mãe podem ser mãe (um nível só)
  const possibleParents = companies.filter((c) => !c.parentCompanyId);

  async function createCompany(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setMessage(null);
    try {
      const { company, warning } = await api.createCompany(name, parentCompanyId || null);
      setCompanies((list) => [...list, company]);
      setName('');
      if (warning) setMessage(warning);
    } catch (err) {
      setMessage(err.message);
    }
  }

  const replaceCompany = (updated) =>
    setCompanies((list) => list.map((c) => (c.id === updated.id ? updated : c)));

  const removeCompany = (id) => setCompanies((list) => list.filter((c) => c.id !== id));

  // Mães seguidas das filhas
  const ordered = possibleParents.flatMap((parent) => [
    parent,
    ...companies.filter((c) => c.parentCompanyId === parent.id),
  ]);

  return (
    <main>
      <h1>RabbitMQ Lab</h1>
      <RabbitStatus />

      <form className="row" onSubmit={createCompany}>
        <input placeholder="Nome da empresa" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={parentCompanyId} onChange={(e) => setParentCompanyId(e.target.value)}>
          <option value="">Independente / mãe</option>
          {possibleParents.map((c) => (
            <option key={c.id} value={c.id}>
              Filha de {c.name}
            </option>
          ))}
        </select>
        <button type="submit">Criar empresa</button>
      </form>
      {message && <p className="error">{message}</p>}

      <LoadTestPanel companies={ordered} />

      {ordered.map((company) => (
        <CompanyPanel
          key={company.id}
          company={company}
          parent={companiesById[company.parentCompanyId]}
          childCompanies={companies.filter((c) => c.parentCompanyId === company.id)}
          companiesById={companiesById}
          onChange={replaceCompany}
          onRemove={removeCompany}
        />
      ))}
    </main>
  );
}
