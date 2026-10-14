import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../shared/database.ts';
import type { StoreModule } from '../store/index.ts';
import type { StrategyPortfolio, ResolutionEvent } from '../../shared/schemas/domain.ts';
import { OrderSlipSchema, ResolutionEventSchema, VoucherStatusSchema } from '../../shared/schemas/domain.ts';
import { DomainError } from '../../shared/errors.ts';
import { SettlementResultSchema } from '../../shared/schemas/settlement.ts';
import { NonnegativeMonetaryAmountSchema, toMinorUnits } from '../../shared/schemas/money.ts';
import { calculateSettlement } from '../settlement/index.ts';

const RegisteredOrderSchema = z.strictObject({ orderSlip: OrderSlipSchema, managerId: z.uuid() });
export type RegisteredOrder = z.infer<typeof RegisteredOrderSchema>;
const BillSchema = SettlementResultSchema.extend({
  id: z.uuid(), orderSlipId: z.uuid(), storeId: z.uuid(), clientId: z.uuid(), managerId: z.uuid(),
  date: z.iso.date(), clientNetGain: NonnegativeMonetaryAmountSchema,
});
export type SettlementBill = z.infer<typeof BillSchema>;
const VoucherAuditSchema = z.strictObject({
  id: z.uuid(), orderSlipId: z.uuid(), storeId: z.uuid(), clientId: z.uuid(), managerId: z.uuid(),
  fromStatus: z.literal('StoredInShop'), toStatus: z.literal('Claimed'), createdAt: z.date(),
});

function monetaryValue(minor: bigint): number {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Aggregate amount exceeds safe minor-unit precision');
  const result = Number(`${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`);
  if (toMinorUnits(result) !== minor) throw new RangeError('Aggregate amount cannot preserve cent precision');
  return result;
}

export interface RegistryStrategy {
  getPortfolio(date: string): StrategyPortfolio | undefined;
  getResolution(date: string): ResolutionEvent | undefined;
}

export function isOrderHit(selectedCode: string, settlementCode: string, betMode?: string): boolean {
  if (!betMode || betMode === 'DIRECT') {
    return selectedCode === settlementCode;
  }
  return [...selectedCode].sort().join('') === [...settlementCode].sort().join('');
}

export function getOrderQuota(selectedCode: string, baseQuota: number, betMode?: string): number {
  if (!betMode || betMode === 'DIRECT') {
    return baseQuota;
  }
  const digits = new Set(selectedCode);
  if (digits.size === 2) {
    return baseQuota === 1040 ? 346 : Math.round((baseQuota * 346) / 1040 * 100) / 100;
  }
  return baseQuota === 1040 ? 173 : Math.round((baseQuota * 173) / 1040 * 100) / 100;
}

export function createRegistryModule(db: AppDatabase, stores: StoreModule, strategy: RegistryStrategy) {
  function requireStore(id: string) {
    if (!stores.getStore(id)) throw new DomainError('Store does not exist', 404);
  }
  function allOrders(): RegisteredOrder[] {
    return db.list('registration').map((item) => RegisteredOrderSchema.parse(item));
  }
  function allBills(): SettlementBill[] {
    return db.list('bill').map((item) => BillSchema.parse(item));
  }
  return {
    registerOrder(managerId: string, input: unknown): RegisteredOrder {
      const registered = RegisteredOrderSchema.parse({ managerId, orderSlip: input });
      return db.transaction(() => {
        const { orderSlip } = registered;
        if (strategy.getResolution(orderSlip.date)) throw new DomainError('OrderSlip date is already resolved');
        requireStore(orderSlip.storeId);
        const manager = stores.getManager(managerId);
        const client = stores.getClient(orderSlip.clientId);
        if (!manager || manager.storeId !== orderSlip.storeId) throw new DomainError('StoreManager does not belong to this Store');
        if (!client || client.storeId !== orderSlip.storeId || client.managerId !== managerId) throw new DomainError('Client does not belong to this StoreManager');
        if (orderSlip.adoptedStrategy) {
          const portfolio = strategy.getPortfolio(orderSlip.date);
          if (!portfolio || !portfolio.combos.some((combo) => combo.code === orderSlip.selectedCode)) {
            throw new DomainError('Selected code must belong to the dated StrategyPortfolio');
          }
        }
        db.insert('registration', registered.orderSlip.id, registered);
        return registered;
      });
    },
    listOrders(storeId: string, managerId?: string): RegisteredOrder[] {
      requireStore(storeId);
      return allOrders().filter((registered) => registered.orderSlip.storeId === storeId
        && (managerId === undefined || registered.managerId === managerId));
    },
    listAllOrders(filters?: { storeId?: string | undefined; managerId?: string | undefined; date?: string | undefined; clientId?: string | undefined }): RegisteredOrder[] {
      return allOrders().filter(({ orderSlip, managerId }) => {
        if (filters?.storeId && orderSlip.storeId !== filters.storeId) return false;
        if (filters?.managerId && managerId !== filters.managerId) return false;
        if (filters?.date && orderSlip.date !== filters.date) return false;
        if (filters?.clientId && orderSlip.clientId !== filters.clientId) return false;
        return true;
      });
    },
    listClientOrders(clientId: string): RegisteredOrder[] {
      if (!stores.getClient(clientId)) throw new DomainError('客户档案不存在', 404);
      return allOrders().filter(({ orderSlip }) => orderSlip.clientId === clientId);
    },
    updateVoucherStatus(managerId: string, orderId: string, status: unknown): RegisteredOrder {
      z.uuid().parse(managerId); z.uuid().parse(orderId);
      const voucherStatus = VoucherStatusSchema.parse(status);
      return db.transaction(() => {
        const value = db.get('registration', orderId);
        if (value === undefined) throw new DomainError('历史存根不存在', 404);
        const record = RegisteredOrderSchema.parse(value);
        const manager = stores.getManager(managerId);
        const client = stores.getClient(record.orderSlip.clientId);
        if (!manager || manager.storeId !== record.orderSlip.storeId || record.managerId !== managerId
          || client?.managerId !== managerId) throw new DomainError('仅归属店长可登记凭证领取', 403);
        if (record.orderSlip.voucherStatus === voucherStatus) return record;
        if (voucherStatus !== 'Claimed') throw new DomainError('已领取的凭证不能改回店内存管');
        const updated = { ...record, orderSlip: { ...record.orderSlip, voucherStatus } };
        db.set('registration', orderId, updated);
        const audit = VoucherAuditSchema.parse({
          id: randomUUID(), orderSlipId: orderId, storeId: record.orderSlip.storeId,
          clientId: record.orderSlip.clientId, managerId, fromStatus: 'StoredInShop', toStatus: 'Claimed', createdAt: new Date(),
        });
        db.insert('voucher_audit', audit.id, audit);
        return updated;
      });
    },
    listVoucherAudits(storeId: string) {
      requireStore(storeId);
      return db.list('voucher_audit').map(item => VoucherAuditSchema.parse(item)).filter(item => item.storeId === storeId);
    },
    recordResolution(input: unknown): { resolution: ResolutionEvent; bills: SettlementBill[] } {
      const resolution = ResolutionEventSchema.parse(input);
      return db.transaction(() => {
        const existing = strategy.getResolution(resolution.date);
        if (existing) {
          if (existing.settlementCode !== resolution.settlementCode || existing.quotaPerUnit !== resolution.quotaPerUnit) {
            throw new DomainError('ResolutionEvent conflicts with the recorded date');
          }
          return { resolution: existing, bills: allBills().filter((bill) => bill.date === resolution.date) };
        }
        db.insert('resolution', resolution.date, resolution);
        const bills = allOrders().filter(({ orderSlip }) => orderSlip.date === resolution.date).map(({ orderSlip, managerId }) => {
          const isHit = isOrderHit(orderSlip.selectedCode, resolution.settlementCode, orderSlip.betMode);
          const quotaPerUnit = getOrderQuota(orderSlip.selectedCode, resolution.quotaPerUnit, orderSlip.betMode);
          const result = calculateSettlement({
            totalAmount: orderSlip.totalAmount, quantity: orderSlip.quantity,
            quotaPerUnit, isHit,
            adoptedStrategy: orderSlip.adoptedStrategy,
          });
          const bill: SettlementBill = {
            id: orderSlip.id, orderSlipId: orderSlip.id, storeId: orderSlip.storeId, clientId: orderSlip.clientId,
            managerId, date: orderSlip.date, ...result,
            clientNetGain: monetaryValue(toMinorUnits(result.netGain) - toMinorUnits(result.performanceFee)),
          };
          db.insert('bill', bill.id, bill);
          return bill;
        });
        return { resolution, bills };
      });
    },
    listBills(storeId: string, managerId?: string): SettlementBill[] {
      requireStore(storeId);
      return allBills().filter((bill) => bill.storeId === storeId && (managerId === undefined || bill.managerId === managerId));
    },
    summarize(storeId: string, managerId?: string) {
      requireStore(storeId);
      const orders = allOrders().filter(record => record.orderSlip.storeId === storeId && (managerId === undefined || record.managerId === managerId));
      const bills = allBills().filter((bill) => bill.storeId === storeId && (managerId === undefined || bill.managerId === managerId));
      const sum = (amounts: number[]) => monetaryValue(amounts.reduce((total, amount) => total + toMinorUnits(amount), 0n));
      return {
        storeId, orderCount: orders.length, settledCount: bills.length,
        totalAmount: sum(orders.map(({ orderSlip }) => orderSlip.totalAmount)),
        grossGain: sum(bills.map((bill) => bill.grossGain)),
        netGain: sum(bills.map((bill) => bill.netGain)),
        performanceFee: sum(bills.map((bill) => bill.performanceFee)),
        managerIncentive: sum(bills.map((bill) => bill.managerIncentive)),
        platformMargin: sum(bills.map((bill) => bill.platformMargin)),
        clientNetGain: sum(bills.map((bill) => bill.clientNetGain)),
      };
    },
  };
}

export type RegistryModule = ReturnType<typeof createRegistryModule>;
