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

  it('supports client placing custom order, querying own order history, and allows manager & HQ to query it', async () => {
    const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
    try {
      const clientUser = await login(app, 'user');
      const managerUser = await login(app, 'dianzhang');
      const hqUser = await login(app, 'admin');

      // 1. Client places a custom pick order (selectedCode: 777, not in strategy combos)
      const res = await clientUser.inject({
        method: 'POST',
        url: '/api/client/orders',
        payload: { selectedCode: '777', quantity: 2, multiplier: 3, adoptedStrategy: false },
      });
      expect(res.statusCode).toBe(201);
      const order = res.json();
      expect(order.selectedCode).toBe('777');
      expect(order.adoptedStrategy).toBe(false);
      expect(order.totalAmount).toBe(12); // 2 * 3 * 2 = 12

      // 2. Client queries own order history
      const clientOrders = (await clientUser.inject(`/api/clients/${clientUser.actor.clientId}/orders`)).json();
      expect(clientOrders.some((o: { selectedCode: string }) => o.selectedCode === '777')).toBe(true);

      // 3. Manager queries store orders and sees client's custom order
      const storeOrders = (await managerUser.inject(`/api/stores/${managerUser.actor.storeId}/orders`)).json();
      expect(storeOrders.some((o: { selectedCode: string }) => o.selectedCode === '777')).toBe(true);

      // 4. HQ queries all platform orders and sees the order
      const hqOrders = (await hqUser.inject('/api/hq/orders')).json();
      expect(hqOrders.some((o: { selectedCode: string }) => o.selectedCode === '777')).toBe(true);

      // 5. Manager updates voucher status to Claimed
      const claimRes = await managerUser.inject({
        method: 'PATCH',
        url: `/api/orders/${order.id}/voucher-status`,
        payload: { voucherStatus: 'Claimed' },
      });
      expect(claimRes.statusCode).toBe(200);
      expect(claimRes.json().voucherStatus).toBe('Claimed');
    } finally { await app.close(); }
  });

  it('supports group betting (组选) and validates leopard rejection & resolution hits', async () => {
    const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', ...authOptions });
    try {
      const clientUser = await login(app, 'user');
      const hqUser = await login(app, 'admin');

      // 1. Group bet with leopard number (e.g. 888) is rejected
      const leopardRes = await clientUser.inject({
        method: 'POST',
        url: '/api/client/orders',
        payload: { selectedCode: '888', quantity: 1, multiplier: 1, adoptedStrategy: false, betMode: 'GROUP' },
      });
      expect(leopardRes.statusCode).toBe(400);
      expect(leopardRes.json().error).toContain('豹子号');

      // 2. Group bet 组选六 (123) and 组选三 (112)
      const group6Res = await clientUser.inject({
        method: 'POST',
        url: '/api/client/orders',
        payload: { selectedCode: '123', quantity: 1, multiplier: 1, adoptedStrategy: false, betMode: 'GROUP' },
      });
      expect(group6Res.statusCode).toBe(201);
      const group6Order = group6Res.json();
      expect(group6Order.betMode).toBe('GROUP');

      const group3Res = await clientUser.inject({
        method: 'POST',
        url: '/api/client/orders',
        payload: { selectedCode: '112', quantity: 1, multiplier: 1, adoptedStrategy: false, betMode: 'GROUP' },
      });
      expect(group3Res.statusCode).toBe(201);
      const group3Order = group3Res.json();
      expect(group3Order.betMode).toBe('GROUP');

      // Direct bet with 123 for comparison
      const directRes = await clientUser.inject({
        method: 'POST',
        url: '/api/client/orders',
        payload: { selectedCode: '123', quantity: 1, multiplier: 1, adoptedStrategy: false, betMode: 'DIRECT' },
      });
      expect(directRes.statusCode).toBe(201);
      const directOrder = directRes.json();
      expect(directOrder.betMode).toBe('DIRECT');

      // 3. Official resolution draws 321
      // 123 (GROUP) should hit as 组选六 with quota 173
      // 123 (DIRECT) should miss
      const res = await hqUser.inject({
        method: 'POST',
        url: '/api/resolutions',
        payload: { date: '2026-10-13', settlementCode: '321', quotaPerUnit: 1040 },
      });
      expect(res.statusCode).toBe(200);

      const bills = (await hqUser.inject('/api/hq/orders')).json();
      const foundGroup6 = bills.find((o: { id: string }) => o.id === group6Order.id);
      expect(foundGroup6).toBeDefined();

      // Check store bills for client net gain
      const storeBills = (await hqUser.inject(`/api/stores/${clientUser.actor.storeId}/bills`)).json();
      const group6Bill = storeBills.find((b: { orderSlipId: string }) => b.orderSlipId === group6Order.id);
      expect(group6Bill).toBeDefined();
      // Hit quota for 组选六 is 173; net gain is 173 - 2 = 171.
      // Since adoptedStrategy is false (custom pick), no service fee is charged, client keeps 100% of net gain: 171
      expect(group6Bill.clientNetGain).toBe(171);

      // Direct order 123 vs 321 did not hit, so grossGain and clientNetGain are 0
      const directBill = storeBills.find((b: { orderSlipId: string }) => b.orderSlipId === directOrder.id);
      expect(directBill?.grossGain).toBe(0);
      expect(directBill?.clientNetGain).toBe(0);
    } finally { await app.close(); }
  });
});
