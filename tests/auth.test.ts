import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app/app.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/shared/database.ts';
import { createStoreModule } from '../src/modules/store/index.ts';
import { createStrategyModule } from '../src/modules/strategy/index.ts';
import { createRegistryModule } from '../src/modules/registry/index.ts';
import { createReconciliationModule } from '../src/modules/reconciliation/index.ts';

const password = 'Test-only-password-42';

async function signIn(app: Awaited<ReturnType<typeof buildApp>>, username: string, previous?: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, headers: previous ? { cookie: previous } : {} });
  expect(response.statusCode).toBe(200);
  return { actor: response.json(), cookie: String(response.headers['set-cookie']).split(';')[0]!, header: response.headers['set-cookie'] };
}

it('requires authentication by default and binds a successful login to the client account', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', bootstrapPassword: password });
  try {
    expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'user', password } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ role: 'client', username: 'user' });
    expect(login.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict');
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const state = (await app.inject({ url: '/api/bootstrap', headers: { cookie } })).json();
    expect(state.role).toBe('client');
    expect(state.clients.map((client: { id: string }) => client.id)).toEqual([login.json().clientId]);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).json()).toEqual(login.json());
  } finally { await app.close(); }
});

it('returns exactly the account-bound lowercase role and ignores attempted identity switches outside login', async () => {
  const app = await buildApp({ databasePath: ':memory:', bootstrapPassword: password });
  try {
    for (const [username, role] of [['user', 'client'], ['dianzhang', 'manager'], ['admin', 'hq']]) {
      const session = await signIn(app, username!);
      expect(session.actor.role).toBe(role);
      const headers = { cookie: session.cookie, 'x-role': 'hq', 'x-client-id': randomUUID(), 'x-manager-id': randomUUID() };
      expect((await app.inject({ url: `/api/auth/me?role=hq&clientId=${randomUUID()}&managerId=${randomUUID()}`, headers })).json()).toEqual(session.actor);
      const bootstrap = (await app.inject({ url: '/api/bootstrap?role=hq', headers })).json();
      expect(bootstrap.role).toBe(role);
      if (role !== 'hq') {
        expect(bootstrap.managers.map((manager: { id: string }) => manager.id)).toEqual([session.actor.managerId]);
        expect(bootstrap.stores.map((store: { id: string }) => store.id)).toEqual([session.actor.storeId]);
      }
      for (const field of ['role', 'clientId', 'managerId', 'subjectId']) {
        expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, [field]: 'forged' } })).statusCode).toBe(400);
      }
    }
  } finally { await app.close(); }
});

it('defaults new API routes to denied and keeps HEAD reads under the same role policy', async () => {
  const app = await buildApp({ databasePath: ':memory:', bootstrapPassword: password });
  app.get('/api/missing-policy', async () => ({ secret: 'must not be sent' }));
  app.patch('/api/missing-policy', async () => ({ changed: true }));
  try {
    expect((await app.inject('/api/missing-policy')).statusCode).toBe(401);
    for (const username of ['user', 'dianzhang', 'admin']) {
      const session = await signIn(app, username);
      const headers = { cookie: session.cookie };
      expect((await app.inject({ url: '/api/missing-policy', headers })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url: '/api/missing-policy', headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'HEAD', url: '/api/hq/reconciliations', headers })).statusCode).toBe(username === 'admin' ? 200 : 403);
    }
  } finally { await app.close(); }
});

it('checks browser write origins including scheme while preserving native requests without Origin', async () => {
  const app = await buildApp({ databasePath: ':memory:', bootstrapPassword: password, secureCookies: true });
  try {
    const login = { method: 'POST' as const, url: '/api/auth/login', payload: { username: 'user', password } };
    for (const origin of ['http://app.example', 'https://other.example', 'null', 'https://app.example/path', 'https://user@app.example']) {
      expect((await app.inject({ ...login, headers: { host: 'app.example', origin } })).statusCode, origin).toBe(403);
    }
    for (const site of ['cross-site', 'same-site']) {
      expect((await app.inject({ ...login, headers: { host: 'app.example', 'sec-fetch-site': site } })).statusCode).toBe(403);
    }
    const browser = await app.inject({ ...login, headers: { host: 'app.example:443', origin: 'https://app.example', 'sec-fetch-site': 'same-origin' } });
    expect(browser.statusCode).toBe(200);
    const native = await app.inject({ ...login, headers: { host: 'app.example' } });
    expect(native.statusCode).toBe(200);
  } finally { await app.close(); }
});

it('isolates same-store colleagues across directories, history, balances, summaries and mutations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-colleagues-'));
  const databasePath = join(directory, 'app.db');
  const db = createDatabase(databasePath);
  const stores = createStoreModule(db);
  const strategy = createStrategyModule(db);
  const registry = createRegistryModule(db, stores, strategy);
  const reconciliation = createReconciliationModule(db, stores);
  const store = stores.addStore({ id: randomUUID(), name: '同店不同归属' });
  const manager = stores.addManager({ id: '10000000-0000-4000-8000-000000000001', storeId: store.id, name: '当前店长' });
  const colleague = stores.addManager({ id: '10000000-0000-4000-8000-000000000002', storeId: store.id, name: '同店其他店长' });
  const records = [manager, colleague].map((owner, index) => {
    const client = stores.addClient({ id: randomUUID(), managerId: owner.id, name: `归属客户${index + 1}`, date: '2026-10-12' });
    const order = registry.registerOrder(owner.id, { id: randomUUID(), storeId: store.id, clientId: client.id, date: '2026-10-12', selectedCode: '038', adoptedStrategy: false, quantity: index + 1, totalAmount: 2 * (index + 1), createdAt: new Date() });
    reconciliation.adjust({ managerId: owner.id, clientId: client.id, date: '2026-10-12', direction: 'ADJUST_IN', amount: 10 * (index + 1), note: '已在线下完成的收款登记' });
    return { client, order };
  });
  registry.recordResolution({ date: '2026-10-12', settlementCode: '038', quotaPerUnit: 1040 });
  db.close();
  const app = await buildApp({ databasePath, seed: false, today: '2026-10-13', bootstrapPassword: password });
  try {
    const operator = await signIn(app, 'dianzhang');
    const hq = await signIn(app, 'admin');
    const customer = await signIn(app, 'user');
    const headers = { cookie: operator.cookie };
    const [own, foreign] = records;
    const bootstrap = (await app.inject({ url: '/api/bootstrap', headers })).json();
    expect(bootstrap.demo).toBe(false);
    expect(bootstrap.managers.map((row: { id: string }) => row.id)).toEqual([manager.id]);
    expect(bootstrap.clients.map((row: { id: string }) => row.id)).toEqual([own!.client.id]);
    expect((await app.inject({ url: `/api/stores/${store.id}/clients`, headers })).json().map((row: { id: string }) => row.id)).toEqual([own!.client.id]);
    for (const resource of ['orders', 'bills', 'reconciliations']) {
      const result = (await app.inject({ url: `/api/stores/${store.id}/${resource}`, headers })).json();
      expect(result).toHaveLength(1);
      expect(result[0].clientId).toBe(own!.client.id);
    }
    expect((await app.inject({ url: `/api/stores/${store.id}/summary`, headers })).json()).toMatchObject({ orderCount: 1, settledCount: 1, totalAmount: 2, grossGain: 1040 });
    expect((await app.inject({ url: `/api/stores/${store.id}/summary`, headers: { cookie: hq.cookie } })).json()).toMatchObject({ orderCount: 2, settledCount: 2, totalAmount: 6, grossGain: 3120 });
    for (const cookie of [operator.cookie, customer.cookie]) {
      for (const resource of ['', '/orders', '/reconciliations']) {
        expect((await app.inject({ url: `/api/clients/${foreign!.client.id}${resource}`, headers: { cookie } })).statusCode).toBe(403);
      }
    }
    const before = (await app.inject({ url: `/api/clients/${foreign!.client.id}`, headers: { cookie: hq.cookie } })).json();
    expect((await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload: { managerId: manager.id, clientId: foreign!.client.id, date: '2026-10-13', direction: 'ADJUST_IN', amount: 1, note: '拒绝跨归属调整' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { managerId: manager.id, clientId: foreign!.client.id, date: '2026-10-13', selectedCode: '038', adoptedStrategy: false, quantity: 1, totalAmount: 2 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/clients', headers, payload: { name: '拒绝跨归属引荐', introducedByClientId: foreign!.client.id } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/orders/${foreign!.order.orderSlip.id}/voucher-status`, headers, payload: { voucherStatus: 'Claimed' } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/clients/${foreign!.client.id}`, headers: { cookie: hq.cookie } })).json()).toEqual(before);
    expect((await app.inject({ url: `/api/clients/${foreign!.client.id}/orders`, headers: { cookie: hq.cookie } })).json()[0].voucherStatus).toBe('StoredInShop');
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('returns 403 for cross-store adjustment and voucher mutations without changing records', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', bootstrapPassword: password });
  try {
    const hq = await signIn(app, 'admin');
    const manager = await signIn(app, 'dianzhang');
    const directory = (await app.inject({ url: '/api/bootstrap', headers: { cookie: hq.cookie } })).json();
    const foreign = directory.clients.find((client: {storeId: string}) => client.storeId !== manager.actor.storeId);
    const headers = { cookie: manager.cookie };
    const adjustment = await app.inject({ method: 'POST', url: '/api/reconciliations', headers, payload: { managerId: manager.actor.managerId, clientId: foreign.id, date: '2026-10-13', direction: 'ADJUST_OUT', amount: 1, note: '越权应拒绝' } });
    expect(adjustment.statusCode).toBe(403);
    const history = (await app.inject({ url: `/api/clients/${foreign.id}/orders`, headers: { cookie: hq.cookie } })).json();
    const claim = await app.inject({ method: 'PATCH', url: `/api/orders/${history[0].id}/voucher-status`, headers, payload: { voucherStatus: 'Claimed' } });
    expect(claim.statusCode).toBe(403);
    expect((await app.inject({ url: `/api/clients/${foreign.id}`, headers: { cookie: hq.cookie } })).json()).toEqual(foreign);
  } finally { await app.close(); }
});

it('denies anonymous and wrong-role API calls before parsing their business payloads', async () => {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', bootstrapPassword: password });
  try {
    expect((await app.inject({ method: 'POST', url: '/api/orders', payload: {} })).statusCode).toBe(401);
    for (const username of ['user', 'dianzhang', 'admin']) {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const paths = username === 'user' ? ['/api/clients', '/api/reconciliations', '/api/orders', '/api/stores', '/api/managers', '/api/portfolios', '/api/resolutions']
        : username === 'dianzhang' ? ['/api/stores', '/api/managers', '/api/portfolios', '/api/resolutions']
          : ['/api/clients', '/api/reconciliations', '/api/orders'];
      for (const url of paths) expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: {} })).statusCode, `${username} ${url}`).toBe(403);
    }
  } finally { await app.close(); }
});

it('throttles repeated password guesses and permits a fresh attempt after the cooldown', async () => {
  const app = await buildApp({ databasePath: ':memory:', bootstrapPassword: password });
  const realNow = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'user', password: 'wrong-password' } });
      expect(failed.statusCode).toBe(401);
      expect(failed.json().error).toBe('账号或密码不正确');
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'user', password } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    clock.mockReturnValue(realNow + 15 * 60 * 1000 + 1);
    await signIn(app, 'user');
  } finally { clock.mockRestore(); await app.close(); }
});

it('revokes the previous session on login and logout, expires sessions and uses secure cookies when configured', async () => {
  const app = await buildApp({ databasePath: ':memory:', bootstrapPassword: password, secureCookies: true });
  const clock = vi.spyOn(Date, 'now');
  try {
    const first = await signIn(app, 'user');
    expect(first.header).toContain('; Secure');
    const next = await signIn(app, 'admin', first.cookie);
    expect(next.cookie).not.toBe(first.cookie);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: next.cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0; Secure');
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: next.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(200);
    const expires = await signIn(app, 'user');
    clock.mockReturnValue(Date.now() + 8 * 60 * 60 * 1000 + 1);
    expect((await app.inject({ url: '/api/bootstrap', headers: { cookie: expires.cookie } })).statusCode).toBe(401);
    await signIn(app, 'admin');
  } finally { clock.mockRestore(); await app.close(); }
});

it('rejects forged roles, removed demo identity endpoints, invalid credentials and cross-origin login', async () => {
  const app = await buildApp({ databasePath: ':memory:', bootstrapPassword: password });
  try {
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'unknown', password } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: '账号或密码不正确' });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'user', password, role: 'HQ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://other.example' }, payload: { username: 'admin', password } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/bootstrap', headers: { cookie: 'app_session=forged; demo_session=forged' } })).statusCode).toBe(401);
    expect((await app.inject('/api/demo/identities')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/demo/session', payload: { role: 'HQ' } })).statusCode).toBe(404);
    const manager = await signIn(app, 'dianzhang');
    for (const url of ['/api/calendar', '/api/portfolios/2026-10-13', '/api/hq/reconciliations']) expect((await app.inject({ url, headers: { cookie: manager.cookie } })).statusCode).toBe(403);
  } finally { await app.close(); }
});

it('preserves account credentials and bindings after reopening while discarding process sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-persistence-'));
  const databasePath = join(directory, 'app.db');
  try {
    const first = await buildApp({ databasePath, bootstrapPassword: password });
    const initial = await signIn(first, 'user');
    await first.close();
    const reopened = await buildApp({ databasePath, seed: false, bootstrapPassword: 'Should-not-reset-existing-accounts' });
    try {
      expect((await reopened.inject({ url: '/api/auth/me', headers: { cookie: initial.cookie } })).statusCode).toBe(401);
      const restored = await signIn(reopened, 'user');
      expect(restored.actor).toEqual(initial.actor);
      expect((await reopened.inject({ url: '/api/bootstrap', headers: { cookie: restored.cookie } })).json().demo).toBe(true);
      const bad = await reopened.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'user', password: 'Should-not-reset-existing-accounts' } });
      expect(bad.statusCode).toBe(401);
    } finally { await reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('can bootstrap a real empty store without requiring a customer before the manager can log in', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-empty-'));
  const options = { databasePath: join(directory, 'app.db'), seed: false, bootstrapPassword: password };
  let app = await buildApp(options);
  try {
    const hq = await signIn(app, 'admin');
    const store = (await app.inject({ method: 'POST', url: '/api/stores', headers: { cookie: hq.cookie }, payload: { name: '空库初始化门店' } })).json();
    const manager = (await app.inject({ method: 'POST', url: '/api/managers', headers: { cookie: hq.cookie }, payload: { storeId: store.id, name: '首位店长' } })).json();
    await app.close();
    app = await buildApp(options);
    const managerSession = await signIn(app, 'dianzhang');
    expect(managerSession.actor.managerId).toBe(manager.id);
    const client = await app.inject({ method: 'POST', url: '/api/clients', headers: { cookie: managerSession.cookie }, payload: { name: '首位客户档案' } });
    expect(client.statusCode).toBe(201);
    await app.close();
    app = await buildApp(options);
    const clientSession = await signIn(app, 'user');
    expect(clientSession.actor.clientId).toBe(client.json().id);
    expect((await app.inject({ url: `/api/clients/${client.json().id}/orders`, headers: { cookie: clientSession.cookie } })).json()).toEqual([]);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
