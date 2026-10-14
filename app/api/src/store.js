// "Banco de dados" do laboratório: um arquivo JSON.
// Em produção isso seria o Postgres; aqui só precisamos guardar empresas e visitas.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return { companies: [], visits: [] };
  }
}

const db = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

export function listCompanies() {
  return db.companies;
}

export function getCompany(id) {
  return db.companies.find((c) => c.id === id);
}

// Empresa filha: tem parentCompanyId (um nível só, igual ao projeto real)
export function listChildren(parentCompanyId) {
  return db.companies.filter((c) => c.parentCompanyId === parentCompanyId);
}

export function createCompany(name, parentCompanyId = null) {
  const company = {
    id: crypto.randomUUID(),
    name,
    parentCompanyId,
    eventStreamEnabled: false,
    createdAt: new Date().toISOString(),
  };
  db.companies.push(company);
  save();
  return company;
}

export function updateCompany(id, changes) {
  const company = getCompany(id);
  Object.assign(company, changes);
  save();
  return company;
}

export function removeCompany(id) {
  db.companies = db.companies.filter((c) => c.id !== id);
  db.visits = db.visits.filter((v) => v.companyId !== id);
  save();
}

export function listVisits(companyId) {
  return db.visits.filter((v) => v.companyId === companyId).slice(-20).reverse();
}

export function createVisit(companyId, visitorName) {
  const visit = {
    id: crypto.randomUUID(),
    companyId,
    visitorName,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  db.visits.push(visit);
  save();
  return visit;
}

export function updateVisit(id, changes) {
  const visit = db.visits.find((v) => v.id === id);
  if (!visit) return null;
  Object.assign(visit, changes);
  save();
  return visit;
}
