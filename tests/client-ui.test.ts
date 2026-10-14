import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createSSRApp, ref, reactive, computed, nextTick } from 'vue';
import type { Ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { buildApp } from '../src/app/app.ts';

interface Client { id: string; name: string; managerId: string; reconciliationBalance: number }
interface State {
  session: Ref<{ role: string } | null>;
  authChecking: Ref<boolean>; authError: Ref<string>;
  loginForm: { username: string; password: string };
  clients: Ref<Client[]>; client: Ref<Client | null>;
  orders: Ref<unknown[]>; ledger: Ref<unknown[]>;
  pending: Ref<string>;
  adjustmentForm: { clientId: string; date: string; direction: string; amount: string; note: string };
  adjustmentBalance: Ref<number | null>; adjustmentInvalid: Ref<string>; adjustmentUnconfirmed: Ref<boolean>;
  initialize(): Promise<void>; login(): Promise<void>; logout(): Promise<void>;
  loadScope(): Promise<void>;
  startAdjustment(client: Client, direction: string): Promise<void>;
  saveAdjustment(): Promise<void> | undefined;
}
const source = readFileSync(new URL('../src/app/client/app.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/, '');
const page = readFileSync(new URL('../src/app/client/index.html', import.meta.url), 'utf8');
const template = page.match(/<div id="app" v-cloak>([\s\S]*)<\/div>\s*<noscript>/)![1]!;
const password = 'ui-test-password-42';
const applications: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });

function clientState(fetcher: (path: string, options?: RequestInit) => Promise<Response>) {
  let state!: State;
  runInNewContext(source, {
    createApp: (component: { setup(): State }) => ({ mount: () => { state = component.setup(); } }),
    ref, reactive, computed, nextTick, onMounted: () => {},
    fetch: fetcher, crypto: { randomUUID },
    setTimeout: () => 0, clearTimeout: () => {},
    document: { getElementById: () => null, querySelector: () => null },
  });
  return state;
}
async function harness() {
  const app = await buildApp({ databasePath: ':memory:', today: '2026-10-13', bootstrapPassword: password });
  applications.push(app);
  let cookie = '';
  let interceptor: ((path: string, response: Response) => Promise<Response>) | undefined;
  const calls: string[] = [];
  const state = clientState(async (path, options = {}) => {
    calls.push(path);
    const response = await app.inject({
      method: (options.method ?? 'GET') as 'GET' | 'POST' | 'PATCH', url: path,
      headers: { cookie, ...Object.fromEntries(new Headers(options.headers).entries()) },
      ...(typeof options.body === 'string' ? { payload: options.body } : {}),
    });
    if (response.headers['set-cookie']) cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const value = new Response(response.body, { status: response.statusCode });
    return interceptor ? interceptor(path, value) : value;
  });
  return {
    state, calls,
    intercept(fn: typeof interceptor) { interceptor = fn; },
    async login(username: string) {
      state.authChecking.value = false;
      Object.assign(state.loginForm, { username, password });
      await state.login();
      expect(state.authError.value).toBe('');
    },
    render: () => renderToString(createSSRApp({ template, setup: () => state })),
  };
}

it('renders only the login form before authentication and rejects unknown server roles', async () => {
  const state = clientState(async () => new Response(JSON.stringify({ role: 'superuser', username: 'forged' })));
  state.authChecking.value = false;
  const render = () => renderToString(createSSRApp({ template, setup: () => state }));
  expect(await render()).toContain('登录工作台');
  expect(await render()).not.toContain('收支登记');
  await state.login();
  expect(state.session.value).toBeNull();
  expect(state.authError.value).toContain('账号角色或归属无效');
  expect(await render()).not.toContain('<dialog');
});

it.each([
  ['user', 'client', '我的'], ['dianzhang', 'manager', '门店'], ['admin', 'hq', '总部'],
])('mounts only the authorized workspace for %s, including hidden dialogs', async (username, role, title) => {
  const browser = await harness();
  await browser.login(username!);
  expect(browser.state.session.value?.role).toBe(role);
  const html = await browser.render();
  expect(html).toContain(`<h1>${title}</h1>`);
  expect(html).not.toContain('角色切换');
  expect(html).not.toContain('登录工作台');
  if (role === 'client') {
    expect(html).toContain('个人往来对账结余');
    expect(html).toContain('自主选号');
    for (const absent of ['id="order-title"', 'id="adjustment-form"', '建立客户档案', '客户归属']) expect(html).not.toContain(absent);
    expect(browser.calls.some(path => path.startsWith('/api/stores/') || path.startsWith('/api/hq/'))).toBe(false);
  } else if (role === 'manager') {
    expect(html).toContain('id="adjustment-form"');
    expect(html).toContain('id="order-title"');
    expect(html).not.toContain('客户归属');
    expect(html).not.toContain('个人往来对账结余');
    expect(browser.calls.some(path => path.startsWith('/api/hq/') || path.startsWith('/api/portfolios/') || path.startsWith('/api/calendar'))).toBe(false);
  } else {
    expect(html).toContain('客户归属');
    expect(html).not.toContain('id="adjustment-form"');
    expect(html).not.toContain('id="order-title"');
    expect(html).not.toContain('个人往来对账结余');
  }
});

it('clears all prior-role state on logout and ignores an in-flight response from that session', async () => {
  const browser = await harness();
  await browser.login('user');
  let release!: () => void;
  let received!: () => void;
  const entered = new Promise<void>(resolve => { received = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  browser.intercept(async (path, response) => {
    if (path.endsWith('/orders')) { received(); await gate; }
    return response;
  });
  const stale = browser.state.loadScope();
  await entered;
  await browser.state.logout();
  release(); await stale;
  expect(browser.state.session.value).toBeNull();
  expect(browser.state.orders.value).toEqual([]);
  expect(browser.state.clients.value).toEqual([]);
  expect(browser.state.ledger.value).toEqual([]);
  expect(await browser.render()).toContain('登录工作台');
  browser.intercept(undefined);
  await browser.login('admin');
  expect(browser.state.client.value).toBeNull();
  expect(await browser.render()).not.toContain('id="order-title"');
});

it('preselects the owned client, previews cents accurately and saves one offline adjustment on repeated clicks', async () => {
  const browser = await harness();
  await browser.login('dianzhang');
  const state = browser.state;
  const client = state.clients.value[0]!;
  const initialCents = Math.round(client.reconciliationBalance * 100);
  await state.startAdjustment(client, 'ADJUST_IN');
  expect(state.adjustmentForm.clientId).toBe(client.id);
  state.adjustmentForm.amount = '0.29';
  state.adjustmentForm.note = '已在线下发生的差额补记';
  expect(state.adjustmentBalance.value).toBe((initialCents + 29) / 100);
  expect(state.adjustmentInvalid.value).toBe('');
  const ledgerCount = state.ledger.value.length;
  await Promise.all([state.saveAdjustment(), state.saveAdjustment()]);
  expect(state.ledger.value).toHaveLength(ledgerCount + 1);
  expect(state.clients.value.find(item => item.id === client.id)?.reconciliationBalance).toBe((initialCents + 29) / 100);
  expect(browser.calls.filter(path => path === '/api/reconciliations')).toHaveLength(1);
  await state.startAdjustment(state.clients.value[0]!, 'ADJUST_OUT');
  state.adjustmentForm.amount = String(client.reconciliationBalance + 100);
  expect(state.adjustmentInvalid.value).toContain('超过当前对账结余');
  await state.saveAdjustment();
  expect(browser.calls.filter(path => path === '/api/reconciliations')).toHaveLength(1);
  state.adjustmentForm.amount = '1.001';
  expect(state.adjustmentBalance.value).toBeNull();
  expect(state.adjustmentInvalid.value).toContain('最多两位小数');
});

it('preserves the idempotency key after a lost response so retry cannot duplicate a recorded adjustment', async () => {
  const browser = await harness();
  await browser.login('dianzhang');
  const state = browser.state;
  await state.startAdjustment(state.clients.value[0]!, 'ADJUST_IN');
  Object.assign(state.adjustmentForm, { amount: '10.01', note: '线下收支核对补记' });
  const count = state.ledger.value.length;
  let loseResponse = true;
  browser.intercept(async (path, response) => {
    if (path === '/api/reconciliations' && loseResponse) { loseResponse = false; throw new Error('连接中断'); }
    return response;
  });
  await state.saveAdjustment();
  expect(state.adjustmentForm.amount).toBe('10.01');
  expect(state.adjustmentUnconfirmed.value).toBe(true);
  await state.startAdjustment(state.clients.value[0]!, 'ADJUST_OUT');
  expect(state.adjustmentForm.direction).toBe('ADJUST_IN');
  expect(state.adjustmentForm.amount).toBe('10.01');
  expect(await browser.render()).toContain('重试确认本笔记录');
  await state.saveAdjustment();
  expect(state.ledger.value).toHaveLength(count + 1);
  expect(state.adjustmentForm.amount).toBe('');
  expect(state.adjustmentUnconfirmed.value).toBe(false);
});

it('can confirm a lost full-debit response even after another refresh shows a zero balance', async () => {
  const browser = await harness();
  await browser.login('dianzhang');
  const state = browser.state;
  const client = state.clients.value[0]!;
  const count = state.ledger.value.length;
  await state.startAdjustment(client, 'ADJUST_OUT');
  Object.assign(state.adjustmentForm, { amount: String(client.reconciliationBalance), note: '线下结余核清' });
  let loseResponse = true;
  browser.intercept(async (path, response) => {
    if (path === '/api/reconciliations' && loseResponse) { loseResponse = false; throw new Error('响应丢失'); }
    return response;
  });
  await state.saveAdjustment();
  await state.loadScope();
  expect(state.adjustmentBalance.value).toBeLessThan(0);
  await state.saveAdjustment();
  expect(state.adjustmentUnconfirmed.value).toBe(false);
  expect(state.ledger.value).toHaveLength(count + 1);
  expect(state.clients.value.find(item => item.id === client.id)?.reconciliationBalance).toBe(0);
});

it('allows client to open custom order and generate random numbers', async () => {
  const browser = await harness();
  await browser.login('user');
  const state = browser.state as any;
  state.openCustomOrder();
  expect(state.customForm.selectedCode).toBe('');
  state.randomCustomCode();
  expect(state.customForm.selectedCode).toMatch(/^[0-9]{3}$/);
});
