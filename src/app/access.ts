import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { StoreModule } from '../modules/store/index.ts';
import type { AppDatabase } from '../shared/database.ts';
import { DomainError } from '../shared/errors.ts';
import { initialCredentials } from './initial-credentials.ts';

const derive = promisify(scrypt);
const LoginSchema = z.strictObject({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(256) });
export interface Actor {
  role: 'client' | 'manager' | 'hq';
  username: string;
  clientId?: string;
  managerId?: string;
  storeId?: string;
}
// Keep the persisted Phase 3 account format compatible; API roles are lowercase.
interface Account { username: string; role: 'Client' | 'Manager' | 'HQ'; subjectId?: string; salt: string; hash: string }
interface AccessOptions { bootstrapPassword?: string; secureCookies?: boolean }
const lifetime = 8 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Password verification, session lifetime and resource ownership stay behind this interface. */
export async function createAccess(db: AppDatabase, stores: StoreModule, options: AccessOptions = {}) {
  const existingManagerAccount = db.get('auth_account', 'dianzhang') as Account | undefined;
  const boundManager = existingManagerAccount?.subjectId
    ? stores.getManager(existingManagerAccount.subjectId)
    : stores.listManagers()[0];
  const boundClient = boundManager && stores.listClients(boundManager.storeId).find(client => client.managerId === boundManager.id);
  for (const [username, role, subjectId] of [
    ['admin', 'HQ', undefined], ['dianzhang', 'Manager', boundManager?.id], ['user', 'Client', boundClient?.id],
  ] as const) {
    if (db.get('auth_account', username) || (role !== 'HQ' && !subjectId)) continue;
    let credential: {salt: string; hash: string} = initialCredentials[username];
    if (options.bootstrapPassword !== undefined) {
      const password = z.string().min(8).max(256).parse(options.bootstrapPassword);
      const salt = randomBytes(16).toString('hex');
      credential = { salt, hash: (await derive(password, salt, 64) as Buffer).toString('hex') };
    }
    db.insert('auth_account', username, { username, role, ...(subjectId ? { subjectId } : {}), ...credential });
  }
  const sessions = new Map<string, { username: string; expires: number }>();
  const attempts = new Map<string, { count: number; expires: number }>();
  function limit(key: string, maximum: number, reply: FastifyReply) {
    for (const [id, value] of attempts) if (value.expires <= Date.now()) attempts.delete(id);
    const current = attempts.get(key) ?? { count: 0, expires: Date.now() + 15 * 60 * 1000 };
    if (current.count >= maximum || (!attempts.has(key) && attempts.size >= 10000)) {
      reply.header('Retry-After', Math.ceil((current.expires - Date.now()) / 1000));
      throw new DomainError('登录尝试过于频繁，请稍后重试', 429);
    }
    current.count++;
    attempts.set(key, current);
  }
  const token = (request: FastifyRequest) => request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('app_session='))?.slice(12);
  function resolve(account: Account): Actor {
    if (account.role === 'HQ') return { role: 'hq', username: account.username };
    if (account.role === 'Client') {
      const client = stores.getClient(account.subjectId!);
      if (client) return { role: 'client', username: account.username, clientId: client.id, storeId: client.storeId, ...(client.managerId ? { managerId: client.managerId } : {}) };
    } else if (account.role === 'Manager') {
      const manager = stores.getManager(account.subjectId!);
      if (manager) return { role: 'manager', username: account.username, managerId: manager.id, storeId: manager.storeId };
    }
    throw new DomainError('账号归属不可用，请联系管理员', 403);
  }
  function actor(request: FastifyRequest): Actor {
    const value = token(request);
    const session = value ? sessions.get(digest(value)) : undefined;
    if (session && session.expires > Date.now()) {
      const account = db.get('auth_account', session.username) as Account | undefined;
      if (account) return resolve(account);
    }
    throw new DomainError('请登录后继续', 401);
  }
  function manager(request: FastifyRequest, managerId?: string): string {
    const current = actor(request);
    if (current.role !== 'manager' || (managerId !== undefined && managerId !== current.managerId)) throw new DomainError('仅当前店长可执行此操作', 403);
    return current.managerId!;
  }
  const cookie = (value: string, maxAge: number) => `app_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${options.secureCookies ? '; Secure' : ''}`;
  return {
    actor, manager,
    managedClient(request: FastifyRequest, clientId: string) {
      const managerId = manager(request);
      const client = stores.getClient(clientId);
      if (!client) throw new DomainError('客户不存在', 404);
      if (client.managerId !== managerId || client.storeId !== actor(request).storeId) throw new DomainError('只能为名下客户登记', 403);
      return client;
    },
    async login(request: FastifyRequest, reply: FastifyReply): Promise<Actor> {
      const input = LoginSchema.parse(request.body);
      limit(`ip:${request.ip}`, 50, reply);
      limit(`account:${request.ip}:${input.username}`, 5, reply);
      const account = db.get('auth_account', input.username) as Account | undefined;
      const credential = account ?? initialCredentials.admin;
      const hash = await derive(input.password, credential.salt, 64) as Buffer;
      if (!timingSafeEqual(hash, Buffer.from(credential.hash, 'hex')) || !account) throw new DomainError('账号或密码不正确', 401);
      const selected = resolve(account);
      const previous = token(request);
      if (previous) sessions.delete(digest(previous));
      for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
      if (sessions.size >= 500) throw new DomainError('当前会话过多，请稍后重试', 503);
      const id = randomBytes(32).toString('base64url');
      sessions.set(digest(id), { username: account.username, expires: Date.now() + lifetime });
      reply.header('Set-Cookie', cookie(id, lifetime / 1000));
      return selected;
    },
    logout(request: FastifyRequest, reply: FastifyReply) {
      const previous = token(request);
      if (previous) sessions.delete(digest(previous));
      reply.header('Set-Cookie', cookie('', 0));
      return { ok: true };
    },
    hq(request: FastifyRequest) {
      if (actor(request).role !== 'hq') throw new DomainError('仅总部可访问此功能', 403);
    },
    reference(request: FastifyRequest) {
      if (actor(request).role === 'manager') throw new DomainError('店长账号仅可访问本店工作台', 403);
    },
    store(request: FastifyRequest, storeId: string) {
      const current = actor(request);
      if (current.role === 'hq' || (current.role === 'manager' && current.storeId === storeId)) return;
      throw new DomainError('不能访问其他角色或门店的记录', 403);
    },
    client(request: FastifyRequest, clientId: string) {
      const current = actor(request);
      if (current.role === 'client' && current.clientId !== clientId) throw new DomainError('只能查看本人的记录', 403);
      const client = stores.getClient(clientId);
      if (!client) throw new DomainError('客户不存在', 404);
      if (current.role === 'manager' && (current.storeId !== client.storeId || current.managerId !== client.managerId)) throw new DomainError('只能查看名下客户', 403);
      return client;
    },
  };
}
