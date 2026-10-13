import { createApp, ref, reactive, computed, onMounted, nextTick } from '/vendor/vue.esm-browser.prod.js';

createApp({
  setup() {
    const view = ref('workspace');
    const bootstrap = ref({ today: '', stores: [], managers: [], clients: [] });
    const session = ref(null);
    const authChecking = ref(true);
    const authBusy = ref(false);
    const authError = ref('');
    const logoutUnconfirmed = ref(false);
    const loginForm = reactive({ username: '', password: '' });
    const portfolio = ref(null);
    const calendar = ref([]);
    const clients = ref([]);
    const client = ref(null);
    const orders = ref([]);
    const bills = ref([]);
    const ledger = ref([]);
    const audits = ref([]);
    const attributionSummary = ref([]);
    const attributionTotals = ref([]);
    const summary = ref(null);
    const loading = ref(true);
    const scopeLoading = ref(false);
    const error = ref('');
    const scopeError = ref('');
    const formError = ref('');
    const failedForm = ref('');
    const pending = ref('');
    const toast = ref('');
    const day = ref(null);
    const dayDialog = ref(null);
    const orderDialog = ref(null);
    const followDialog = ref(null);
    const portfolioDialog = ref(null);
    const followForm = reactive({ selectedCode: '', quantity: 1, multiplier: 1 });
    const management = ref(false);
    const hqDate = ref('');
    let sessionEpoch = 0;
    let scopeRequest = 0;
    let globalRequest = 0;
    let toastTimer;
    let pollTimer;
    let adjustmentRetry = null;
    const orderForm = reactive({ clientId: '', date: '', selectedCode: '', quantity: 1, totalAmount: 2, adoptedStrategy: false });
    const adjustmentForm = reactive({ clientId: '', date: '', direction: 'ADJUST_IN', amount: '', note: '' });
    const adjustmentUnconfirmed = ref(false);
    const resultForm = reactive({ date: '', settlementCode: '', quotaPerUnit: 1040 });
    const portfolioForm = reactive({ date: '', combos: [{ code: '', weight: 33, note: '' }, { code: '', weight: 33, note: '' }, { code: '', weight: 34, note: '' }] });
    const isEditingPortfolio = ref(false);
    const storeForm = reactive({ name: '', address: '' });
    const managerForm = reactive({ storeId: '', name: '' });
    const clientForm = reactive({ name: '', introducedByClientId: '', date: '' });
    const role = computed(() => session.value?.role ?? null);
    const manager = computed(() => bootstrap.value.managers.find(item => item.id === session.value?.managerId));
    const store = computed(() => bootstrap.value.stores.find(item => item.id === session.value?.storeId));
    const roleTitle = computed(() => ({ client: '客户工作台', manager: '店长工作台', hq: '总部管理后台' })[role.value]);
    const title = computed(() => ({ today: '今日策略', calendar: '战绩日历', workspace: roleTitle.value })[view.value]);
    const ownClients = computed(() => clients.value.filter(item => item.managerId === session.value?.managerId));
    const adjustmentClient = computed(() => ownClients.value.find(item => item.id === adjustmentForm.clientId));
    // Use cents for the preview; the server independently validates and commits the ledger transaction.
    function cents(value) {
      const text = String(value).trim();
      if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
      const [whole, fraction = ''] = text.split('.');
      const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      return Number.isSafeInteger(amount) ? amount : null;
    }
    const adjustmentBalance = computed(() => {
      const amount = cents(adjustmentForm.amount);
      const balance = cents(adjustmentClient.value?.reconciliationBalance);
      if (amount === null || balance === null || amount <= 0) return null;
      const next = balance + (adjustmentForm.direction === 'ADJUST_IN' ? amount : -amount);
      return Number.isSafeInteger(next) ? next / 100 : null;
    });
    const adjustmentInvalid = computed(() => {
      if (!adjustmentForm.amount) return '';
      if (adjustmentBalance.value === null) return '请输入大于 0、最多两位小数的有效金额。';
      return adjustmentBalance.value < 0 ? '核减金额超过当前对账结余，请核对实际收支。' : '';
    });
    const storedCount = computed(() => orders.value.filter(item => item.voucherStatus !== 'Claimed').length);
    const followTotalCost = computed(() => {
      const q = Math.max(1, Number(followForm.quantity) || 1);
      const m = Math.max(1, Number(followForm.multiplier) || 1);
      return q * m * 2;
    });
    const hitCount = computed(() => calendar.value.filter(item => item.status === 'Hit').length);
    const verifiedCount = computed(() => calendar.value.filter(item => item.status).length);
    const calendarPadding = computed(() => calendar.value.length ? (new Date(`${calendar.value[0].date}T00:00:00Z`).getUTCDay() + 6) % 7 : 0);
    const billMap = computed(() => new Map(bills.value.map(item => [item.orderSlipId, item])));
    const money = value => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 }).format(value ?? 0);
    const shortDate = date => date ? `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日` : '—';
    const dateTime = value => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value)) : '—';
    const clientName = id => clients.value.find(item => item.id === id)?.name ?? bootstrap.value.clients.find(item => item.id === id)?.name ?? '客户档案';
    const managerName = id => bootstrap.value.managers.find(item => item.id === id)?.name ?? '店长档案';
    const storeName = id => bootstrap.value.stores.find(item => item.id === id)?.name ?? '门店档案';
    const statusLabel = item => item.status === 'Hit' ? '红 · Hit' : item.status === 'Miss' ? '黑 · Miss' : '待核验';
    const voucherLabel = item => item.voucherStatus === 'Claimed' ? '客户已到店领取' : '店内存管待取';
    const latestLedger = items => [...items].reverse();
    const newest = items => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

    function staleSession() { return Object.assign(new Error('会话已变化。'), { stale: true }); }
    function acceptSession(actor) {
      if (!actor || !['client', 'manager', 'hq'].includes(actor.role)
        || (actor.role === 'client' && !actor.clientId)
        || (actor.role === 'manager' && (!actor.managerId || !actor.storeId))) {
        throw new Error('账号角色或归属无效，请联系管理员。');
      }
      session.value = actor;
    }
    async function api(path, body, method = 'POST', headers = {}) {
      const epoch = sessionEpoch;
      if (!path.startsWith('/api/auth/') && !session.value) throw staleSession();
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) });
      if (epoch !== sessionEpoch) throw staleSession();
      if (response.status === 401) {
        const wasAuthenticated = !!session.value;
        let message = '账号或密码不正确，请重新输入。';
        try { message = (await response.json()).error || message; } catch { /* The login screen also handles an empty unauthorized response. */ }
        if (epoch !== sessionEpoch) throw staleSession();
        clearSession();
        if (wasAuthenticated) authError.value = '登录已失效，请重新登录。';
        throw Object.assign(new Error(message), { unauthorized: true });
      }
      const data = response.status === 204 ? null : await response.json();
      if (epoch !== sessionEpoch) throw staleSession();
      if (!response.ok) throw Object.assign(new Error(data?.error || '操作未完成，请稍后重试。'), { status: response.status });
      return data;
    }
    function notify(message) {
      toast.value = message;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.value = ''; }, 6000);
    }
    function clearScope() {
      ++scopeRequest;
      clients.value = []; client.value = null; orders.value = []; bills.value = []; ledger.value = []; audits.value = []; attributionSummary.value = []; attributionTotals.value = []; summary.value = null;
      scopeError.value = ''; formError.value = ''; failedForm.value = ''; toast.value = ''; management.value = false;
      orderForm.clientId = ''; adjustmentForm.clientId = ''; adjustmentForm.amount = ''; adjustmentForm.note = '';
      clientForm.name = ''; clientForm.introducedByClientId = '';
      orderDialog.value?.close(); dayDialog.value?.close(); day.value = null;
    }
    function clearSession() {
      ++sessionEpoch;
      ++globalRequest;
      clearScope();
      clearTimeout(toastTimer);
      stopPolling();
      session.value = null;
      bootstrap.value = { today: '', stores: [], managers: [], clients: [] };
      portfolio.value = null; calendar.value = []; view.value = 'workspace';
      error.value = ''; loading.value = false; scopeLoading.value = false; pending.value = '';
      adjustmentRetry = null; adjustmentUnconfirmed.value = false; hqDate.value = '';
      Object.assign(orderForm, { clientId: '', date: '', selectedCode: '', quantity: 1, totalAmount: 2, adoptedStrategy: false });
      Object.assign(adjustmentForm, { clientId: '', date: '', direction: 'ADJUST_IN', amount: '', note: '' });
      Object.assign(clientForm, { name: '', introducedByClientId: '', date: '' });
      Object.assign(storeForm, { name: '', address: '' });
      Object.assign(managerForm, { storeId: '', name: '' });
      Object.assign(resultForm, { date: '', settlementCode: '', quotaPerUnit: 1040 });
      Object.assign(portfolioForm, { date: '', combos: [{ code: '', weight: 33, note: '' }, { code: '', weight: 33, note: '' }, { code: '', weight: 34, note: '' }] });
      loginForm.username = ''; loginForm.password = '';
    }
    function startPolling() {
      stopPolling();
      pollTimer = setInterval(() => {
        if (!session.value || role.value === 'manager') return;
        loadGlobal().catch(() => {});
      }, 10000);
    }
    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }
    async function loadGlobal() {
      if (!session.value || role.value === 'manager') { portfolio.value = null; calendar.value = []; return; }
      const request = ++globalRequest;
      const [todayPortfolio, days] = await Promise.all([api(`/api/portfolios/${bootstrap.value.today}`), api(`/api/calendar?endDate=${bootstrap.value.today}`)]);
      if (request !== globalRequest) return;
      portfolio.value = todayPortfolio;
      calendar.value = [...days].sort((a, b) => a.date.localeCompare(b.date));
      if (day.value) day.value = calendar.value.find(item => item.date === day.value.date) ?? null;
    }
    async function loadScope() {
      if (!session.value) return;
      const request = ++scopeRequest;
      const current = session.value;
      scopeError.value = ''; scopeLoading.value = true;
      try {
        if (current.role === 'client') {
          const values = await Promise.all([api(`/api/clients/${current.clientId}`), api(`/api/clients/${current.clientId}/orders`), api(`/api/clients/${current.clientId}/reconciliations`)]);
          if (request !== scopeRequest) return;
          client.value = values[0]; clients.value = [values[0]]; orders.value = newest(values[1]); ledger.value = latestLedger(values[2]);
        } else if (current.role === 'manager') {
          const values = await Promise.all(['clients', 'orders', 'bills', 'summary', 'reconciliations'].map(resource => api(`/api/stores/${current.storeId}/${resource}`)));
          if (request !== scopeRequest) return;
          [clients.value, orders.value, bills.value, summary.value, ledger.value] = values;
          orders.value = newest(orders.value); bills.value = [...bills.value].sort((a, b) => b.date.localeCompare(a.date)); ledger.value = latestLedger(ledger.value);
        } else {
          const query = hqDate.value ? `?date=${encodeURIComponent(hqDate.value)}` : '';
          const [attribution, entries] = await Promise.all([api(`/api/hq/attribution-audits${query}`), api(`/api/hq/reconciliations${query}`)]);
          if (request !== scopeRequest) return;
          audits.value = newest(attribution.audits); attributionSummary.value = attribution.summary; attributionTotals.value = attribution.totals; ledger.value = latestLedger(entries);
        }
      } catch (failure) {
        if (request === scopeRequest) scopeError.value = failure.message || '数据读取失败，请重试。';
      } finally { if (request === scopeRequest) scopeLoading.value = false; }
    }
    async function refreshBootstrap() {
      const epoch = sessionEpoch;
      const data = await api('/api/bootstrap');
      if (epoch !== sessionEpoch || !session.value) throw staleSession();
      if (data.role !== role.value) { clearSession(); throw new Error('账号权限已变化，请重新登录。'); }
      bootstrap.value = data;
      if (!managerForm.storeId) managerForm.storeId = data.stores[0]?.id ?? '';
    }
    async function loadWorkspace() {
      const epoch = sessionEpoch;
      loading.value = true; error.value = '';
      try {
        await refreshBootstrap();
        if (epoch !== sessionEpoch) return;
        for (const form of [orderForm, resultForm, portfolioForm, clientForm, adjustmentForm]) form.date ||= bootstrap.value.today;
        await Promise.all([loadScope(), ...(role.value === 'manager' ? [] : [loadGlobal()])]);
        startPolling();
      } catch (failure) {
        if (epoch === sessionEpoch && session.value && !failure.stale) error.value = failure.message || '读取失败，请检查连接后重试。';
      } finally { if (epoch === sessionEpoch) loading.value = false; }
    }
    async function initialize() {
      if (authBusy.value) return;
      clearSession(); authChecking.value = true; authError.value = '';
      const epoch = sessionEpoch;
      try {
        const actor = await api('/api/auth/me');
        if (epoch !== sessionEpoch) return;
        acceptSession(actor);
        await loadWorkspace();
      } catch (failure) {
        if (!failure.stale && !failure.unauthorized && epoch === sessionEpoch) authError.value = '无法恢复登录，请检查连接后重新登录。';
      } finally { authChecking.value = false; }
    }
    async function login() {
      if (authBusy.value || authChecking.value || logoutUnconfirmed.value) return;
      const credentials = { username: loginForm.username.trim(), password: loginForm.password };
      clearSession(); authBusy.value = true; authError.value = '';
      const epoch = sessionEpoch;
      try {
        const actor = await api('/api/auth/login', credentials);
        if (epoch !== sessionEpoch) return;
        acceptSession(actor);
        await loadWorkspace();
      } catch (failure) {
        if (!failure.stale && !session.value) {
          authError.value = failure.message || '登录失败，请检查连接后重试。';
          await nextTick();
          document.getElementById('login-error')?.focus({ preventScroll: true });
          document.getElementById('login-error')?.scrollIntoView({ block: 'nearest' });
        }
      } finally { credentials.password = ''; authBusy.value = false; }
    }
    async function logout() {
      if (authBusy.value || pending.value) return;
      clearSession(); authBusy.value = true; authError.value = ''; logoutUnconfirmed.value = true;
      try {
        await api('/api/auth/logout', {});
        logoutUnconfirmed.value = false;
      } catch (failure) {
        if (failure.unauthorized) logoutUnconfirmed.value = false;
        else if (!failure.stale) authError.value = '退出请求未确认，请检查连接后点击“重试退出”。';
      } finally { authBusy.value = false; }
    }
    async function openDay(item) {
      if (!session.value || role.value === 'manager') return;
      const epoch = sessionEpoch; day.value = item; await nextTick();
      if (epoch === sessionEpoch && session.value && day.value) dayDialog.value?.showModal();
    }
    async function openOrder() {
      if (role.value !== 'manager' || !store.value || pending.value) return;
      const epoch = sessionEpoch; formError.value = '';
      Object.assign(orderForm, { clientId: '', date: bootstrap.value.today, selectedCode: '', quantity: 1, totalAmount: 2, adoptedStrategy: false });
      await nextTick();
      if (epoch === sessionEpoch && session.value) orderDialog.value?.showModal();
    }
    function closeOrder() { if (!pending.value) orderDialog.value.close(); }
    async function openManagement() {
      if (!session.value || role.value !== 'hq') return;
      view.value = 'workspace';
      const epoch = sessionEpoch; management.value = true;
      await nextTick();
      if (epoch !== sessionEpoch || !session.value) return;
      document.getElementById('demo-management')?.scrollIntoView({ block: 'start' });
      document.querySelector('#demo-management > summary')?.focus({ preventScroll: true });
    }
    async function perform(key, task) {
      if (pending.value || loading.value || !session.value) return;
      const epoch = sessionEpoch;
      pending.value = key; formError.value = ''; failedForm.value = '';
      try { await task(); }
      catch (failure) {
        if (epoch !== sessionEpoch || !session.value || failure.stale) return;
        formError.value = failure.message || '保存失败，填写内容已保留，请重试。';
        failedForm.value = key;
        await nextTick();
        const alert = orderDialog.value?.open
          ? document.getElementById('order-form-error')
          : document.getElementById(`form-error-${key}`) ?? document.getElementById('workspace-form-error');
        alert?.focus({ preventScroll: true });
        alert?.scrollIntoView({ block: 'nearest' });
      }
      finally { if (epoch === sessionEpoch) pending.value = ''; }
    }
    async function refreshAfterSave(includeGlobal = false) {
      const epoch = sessionEpoch;
      try {
        await refreshBootstrap();
        if (epoch !== sessionEpoch || !session.value) throw staleSession();
        await Promise.all([loadScope(), ...(includeGlobal && role.value !== 'manager' ? [loadGlobal()] : [])]);
        if (epoch !== sessionEpoch || !session.value) throw staleSession();
      } catch (failure) {
        if (epoch !== sessionEpoch || !session.value || failure.stale) throw staleSession();
        if (epoch === sessionEpoch && session.value && !failure.stale) error.value = `记录已保存，但数据刷新失败：${failure.message}。请点击重新加载。`;
      }
    }
    function saveOrder() {
      return perform('order', async () => {
        const saved = await api('/api/orders', { ...orderForm, quantity: Number(orderForm.quantity), totalAmount: Number(orderForm.totalAmount), managerId: session.value.managerId });
        orderDialog.value.close(); notify(`已完成线下业务已留档 · ${saved.id.slice(0, 8)}`); await refreshAfterSave();
      });
    }
    function claimVoucher(order) {
      return perform(`voucher-${order.id}`, async () => {
        await api(`/api/orders/${order.id}/voucher-status`, { voucherStatus: 'Claimed' }, 'PATCH');
        notify('已记录客户到店领取纸质凭证。'); await refreshAfterSave();
      });
    }
    function saveAdjustment() {
      if (role.value !== 'manager' || (!adjustmentUnconfirmed.value && (!adjustmentClient.value || adjustmentInvalid.value))) return;
      return perform('adjustment', async () => {
        const body = adjustmentUnconfirmed.value && adjustmentRetry
          ? adjustmentRetry.body
          : { ...adjustmentForm, amount: Number(adjustmentForm.amount), managerId: session.value.managerId };
        const signature = JSON.stringify(body);
        if (adjustmentRetry?.signature !== signature) adjustmentRetry = { signature, key: crypto.randomUUID(), body };
        try { await api('/api/reconciliations', body, 'POST', { 'Idempotency-Key': adjustmentRetry.key }); }
        catch (failure) {
          if (failure.stale || failure.unauthorized) throw failure;
          if (failure.status && failure.status < 500) { adjustmentRetry = null; adjustmentUnconfirmed.value = false; }
          else adjustmentUnconfirmed.value = true;
          throw failure;
        }
        adjustmentRetry = null; adjustmentUnconfirmed.value = false;
        adjustmentForm.amount = ''; adjustmentForm.note = ''; notify('实际收支已登记，对账结余与审计流水已同步。'); await refreshAfterSave();
      });
    }
    async function startAdjustment(selected, direction) {
      if (role.value !== 'manager' || pending.value || !ownClients.value.some(item => item.id === selected.id)) return;
      const epoch = sessionEpoch;
      if (adjustmentUnconfirmed.value) {
        document.getElementById('adjustment-form')?.scrollIntoView({ block: 'center' });
        return;
      }
      view.value = 'workspace'; formError.value = ''; failedForm.value = '';
      Object.assign(adjustmentForm, { clientId: selected.id, date: bootstrap.value.today, direction, amount: '', note: '' });
      await nextTick();
      if (epoch !== sessionEpoch) return;
      document.getElementById('adjustment-form')?.scrollIntoView({ block: 'center' });
      document.getElementById('adjustment-amount')?.focus({ preventScroll: true });
    }
    function saveClient() {
      return perform('client', async () => {
        await api('/api/clients', { name: clientForm.name, date: clientForm.date, ...(clientForm.introducedByClientId ? { introducedByClientId: clientForm.introducedByClientId } : { managerId: session.value.managerId, storeId: session.value.storeId }) });
        clientForm.name = ''; clientForm.introducedByClientId = ''; notify('客户档案已建立，归属与引荐来源已留存审计。'); await refreshAfterSave();
      });
    }
    function saveResolution() {
      return perform('resolution', async () => {
        await api('/api/resolutions', { ...resultForm, quotaPerUnit: Number(resultForm.quotaPerUnit) });
        notify('决议已登记，相关历史存根已核算。'); await refreshAfterSave(true);
      });
    }
    function openFollow(combo) {
      if (role.value !== 'client' || !combo) return;
      followForm.selectedCode = combo.code;
      followForm.quantity = 1;
      followForm.multiplier = 1;
      followDialog.value?.showModal();
    }
    function submitFollowOrder() {
      return perform('follow', async () => {
        const order = await api('/api/client/orders', {
          selectedCode: followForm.selectedCode,
          quantity: Number(followForm.quantity),
          multiplier: Number(followForm.multiplier),
          adoptedStrategy: true,
        });
        followDialog.value?.close();
        notify(`跟单成功！已生成存根 ${order.id.slice(0, 8)} 并扣除余额 ¥${followTotalCost.value.toFixed(2)}`);
        await refreshAfterSave();
      });
    }
    function openPortfolioDialog(forEdit = true) {
      if (role.value !== 'hq') return;
      isEditingPortfolio.value = forEdit;
      formError.value = '';
      failedForm.value = '';
      if (forEdit && portfolio.value) {
        portfolioForm.date = portfolio.value.date;
        portfolioForm.combos = portfolio.value.combos.map(c => ({ code: c.code, weight: c.weight, note: c.note || '' }));
      } else {
        portfolioForm.date = bootstrap.value.today;
        portfolioForm.combos = [
          { code: '', weight: 33, note: '建议均权配置 / 风险均衡' },
          { code: '', weight: 33, note: '建议均权配置 / 风险均衡' },
          { code: '', weight: 34, note: '建议均权配置 / 风险均衡' }
        ];
      }
      portfolioDialog.value?.showModal();
    }
    function editPortfolioToday() {
      openPortfolioDialog(true);
    }
    function savePortfolioModal() {
      return perform('portfolio-modal', async () => {
        const payload = {
          date: portfolioForm.date,
          combos: portfolioForm.combos.map(c => ({
            code: String(c.code).trim(),
            weight: Number(c.weight),
            note: c.note || undefined
          }))
        };
        if (isEditingPortfolio.value) {
          await api(`/api/portfolios/${portfolioForm.date}`, payload, 'PUT');
          notify('当日策略已成功更新！客户端已实时同步。');
        } else {
          try {
            await api('/api/portfolios', payload);
            notify('今日三组策略发布成功！客户工作台已即刻呈现。');
          } catch (err) {
            if (err.status === 400 || (err.message && err.message.includes('已发布'))) {
              await api(`/api/portfolios/${portfolioForm.date}`, payload, 'PUT');
              notify('当日策略已更新！客户端已实时同步。');
            } else {
              throw err;
            }
          }
        }
        portfolioDialog.value?.close();
        await refreshAfterSave(true);
      });
    }
    function savePortfolio() {
      return perform('portfolio', async () => {
        const payload = { date: portfolioForm.date, combos: portfolioForm.combos.map(combo => ({ ...combo, weight: Number(combo.weight) })) };
        if (isEditingPortfolio.value) {
          await api(`/api/portfolios/${portfolioForm.date}`, payload, 'PUT');
          notify('当日策略已更新纠错！客户端已实时同步。');
        } else {
          try {
            await api('/api/portfolios', payload);
            notify('参考策略已发布。');
          } catch (err) {
            if (err.status === 400 || (err.message && err.message.includes('已发布'))) {
              await api(`/api/portfolios/${portfolioForm.date}`, payload, 'PUT');
              notify('当日策略已更新！');
            } else {
              throw err;
            }
          }
        }
        isEditingPortfolio.value = false;
        await refreshAfterSave(true);
      });
    }
    function saveStore() {
      return perform('store', async () => {
        const saved = await api('/api/stores', { ...storeForm });
        storeForm.name = ''; storeForm.address = ''; await refreshAfterSave(); managerForm.storeId = saved.id; notify('门店已创建，可继续添加所属店长。');
      });
    }
    function saveManager() {
      return perform('manager', async () => {
        await api('/api/managers', { ...managerForm }); managerForm.name = ''; await refreshAfterSave(); notify('店长档案已添加，对应店长登录后可建立客户档案。');
      });
    }
    onMounted(initialize);
    return { view, bootstrap, session, authChecking, authBusy, authError, logoutUnconfirmed, loginForm, role, roleTitle, manager, store, client, ownClients, portfolio, calendar, clients, orders, bills, ledger, audits, attributionSummary, attributionTotals, summary, storedCount, loading, scopeLoading, error, scopeError, formError, failedForm, pending, toast, day, dayDialog, orderDialog, followDialog, portfolioDialog, followForm, followTotalCost, isEditingPortfolio, orderForm, adjustmentForm, adjustmentUnconfirmed, adjustmentClient, adjustmentBalance, adjustmentInvalid, startAdjustment, resultForm, portfolioForm, storeForm, managerForm, clientForm, management, hqDate, title, hitCount, verifiedCount, calendarPadding, billMap, money, shortDate, dateTime, clientName, managerName, storeName, statusLabel, voucherLabel, initialize, login, logout, loadScope, loadGlobal, openDay, openOrder, openFollow, submitFollowOrder, openPortfolioDialog, editPortfolioToday, savePortfolioModal, openManagement, closeOrder, saveOrder, claimVoucher, saveAdjustment, saveResolution, savePortfolio, saveStore, saveManager, saveClient };
  },
}).mount('#app');
