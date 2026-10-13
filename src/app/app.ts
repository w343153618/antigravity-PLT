import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { createDatabase } from '../shared/database.ts';
import { DomainError } from '../shared/errors.ts';
import { OrderSlipSchema, StrategyPortfolioSchema } from '../shared/schemas/index.ts';
import { StoreSchema, StoreManagerSchema, ClientSchema } from '../shared/schemas/store.ts';
import { createStoreModule } from '../modules/store/index.ts';
import { createStrategyModule } from '../modules/strategy/index.ts';
import { createRegistryModule } from '../modules/registry/index.ts';
import { seedDemo } from './seed.ts';
import { createReconciliationModule } from '../modules/reconciliation/index.ts';
import { ReconciliationAdjustmentSchema } from '../shared/schemas/reconciliation.ts';
import { VoucherStatusSchema } from '../shared/schemas/domain.ts';
import { createAccess, type Actor } from './access.ts';
import { syncOfficialResolutions } from '../modules/lottery-crawler/index.ts';

// Every API route is authorized by both method and registered path. Adding a
// route without an explicit policy cannot accidentally grant a role access.
const rolePolicies = new Map<string, readonly Actor['role'][]>([
  ['GET /api/auth/me', ['client', 'manager', 'hq']],
  ['GET /api/bootstrap', ['client', 'manager', 'hq']],
  ['GET /api/portfolios/:date', ['client', 'hq']],
  ['GET /api/calendar', ['client', 'hq']],
  ...['clients', 'orders', 'bills', 'summary', 'reconciliations'].map(resource =>
    [`GET /api/stores/:storeId/${resource}`, ['manager', 'hq']] as const),
  ...['', '/orders', '/reconciliations'].map(resource =>
    [`GET /api/clients/:clientId${resource}`, ['client', 'manager', 'hq']] as const),
  ...['clients', 'orders', 'reconciliations'].map(resource =>
    [`POST /api/${resource}`, ['manager']] as const),
  ...['stores', 'managers', 'portfolios', 'resolutions'].map(resource =>
    [`POST /api/${resource}`, ['hq']] as const),
  ['POST /api/resolutions/auto-sync', ['hq']],
  ['PATCH /api/orders/:orderId/voucher-status', ['manager']],
  ['PUT /api/portfolios/:date', ['hq']],
  ['POST /api/client/orders', ['client']],
  ['GET /api/hq/attribution-audits', ['hq']],
  ['GET /api/hq/reconciliations', ['hq']],
]);
const publicRoutes = new Set(['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/logout']);

export function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface AppOptions {
  databasePath?: string;
  seed?: boolean;
  today?: string;
  logger?: boolean;
  bootstrapPassword?: string;
  secureCookies?: boolean;
  autoSync?: boolean;
}

export async function buildApp(options: AppOptions = {}) {
  const currentDate = () => z.iso.date().parse(options.today ?? businessDate());
  currentDate();
  const db = createDatabase(options.databasePath ?? 'data/app.db');
  const stores = createStoreModule(db);
  const strategy = createStrategyModule(db);
  const registry = createRegistryModule(db, stores, strategy);
  const reconciliation = createReconciliationModule(db, stores);
  let access: Awaited<ReturnType<typeof createAccess>>;
  try {
    if (options.seed !== false) seedDemo(db, stores, strategy, registry, currentDate());
    stores.migrateLegacyClients(currentDate());
    access = await createAccess(db, stores, options);
  } catch (error) { db.close(); throw error; }

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32 * 1024 });

  const shouldAutoSync = options.autoSync ?? (process.env.NODE_ENV !== 'test');
  let syncTimeout: NodeJS.Timeout | undefined;
  if (shouldAutoSync) {
    const runSync = async () => {
      try {
        const result = await syncOfficialResolutions(registry, strategy);
        if (result.synced.length > 0) {
          app.log.info({ synced: result.synced }, '体彩官方开奖结果自动爬取同步成功并已完成核验判定');
        }
      } catch (err) {
        app.log.warn({ err }, '体彩官方开奖结果自动抓取轮询异常');
      }
    };

    // 1. 服务启动时立即无感执行一次抓取同步
    runSync().catch(() => {});

    // 2. 自适应定时轮询：体彩开奖核心窗口期（北京时间 21:15 - 22:30）每 2 分钟抓取一次，其余时段每 15 分钟抓取一次
    const getIntervalMs = () => {
      const now = new Date();
      const bjHour = (now.getUTCHours() + 8) % 24;
      const bjMinute = now.getUTCMinutes();
      const isDrawWindow = (bjHour === 21 && bjMinute >= 15) || (bjHour === 22 && bjMinute <= 30);
      return isDrawWindow ? 2 * 60 * 1000 : 15 * 60 * 1000;
    };

    const scheduleNext = () => {
      syncTimeout = setTimeout(async () => {
        await runSync();
        scheduleNext();
      }, getIntervalMs());
      syncTimeout.unref?.();
    };

    scheduleNext();
  }

  app.addHook('onClose', async () => {
    if (syncTimeout) clearTimeout(syncTimeout);
    db.close();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join('.') || '输入'}：${issue.message}`).join('；') });
    }
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof RangeError) return reply.code(422).send({ error: '金额超出可精确核算范围，请检查数量与金额' });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: '请求格式不正确，请检查后重试' });
    }
    request.log.error(error);
    return reply.code(500).send({ error: '服务暂时无法处理，请稍后重试' });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // Native clients may omit Origin. Browser requests must match the full
      // origin, including scheme; Secure mode represents the HTTPS proxy edge.
      if (['cross-site', 'same-site'].includes(String(request.headers['sec-fetch-site']))) {
        return reply.code(403).send({ error: '仅允许当前应用页面提交数据' });
      }
      if (request.headers.origin !== undefined) {
        let sameOrigin = false;
        try {
          const origin = new URL(request.headers.origin);
          const fwdHost = (request.headers['x-forwarded-host'] as string | undefined) || request.headers.host;
          const fwdProto = (request.headers['x-forwarded-proto'] as string | undefined) || (options.secureCookies ? 'https' : request.protocol);
          const expected = new URL(`${fwdProto}://${fwdHost}`);
          sameOrigin = origin.origin === request.headers.origin && origin.origin === expected.origin;
        } catch { return reply.code(403).send({ error: '请求来源无效' }); }
        if (!sameOrigin) return reply.code(403).send({ error: '仅允许当前应用页面提交数据' });
      }
    }
    const route = request.routeOptions.url ?? '';
    const policyKey = `${request.method === 'HEAD' ? 'GET' : request.method} ${route}`;
    if (route.startsWith('/api/') && !publicRoutes.has(policyKey)) {
      const actor = access.actor(request);
      if (!rolePolicies.get(policyKey)?.includes(actor.role)) throw new DomainError('当前账号无权访问此功能', 403);
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Frame-Options', 'DENY');
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/api/auth/login', async (request, reply) => access.login(request, reply));
  app.post('/api/auth/logout', async (request, reply) => access.logout(request, reply));
  app.get('/api/auth/me', async request => access.actor(request));
  app.get('/api/bootstrap', async request => {
    const actor = access.actor(request);
    const branches = stores.listStores().filter(store => !actor.storeId || store.id === actor.storeId);
    return { today: currentDate(), demo: db.get('meta', 'demo-seed-v1') !== undefined, role: actor.role, stores: branches,
      managers: stores.listManagers().filter(manager => actor.role === 'hq' || manager.id === actor.managerId),
      clients: branches.flatMap(store => stores.listClients(store.id)).filter(client =>
        actor.role === 'hq' || (actor.role === 'client' ? client.id === actor.clientId : client.managerId === actor.managerId)),
    };
  });
  app.get<{ Params: { date: string } }>('/api/portfolios/:date', async (request) => { access.reference(request); return strategy.getPortfolio(request.params.date) ?? null; });
  app.get<{ Querystring: { endDate?: string } }>('/api/calendar', async (request) => { access.reference(request); return strategy.getCalendar(request.query.endDate ?? currentDate()); });

  const storePath = z.strictObject({ storeId: z.uuid() });
  for (const resource of ['clients', 'orders', 'bills', 'summary', 'reconciliations'] as const) {
    app.get<{ Params: { storeId: string } }>(`/api/stores/:storeId/${resource}`, async request => {
      const { storeId } = storePath.parse(request.params); access.store(request, storeId);
      const actor = access.actor(request);
      const managerId = actor.role === 'manager' ? actor.managerId : undefined;
      if (resource === 'clients') return stores.listClients(storeId).filter(client => !managerId || client.managerId === managerId);
      if (resource === 'orders') return registry.listOrders(storeId, managerId).map(record => ({ ...record.orderSlip, managerId: record.managerId }));
      if (resource === 'bills') return registry.listBills(storeId, managerId);
      if (resource === 'summary') return registry.summarize(storeId, managerId);
      return reconciliation.listForStore(storeId).filter(entry => !managerId || entry.managerId === managerId);
    });
  }
  const clientPath = z.strictObject({ clientId: z.uuid() });
  app.get<{ Params: { clientId: string } }>('/api/clients/:clientId', async request => access.client(request, clientPath.parse(request.params).clientId));
  app.get<{ Params: { clientId: string } }>('/api/clients/:clientId/orders', async request => {
    const { clientId } = clientPath.parse(request.params); access.client(request, clientId);
    return registry.listClientOrders(clientId).map(record => ({ ...record.orderSlip, managerId: record.managerId }));
  });
  app.get<{ Params: { clientId: string } }>('/api/clients/:clientId/reconciliations', async request => {
    const { clientId } = clientPath.parse(request.params); access.client(request, clientId);
    return reconciliation.listForClient(clientId);
  });

  const createOrderSchema = OrderSlipSchema.omit({ id: true, storeId: true, createdAt: true }).extend({ managerId: z.uuid() });
  app.post('/api/orders', async (request, reply) => {
    const { managerId, ...input } = createOrderSchema.parse(request.body);
    access.manager(request, managerId);
    access.managedClient(request, input.clientId);
    const manager = stores.getManager(managerId);
    if (!manager) throw new DomainError('店长不存在，请刷新后选择', 404);
    if (input.date > currentDate()) throw new DomainError('只能登记今日或历史已发生的记录', 400);
    const registered = registry.registerOrder(managerId, { ...input, id: randomUUID(), storeId: manager.storeId, createdAt: new Date() });
    return reply.code(201).send({ ...registered.orderSlip, managerId });
  });
  app.post('/api/resolutions', async (request) => { access.hq(request); return registry.recordResolution(request.body); });
  app.post('/api/resolutions/auto-sync', async (request) => { access.hq(request); return syncOfficialResolutions(registry, strategy); });
  app.post('/api/portfolios', async (request, reply) => {
    access.hq(request);
    const input = StrategyPortfolioSchema.omit({ id: true, createdAt: true }).parse(request.body);
    return reply.code(201).send(strategy.publishPortfolio({ ...input, id: randomUUID(), createdAt: new Date() }));
  });
  app.put<{ Params: { date: string } }>('/api/portfolios/:date', async (request, reply) => {
    access.hq(request);
    const date = z.iso.date().parse(request.params.date);
    const updated = strategy.updatePortfolio(date, request.body);
    return reply.send(updated);
  });
  const clientOrderInput = z.strictObject({
    selectedCode: z.string().regex(/^\d{3}$/, '号码须为3位数字'),
    multiplier: z.number().int().min(1).max(9999),
    quantity: z.number().int().min(1).max(9999).default(1),
    adoptedStrategy: z.boolean().default(true),
  });
  app.post('/api/client/orders', async (request, reply) => {
    const actor = access.actor(request);
    if (actor.role !== 'client' || !actor.clientId) throw new DomainError('仅客户账号可在线下单跟单', 403);
    const input = clientOrderInput.parse(request.body);
    const clientRecord = stores.getClient(actor.clientId);
    if (!clientRecord) throw new DomainError('客户档案不存在', 404);
    if (!clientRecord.managerId) throw new DomainError('客户尚未绑定店长，请联系门店店长处理', 400);

    const unitPrice = 2; // 2元每注
    const totalCost = unitPrice * input.multiplier * input.quantity;
    if (clientRecord.reconciliationBalance < totalCost) {
      throw new DomainError(`预付余额不足。本次需支付 ¥${totalCost.toFixed(2)}，当前余额 ¥${clientRecord.reconciliationBalance.toFixed(2)}，请联系店长充值`, 422);
    }

    const today = currentDate();
    const order = db.transaction(() => {
      // 1. 扣减预存余额并写入对账流水
      reconciliation.adjust({
        managerId: clientRecord.managerId!,
        clientId: clientRecord.id,
        date: today,
        direction: 'ADJUST_OUT',
        amount: totalCost,
        note: `跟单扣款：排列三 ${input.selectedCode} × ${input.quantity}注 × ${input.multiplier}倍`,
      });
      // 2. 生成跟单存根记录
      const registered = registry.registerOrder(clientRecord.managerId!, {
        id: randomUUID(),
        storeId: clientRecord.storeId,
        clientId: clientRecord.id,
        date: today,
        selectedCode: input.selectedCode,
        quantity: input.quantity * input.multiplier,
        totalAmount: totalCost,
        adoptedStrategy: input.adoptedStrategy,
        voucherStatus: 'StoredInShop',
        createdAt: new Date(),
      });
      return registered.orderSlip;
    });

    return reply.code(201).send(order);
  });
  app.post('/api/stores', async (request, reply) => {
    access.hq(request); return reply.code(201).send(stores.addStore({ ...StoreSchema.omit({ id: true }).parse(request.body), id: randomUUID() }));
  });
  app.post('/api/managers', async (request, reply) => {
    access.hq(request); return reply.code(201).send(stores.addManager({ ...StoreManagerSchema.omit({ id: true }).parse(request.body), id: randomUUID() }));
  });
  const clientInput = z.strictObject({ name: ClientSchema.shape.name, storeId: z.uuid().optional(), managerId: z.uuid().optional(), introducedByClientId: z.uuid().optional(), date: z.iso.date().optional() });
  app.post('/api/clients', async (request, reply) => {
    const input = clientInput.parse(request.body);
    const actor = access.actor(request);
    {
      const managerId = access.manager(request, input.managerId);
      if (input.storeId && input.storeId !== actor.storeId) throw new DomainError('只能管理本店客户档案', 403);
      if (input.introducedByClientId) {
        const source = stores.getClient(input.introducedByClientId);
        if (!source || source.managerId !== managerId) throw new DomainError('引荐人须属于当前店长', 403);
      } else input.managerId = managerId;
    }
    const date = input.date ?? currentDate();
    if (date > currentDate()) throw new DomainError('建档日期不能在未来', 400);
    return reply.code(201).send(stores.addClient({ ...input, date, id: randomUUID() }));
  });
  app.post('/api/reconciliations', async (request, reply) => {
    const input = ReconciliationAdjustmentSchema.parse(request.body);
    access.manager(request, input.managerId);
    access.managedClient(request, input.clientId);
    if (input.date > currentDate()) throw new DomainError('仅登记已在线下发生的收支，日期不能在未来', 400);
    const key = z.uuid().optional().parse(request.headers['idempotency-key']);
    const entry = db.transaction(() => {
      if (!key) return reconciliation.adjust(input);
      const id = `${input.managerId}:${key}`;
      const signature = JSON.stringify(input);
      const previous = db.get('reconciliation_request', id) as { signature: string; entry: unknown } | undefined;
      if (previous) {
        if (previous.signature !== signature) throw new DomainError('重试标识已用于另一笔调整，请核对流水');
        return previous.entry;
      }
      const entry = reconciliation.adjust(input);
      db.insert('reconciliation_request', id, { signature, entry });
      return entry;
    });
    return reply.code(201).send(entry);
  });
  app.patch<{ Params: { orderId: string } }>('/api/orders/:orderId/voucher-status', async request => {
    const { orderId } = z.strictObject({ orderId: z.uuid() }).parse(request.params);
    const { voucherStatus } = z.strictObject({ voucherStatus: VoucherStatusSchema }).parse(request.body);
    const managerId = access.manager(request);
    const record = registry.updateVoucherStatus(managerId, orderId, voucherStatus);
    return { ...record.orderSlip, managerId: record.managerId };
  });
  const auditQuery = z.strictObject({ date: z.iso.date().optional(), managerId: z.uuid().optional(), storeId: z.uuid().optional() });
  app.get('/api/hq/attribution-audits', async request => {
    access.hq(request);
    const filters = auditQuery.parse(request.query);
    return { audits: stores.listAttributionAudits(filters), summary: stores.attributionSummary(filters),
      totals: stores.listManagers(filters.storeId).filter(manager => !filters.managerId || manager.id === filters.managerId).map(manager => ({
        storeId: manager.storeId, managerId: manager.id, clientCount: stores.listClients(manager.storeId).filter(client => client.managerId === manager.id).length,
      })),
    };
  });
  app.get('/api/hq/reconciliations', async request => { access.hq(request); return reconciliation.listLedger(auditQuery.parse(request.query)); });

  await app.register(fastifyStatic, { root: fileURLToPath(new URL('./client/', import.meta.url)), index: 'index.html' });
  app.get('/vendor/vue.esm-browser.prod.js', async (_request, reply) => {
    return reply.type('application/javascript; charset=utf-8').send(createReadStream(fileURLToPath(new URL('../../node_modules/vue/dist/vue.esm-browser.prod.js', import.meta.url))));
  });
  return app;
}
