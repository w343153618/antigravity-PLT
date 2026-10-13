import { expect, it } from 'vitest';
import { buildApp } from '../src/app/app.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authOptions, login } from './helpers/auth.ts';

it('requires authenticated identity and scopes client reads while denying all manager writes', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
  try {
    expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
    const hq = await login(app, 'admin');
    const operator = await login(app, 'dianzhang');
    const customer = await login(app, 'user');
    const identities = (await hq.inject('/api/bootstrap')).json();
    const client = identities.clients.find((row: { id: string }) => row.id === customer.actor.clientId);
    const cookie = customer.cookie;
    const bootstrap = await app.inject({ url: '/api/bootstrap', headers: { cookie } });
    expect(bootstrap.json().clients.map((row: {id:string}) => row.id)).toEqual([client.id]);
    expect((await app.inject({ url: `/api/clients/${client.id}/reconciliations`, headers: { cookie } })).statusCode).toBe(200);
    const other = identities.clients.find((row: {id:string}) => row.id !== client.id);
    expect((await app.inject({ url: `/api/clients/${other.id}/orders`, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/stores/${client.storeId}/clients`, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/reconciliations', headers: { cookie }, payload: {
      managerId: client.managerId, clientId: client.id, date: '2026-10-13', direction: 'ADJUST_IN', amount: 10, note: '线下已发生往来',
    } })).statusCode).toBe(403);
  } finally { await app.close(); }
});

it('records a completed offline adjustment exactly once across request retries', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
  try {
    const hq = await login(app, 'admin');
    const operator = await login(app, 'dianzhang');
    const customer = await login(app, 'user');
    const identities = (await hq.inject('/api/bootstrap')).json();
    const manager = identities.managers.find((row: { id: string }) => row.id === operator.actor.managerId);
    const cookie = operator.cookie;
    const headers = { cookie, 'idempotency-key': randomUUID() };
    const created = await app.inject({ method: 'POST', url: '/api/clients', headers, payload: { name: '事后建档客户', managerId: manager.id } });
    expect(created.statusCode).toBe(201);
    const client = created.json();
    const payload = { clientId: client.id, managerId: manager.id, date: '2026-10-12', direction: 'ADJUST_IN', amount: 0.1, note: '线下收支核对补记' };
    const first = await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect((await app.inject({ url: `/api/clients/${client.id}/reconciliations`, headers })).json()).toHaveLength(1);
    const conflict = await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload: { ...payload, amount: 0.2 } });
    expect(conflict.statusCode).toBe(409);
    expect((await app.inject({ url: `/api/clients/${client.id}`, headers })).json().reconciliationBalance).toBe(0.1);
  } finally { await app.close(); }
});

it('serializes concurrent offline reductions, blocks overdrafts and replays a completed reduction without charging twice', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
  try {
    const operator = await login(app, 'dianzhang');
    const created = await operator.inject({ method: 'POST', url: '/api/clients', payload: { name: '并发收支核对客户' } });
    expect(created.statusCode).toBe(201);
    const clientId = created.json().id;
    const payload = { managerId: operator.actor.managerId, clientId, date: '2026-10-13', direction: 'ADJUST_IN', amount: 1, note: '已完成线下收款' };
    expect((await operator.inject({ method: 'POST', url: '/api/reconciliations', payload })).statusCode).toBe(201);
    const reduction = { ...payload, direction: 'ADJUST_OUT', amount: 0.6, note: '已完成线下支用核减' };
    const keys = [randomUUID(), randomUUID()];
    const responses = await Promise.all(keys.map(key => operator.inject({ method: 'POST', url: '/api/reconciliations', headers: { 'idempotency-key': key }, payload: reduction })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const completed = responses.findIndex(response => response.statusCode === 201);
    const blocked = responses.find(response => response.statusCode === 409)!;
    expect(blocked.json().error).toContain('核减金额超过当前对账结余');
    const replay = await operator.inject({ method: 'POST', url: '/api/reconciliations', headers: { 'idempotency-key': keys[completed]! }, payload: reduction });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(responses[completed]!.json());
    expect((await operator.inject(`/api/clients/${clientId}`)).json().reconciliationBalance).toBe(0.4);
    expect((await operator.inject(`/api/clients/${clientId}/reconciliations`)).json()).toHaveLength(2);
    expect((await operator.inject({ method: 'POST', url: '/api/reconciliations', payload: { ...reduction, amount: 0.4 } })).statusCode).toBe(201);
    expect((await operator.inject({ method: 'POST', url: '/api/reconciliations', payload: { ...reduction, amount: 0.01 } })).statusCode).toBe(409);
    expect((await operator.inject(`/api/clients/${clientId}`)).json().reconciliationBalance).toBe(0);
    expect((await operator.inject(`/api/clients/${clientId}/reconciliations`)).json()).toHaveLength(3);
  } finally { await app.close(); }
});

it('accepts only one body for concurrent requests sharing an idempotency key', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
  try {
    const operator = await login(app, 'dianzhang');
    const client = (await operator.inject({ method: 'POST', url: '/api/clients', payload: { name: '并发重试核对客户' } })).json();
    const headers = { 'idempotency-key': randomUUID() };
    const payload = { managerId: operator.actor.managerId, clientId: client.id, date: '2026-10-13', direction: 'ADJUST_IN', note: '线下收款事后登记' };
    const responses = await Promise.all([0.1, 0.2].map(amount => operator.inject({ method: 'POST', url: '/api/reconciliations', headers, payload: { ...payload, amount } })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const entry = responses.find(response => response.statusCode === 201)!.json();
    expect((await operator.inject(`/api/clients/${client.id}`)).json().reconciliationBalance).toBe(entry.amount);
    expect((await operator.inject(`/api/clients/${client.id}/reconciliations`)).json()).toEqual([entry]);
  } finally { await app.close(); }
});

it('rolls back both the balance and appended audit if persisting the retry receipt fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reconciliation-http-rollback-'));
  const databasePath = join(directory, 'app.db');
  const app = await buildApp({ databasePath, today: '2026-10-13', ...authOptions });
  const control = new DatabaseSync(databasePath);
  try {
    const operator = await login(app, 'dianzhang');
    const client = (await operator.inject({ method: 'POST', url: '/api/clients', payload: { name: '事务核对客户' } })).json();
    control.exec(`CREATE TRIGGER test_receipt_failure BEFORE INSERT ON records
      WHEN NEW.kind = 'reconciliation_request'
      BEGIN SELECT RAISE(ABORT, 'simulated retry receipt storage failure'); END;`);
    const request = { method: 'POST' as const, url: '/api/reconciliations', headers: { 'idempotency-key': randomUUID() },
      payload: { managerId: operator.actor.managerId, clientId: client.id, date: '2026-10-13', direction: 'ADJUST_IN', amount: 0.3, note: '已完成线下往来收款' } };
    expect((await operator.inject(request)).statusCode).toBe(500);
    expect((await operator.inject(`/api/clients/${client.id}`)).json().reconciliationBalance).toBe(0);
    expect((await operator.inject(`/api/clients/${client.id}/reconciliations`)).json()).toEqual([]);
    control.exec('DROP TRIGGER test_receipt_failure');
    const retry = await operator.inject(request);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().balanceAfter).toBe(0.3);
    expect((await operator.inject(`/api/clients/${client.id}/reconciliations`)).json()).toEqual([retry.json()]);
  } finally { control.close(); await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('connects introductions, precise retrospective records, custody and HQ audits through scoped HTTP interfaces', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
  try {
    const hq = await login(app, 'admin');
    const operator = await login(app, 'dianzhang');
    const customer = await login(app, 'user');
    const identities = (await hq.inject('/api/bootstrap')).json();
    const source = identities.clients.find((row: { id: string }) => row.id === customer.actor.clientId);
    const cookie = operator.cookie;
    const headers = { cookie };
    const created = await app.inject({ method: 'POST', url: '/api/clients', headers, payload: { name: '引荐归档', introducedByClientId: source.id, date: '2026-10-13' } });
    expect(created.statusCode).toBe(201);
    const client = created.json();
    expect(client).toMatchObject({ storeId: source.storeId, managerId: source.managerId, introducedByClientId: source.id, reconciliationBalance: 0 });
    const input = { managerId: source.managerId, clientId: client.id, date: '2026-10-12', direction: 'ADJUST_IN', amount: 0.3, note: '事后登记线下收支' };
    expect((await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload: input })).statusCode).toBe(201);
    const out = await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload: { ...input, direction: 'ADJUST_OUT', amount: 0.1 } });
    expect(out.json().balanceAfter).toBe(0.2);
    const negative = await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload: { ...input, direction: 'ADJUST_OUT', amount: 1 } });
    expect(negative.statusCode).toBe(409);
    const clientLedger = await app.inject({ url: `/api/clients/${client.id}/reconciliations`, headers });
    expect(clientLedger.json()).toHaveLength(2);
    expect((await app.inject({ url: `/api/stores/${source.storeId}/reconciliations`, headers })).json().filter((row: {clientId:string}) => row.clientId === client.id)).toHaveLength(2);
    const orderResponse = await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { managerId: source.managerId, clientId: client.id, date: '2026-10-13', selectedCode: '038', adoptedStrategy: false, quantity: 1, totalAmount: 2 } });
    expect(orderResponse.statusCode).toBe(201);
    const order = orderResponse.json();
    expect(order.voucherStatus).toBe('StoredInShop');
    const claim = { method: 'PATCH' as const, url: `/api/orders/${order.id}/voucher-status`, headers, payload: { voucherStatus: 'Claimed' } };
    expect((await app.inject(claim)).json().voucherStatus).toBe('Claimed');
    expect((await app.inject(claim)).statusCode).toBe(200);
    expect((await app.inject({ ...claim, payload: { voucherStatus: 'StoredInShop' } })).statusCode).toBe(409);
    expect((await app.inject({ url: `/api/clients/${client.id}`, headers })).json().reconciliationBalance).toBe(0.2);
    // Newly created archives do not grant an account; the existing customer sees only its bound archive.
    const personalOrder = await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { managerId: source.managerId, clientId: source.id, date: '2026-10-13', selectedCode: '038', adoptedStrategy: false, quantity: 1, totalAmount: 2 } });
    expect(personalOrder.statusCode).toBe(201);
    expect((await app.inject({ ...claim, url: `/api/orders/${personalOrder.json().id}/voucher-status` })).statusCode).toBe(200);
    const clientCookie = customer.cookie;
    const personalHistory = await app.inject({ url: `/api/clients/${source.id}/orders`, headers: { cookie: clientCookie } });
    expect(personalHistory.json().find((row: { id: string }) => row.id === personalOrder.json().id)).toMatchObject({ voucherStatus: 'Claimed' });
    expect((await app.inject({ url: `/api/clients/${client.id}/orders`, headers: { cookie: clientCookie } })).statusCode).toBe(403);
    expect((await app.inject({ ...claim, headers: { cookie: clientCookie } })).statusCode).toBe(403);
    const hqCookie = hq.cookie;
    const audit = (await app.inject({ url: '/api/hq/attribution-audits?date=2026-10-13', headers: { cookie: hqCookie } })).json();
    expect(audit.audits.find((row: {clientId:string}) => row.clientId === client.id)).toMatchObject({ managerId: source.managerId, introducedByClientId: source.id });
    expect(audit.summary.some((row: {introducedCount:number}) => row.introducedCount >= 1)).toBe(true);
    expect(audit.totals.some((row: {managerId:string;clientCount:number}) => row.managerId === source.managerId && row.clientCount >= 4)).toBe(true);
    const hqLedger = (await app.inject({ url: `/api/hq/reconciliations?date=2026-10-12&managerId=${source.managerId}&storeId=${source.storeId}`, headers: { cookie: hqCookie } })).json();
    expect(hqLedger.filter((row: {clientId:string}) => row.clientId === client.id)).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: '/api/reconciliations', headers: { cookie: hqCookie }, payload: input })).statusCode).toBe(403);
  } finally { await app.close(); }
});

it('rejects cross-store, forged operators, future records and removed demo switches without writes', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
  try {
    const hq = await login(app, 'admin');
    const operator = await login(app, 'dianzhang');
    const { clients, managers } = (await hq.inject('/api/bootstrap')).json();
    const manager = managers.find((row: { id: string }) => row.id === operator.actor.managerId);
    const client = clients.find((row: {managerId:string}) => row.managerId === manager.id);
    const foreign = clients.find((row: {storeId:string}) => row.storeId !== manager.storeId);
    const cookie = operator.cookie;
    const headers = { cookie };
    for (const url of [`/api/clients/${foreign.id}`, `/api/stores/${foreign.storeId}/orders`, '/api/hq/attribution-audits', '/api/hq/reconciliations']) {
      expect((await app.inject({ url, headers })).statusCode).toBe(403);
    }
    for (const payload of [
      { name: '越权', managerId: foreign.managerId }, { name: '越权', storeId: foreign.storeId },
      { name: '越权', introducedByClientId: foreign.id },
    ]) expect((await app.inject({ method: 'POST', url: '/api/clients', headers, payload })).statusCode).toBe(403);
    const adjustment = { managerId: manager.id, clientId: client.id, date: '2026-10-13', direction: 'ADJUST_IN', amount: 1, note: '已发生调整' };
    for (const [patch, expected] of [
      [{ managerId: foreign.managerId }, 403], [{ clientId: foreign.id }, 403],
      [{ date: '2026-10-14' }, 400], [{ amount: 0.001 }, 400], [{ note: ' ' }, 400],
    ] as const) expect((await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload: { ...adjustment, ...patch } })).statusCode).toBe(expected);
    expect((await app.inject({ method: 'POST', url: '/api/clients', headers, payload: { name: '未来', date: '2026-10-14' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/demo/session', payload: { role: 'Client', clientId: randomUUID() } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/demo/session', payload: { role: 'Manager', managerId: randomUUID() } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/demo/session', payload: { role: 'Unknown' } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/bootstrap', headers: { cookie: 'app_session=forged' } })).statusCode).toBe(401);
    const next = (await login(app, 'admin', cookie)).cookie;
    expect((await app.inject({ url: '/api/bootstrap', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/bootstrap', headers: { cookie: next } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/orders/follow', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/referrals/share', payload: {} })).statusCode).toBe(404);
  } finally { await app.close(); }
});
