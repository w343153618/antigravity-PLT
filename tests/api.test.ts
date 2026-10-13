import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app/app.ts';
import { businessDate } from '../src/app/app.ts';
import { readServerConfig } from '../src/app/config.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/shared/database.ts';
import { createStoreModule } from '../src/modules/store/index.ts';
import { authOptions, login } from './helpers/auth.ts';

describe('HTTP application', () => {
  it('boots with explicitly labelled demo data and hosts the Vue application', async () => {
    const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
    try {
      expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
      const hq = await login(app, 'admin');
      const bootstrap = await hq.inject('/api/bootstrap');
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json()).toMatchObject({ today: '2026-10-13', demo: true });
      expect(bootstrap.json().stores).toHaveLength(2);
      const calendar = await hq.inject('/api/calendar?endDate=2026-10-13');
      expect(calendar.statusCode).toBe(200);
      expect(calendar.json()).toHaveLength(30);
      expect(calendar.json().at(-1).status).toBeNull();
      const page = await app.inject('/');
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      const vue = await app.inject('/vendor/vue.esm-browser.prod.js');
      expect(vue.statusCode).toBe(200);
      expect(vue.headers['content-type']).toContain('javascript');
    } finally { await app.close(); }
  });

  it('registers a manager order, resolves the date, and serves matching store bills', async () => {
    const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
    try {
      const hq = await login(app, 'admin');
      const operator = await login(app, 'dianzhang');
      const bootstrap = (await hq.inject('/api/bootstrap')).json();
      const manager = bootstrap.managers.find((row: { id: string }) => row.id === operator.actor.managerId);
      const clientsResponse = await hq.inject(`/api/stores/${manager.storeId}/clients`);
      expect(clientsResponse.statusCode).toBe(200);
      const client = clientsResponse.json()[0];
      const registration = await operator.inject({ method: 'POST', url: '/api/orders', payload: {
        managerId: manager.id, clientId: client.id, date: '2026-10-13', selectedCode: '279',
        quantity: 2, totalAmount: 4, adoptedStrategy: true,
      } });
      expect(registration.statusCode).toBe(201);
      const order = registration.json();
      expect(order).toMatchObject({ storeId: manager.storeId, clientId: client.id, selectedCode: '279' });
      const event = { date: '2026-10-13', settlementCode: '279', quotaPerUnit: 1040 };
      const resolution = await hq.inject({ method: 'POST', url: '/api/resolutions', payload: event });
      expect(resolution.statusCode).toBe(200);
      const bills = (await hq.inject(`/api/stores/${manager.storeId}/bills`)).json();
      expect(bills.find((bill: { orderSlipId: string }) => bill.orderSlipId === order.id)).toMatchObject({
        grossGain: 2080, netGain: 2076, performanceFee: 415.2, managerIncentive: 207.6, platformMargin: 207.6, clientNetGain: 1660.8,
      });
      const before = (await hq.inject(`/api/stores/${manager.storeId}/summary`)).json();
      expect((await hq.inject({ method: 'POST', url: '/api/resolutions', payload: event })).statusCode).toBe(200);
      expect((await hq.inject(`/api/stores/${manager.storeId}/summary`)).json()).toEqual(before);
      expect((await hq.inject('/api/calendar?endDate=2026-10-13')).json().at(-1).status).toBe('Hit');
    } finally { await app.close(); }
  });

  it('manages an empty store and publishes exactly three combinations through REST', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'empty-core-api-'));
    const databasePath = join(directory, 'app.db');
    try {
      // Establish account ownership through public modules before starting the app.
      const db = createDatabase(databasePath);
      try {
        const stores = createStoreModule(db);
        const branch = stores.addStore({ id: randomUUID(), name: '已有归属门店' });
        const owner = stores.addManager({ id: randomUUID(), storeId: branch.id, name: '已有店长' });
        stores.addClient({ id: randomUUID(), managerId: owner.id, name: '已有客户', date: '2026-10-13' });
      } finally { db.close(); }
      const app = await buildApp({ databasePath, seed: false, today: '2026-10-13', ...authOptions });
      try {
        const hq = await login(app, 'admin');
        const operator = await login(app, 'dianzhang');
        const storeResponse = await hq.inject({ method: 'POST', url: '/api/stores', payload: { name: '测试网点', address: '测试地址' } });
        expect(storeResponse.statusCode).toBe(201);
        const storeId = storeResponse.json().id;
        const managerResponse = await hq.inject({ method: 'POST', url: '/api/managers', payload: { storeId, name: '测试店长' } });
        expect(managerResponse.statusCode).toBe(201);
        expect((await operator.inject({ method: 'POST', url: '/api/clients', payload: { managerId: operator.actor.managerId, name: '测试客户' } })).statusCode).toBe(201);
        const publish = await hq.inject({ method: 'POST', url: '/api/portfolios', payload: { date: '2026-10-13', combos: ['038', '148', '350'].map((code) => ({ code, weight: 1 })) } });
        expect(publish.statusCode).toBe(201);
        expect((await hq.inject('/api/portfolios/2026-10-13')).json().combos[0].code).toBe('038');
        expect((await hq.inject(`/api/stores/${storeId}/orders`)).json()).toEqual([]);
        expect((await hq.inject(`/api/stores/${storeId}/summary`)).json()).toMatchObject({ totalAmount: 0, orderCount: 0, managerIncentive: 0 });
      } finally { await app.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects malformed requests, conflicting results and cross-store registration', async () => {
    const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
    try {
      const hq = await login(app, 'admin');
      const operator = await login(app, 'dianzhang');
      const { managers: directoryManagers } = (await hq.inject('/api/bootstrap')).json();
      const managers = [directoryManagers.find((row: { id: string }) => row.id === operator.actor.managerId), directoryManagers.find((row: { id: string }) => row.id !== operator.actor.managerId)];
      const ownClients = (await hq.inject(`/api/stores/${managers[0].storeId}/clients`)).json();
      const otherClients = (await hq.inject(`/api/stores/${managers[1].storeId}/clients`)).json();
      const base = { managerId: managers[0].id, clientId: ownClients[0].id, date: '2026-10-13', selectedCode: '279', quantity: 1, totalAmount: 2, adoptedStrategy: true };
      const malformed = await operator.inject({ method: 'POST', url: '/api/orders', payload: { ...base, quantity: 0 } });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error).toContain('quantity');
      expect((await operator.inject({ method: 'POST', url: '/api/orders', payload: { ...base, clientId: otherClients[0].id } })).statusCode).toBe(403);
      expect((await operator.inject({ method: 'POST', url: '/api/orders', payload: { ...base, managerId: '123e4567-e89b-42d3-a456-426614174000' } })).statusCode).toBe(403);
      expect((await operator.inject({ method: 'POST', url: '/api/orders', payload: { ...base, date: '2026-10-14' } })).statusCode).toBe(400);
      expect((await operator.inject({ method: 'POST', url: '/api/orders', payload: base, headers: { origin: 'https://unrelated.example' } })).statusCode).toBe(403);
      expect((await operator.inject({ method: 'POST', url: '/api/orders', payload: base, headers: { origin: 'null' } })).statusCode).toBe(403);
      expect((await operator.inject({ method: 'POST', url: '/api/orders', payload: '{broken', headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
      expect((await hq.inject('/api/calendar?endDate=invalid')).statusCode).toBe(400);
      expect((await hq.inject('/api/stores/invalid/summary')).statusCode).toBe(400);
      expect((await hq.inject('/api/portfolios/2026-10-14')).json()).toBeNull();
      expect((await hq.inject('/api/health')).json()).toEqual({ status: 'ok' });
      expect((await hq.inject('/api/calendar')).json()).toHaveLength(30);
      const resolution = { date: '2026-10-13', settlementCode: '279', quotaPerUnit: 1040 };
      expect((await hq.inject({ method: 'POST', url: '/api/resolutions', payload: resolution })).statusCode).toBe(200);
      expect((await hq.inject({ method: 'POST', url: '/api/resolutions', payload: { ...resolution, settlementCode: '148' } })).statusCode).toBe(409);
      expect((await operator.inject({ method: 'POST', url: '/api/orders', payload: base })).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it('reopens durable records without duplicating the demo seed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'core-api-'));
    const databasePath = join(directory, 'app.db');
    try {
      const first = await buildApp({ databasePath, today: '2026-10-13', ...authOptions });
      const firstSession = await login(first, 'admin');
      const initial = (await firstSession.inject('/api/bootstrap')).json();
      const storeId = initial.stores[0].id;
      const orders = (await firstSession.inject(`/api/stores/${storeId}/orders`)).json();
      await first.close();
      const reopened = await buildApp({ databasePath, today: '2026-10-13', ...authOptions });
      try {
        const reopenedSession = await login(reopened, 'admin');
        expect((await reopenedSession.inject('/api/bootstrap')).json()).toEqual(initial);
        expect((await reopenedSession.inject(`/api/stores/${storeId}/orders`)).json()).toEqual(orders);
      } finally { await reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses the Shanghai business date and parameterized high port configuration', () => {
    expect(businessDate(new Date('2026-10-12T16:01:00Z'))).toBe('2026-10-13');
    expect(readServerConfig({})).toEqual({ port: 19888, host: '127.0.0.1', databasePath: 'data/app.db', seed: true });
    expect(readServerConfig({ PORT: '28888', HOST: 'localhost', DATABASE_PATH: ':memory:', DEMO_SEED: 'false' })).toEqual({ port: 28888, host: 'localhost', databasePath: ':memory:', seed: false });
    for (const PORT of ['0', '80', '-1', '19888suffix', '65536', '']) expect(() => readServerConfig({ PORT })).toThrow();
  });

  it('protects /api/resolutions/auto-sync allowing only hq', async () => {
    const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
    try {
      const clientUser = await login(app, 'user');
      const managerUser = await login(app, 'dianzhang');
      const hqUser = await login(app, 'admin');

      const clientRes = await clientUser.inject({ method: 'POST', url: '/api/resolutions/auto-sync' });
      expect(clientRes.statusCode).toBe(403);

      const managerRes = await managerUser.inject({ method: 'POST', url: '/api/resolutions/auto-sync' });
      expect(managerRes.statusCode).toBe(403);

      const hqRes = await hqUser.inject({ method: 'POST', url: '/api/resolutions/auto-sync' });
      expect(hqRes.statusCode).toBe(200);
      expect(hqRes.json()).toHaveProperty('synced');
      expect(hqRes.json()).toHaveProperty('skipped');
    } finally { await app.close(); }
  });
});
