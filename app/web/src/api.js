async function request(method, path, body) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `Erro ${response.status}`);
  return data;
}

export const api = {
  status: () => request('GET', '/status'),
  listCompanies: () => request('GET', '/companies'),
  createCompany: (name) => request('POST', '/companies', { name }),
  setEventStream: (id, enabled) =>
    request('PATCH', `/companies/${id}/event-stream`, { enabled }),
  queueStats: (id) => request('GET', `/companies/${id}/queue`),
  listVisits: (id) => request('GET', `/companies/${id}/visits`),
  createVisit: (id, visitorName) =>
    request('POST', `/companies/${id}/visits`, { visitorName }),
  checkIn: (id, visitId) =>
    request('PATCH', `/companies/${id}/visits/${visitId}`, { status: 'checked-in' }),
};
