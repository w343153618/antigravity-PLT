import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../shared/database.ts';
import type { createStoreModule } from '../modules/store/index.ts';
import type { createStrategyModule } from '../modules/strategy/index.ts';
import type { createRegistryModule } from '../modules/registry/index.ts';
import { createReconciliationModule } from '../modules/reconciliation/index.ts';
import type { Client } from '../modules/store/index.ts';

export function seedDemo(
  db: AppDatabase,
  stores: ReturnType<typeof createStoreModule>,
  strategy: ReturnType<typeof createStrategyModule>,
  registry: ReturnType<typeof createRegistryModule>,
  today: string,
) {
  if (db.get('meta', 'demo-seed-v1')) return;
  // Seed only an empty application database; existing business records stay authoritative.
  if (['store', 'manager', 'client', 'portfolio', 'resolution', 'registration', 'bill', 'client_attribution_audit', 'reconciliation_ledger', 'voucher_audit'].some((kind) => db.list(kind).length)) return;
  db.transaction(() => {
    const openingDay = new Date(`${today}T00:00:00Z`);
    openingDay.setUTCDate(openingDay.getUTCDate() - 29);
    const openingDate = openingDay.toISOString().slice(0, 10);
    const closingDay = new Date(`${today}T00:00:00Z`);
    closingDay.setUTCDate(closingDay.getUTCDate() - 1);
    const closingDate = closingDay.toISOString().slice(0, 10);
    const reconciliation = createReconciliationModule(db, stores);
    const branches = ['南京·晨光店', '南京·河畔店'].map((name, index) => {
      const store = stores.addStore({ id: randomUUID(), name, address: index === 0 ? '模拟地址 · 晨光路 18 号' : '模拟地址 · 河畔路 26 号' });
      const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: index === 0 ? '陈店长（模拟）' : '林店长（模拟）' });
      const clients: Client[] = [];
      for (const [clientIndex, clientName] of ['周先生', '许女士', '林先生'].entries()) {
        const client = stores.addClient({
          id: randomUUID(), storeId: store.id, managerId: manager.id, name: `${clientName}（模拟）`, date: openingDate,
          ...(clientIndex === 1 ? { introducedByClientId: clients[0]!.id } : {}),
          note: clientIndex === 1 ? '合成演示：老客户线下引荐建档' : '合成演示：店长直接建立历史档案',
        });
        clients.push(client);
        reconciliation.adjust({
          managerId: manager.id, clientId: client.id, date: openingDate, direction: 'ADJUST_IN',
          amount: [120.5, 80, 30][clientIndex], note: '合成演示：已线下发生的往来收款事后登记',
        });
      }
      reconciliation.adjust({
        managerId: manager.id, clientId: clients[0]!.id, date: closingDate, direction: 'ADJUST_OUT',
        amount: 20.25, note: '合成演示：已线下发生的往来返还事后核减',
      });
      return { store, manager, clients };
    });
    for (let offset = 29; offset >= 0; offset -= 1) {
      const day = new Date(`${today}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() - offset);
      const date = day.toISOString().slice(0, 10);
      strategy.publishPortfolio({
        id: randomUUID(), date, createdAt: new Date(`${date}T01:00:00Z`),
        combos: ['279', '148', '350'].map((code) => ({ code, weight: 1, note: '建议均权配置 / 风险均衡' })),
      });
      for (const [index, branch] of branches.entries()) {
        const registered = registry.registerOrder(branch.manager.id, {
          id: randomUUID(), storeId: branch.store.id, clientId: branch.clients[offset % 3]!.id,
          date, selectedCode: index === 0 ? '279' : '148', quantity: 1, totalAmount: 2,
          adoptedStrategy: true, createdAt: new Date(`${date}T02:00:00Z`),
        });
        if (offset > 0 && offset % 3 !== 0) {
          registry.updateVoucherStatus(branch.manager.id, registered.orderSlip.id, 'Claimed');
        }
      }
      if (offset > 0) registry.recordResolution({ date, settlementCode: offset % 3 === 0 ? '279' : offset % 5 === 0 ? '148' : '083', quotaPerUnit: 1040 });
    }
    db.insert('meta', 'demo-seed-v1', { date: today });
  });
}
