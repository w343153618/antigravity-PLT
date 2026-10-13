import { z } from 'zod';
import type { RegistryModule } from '../registry/index.ts';
import type { StrategyModule } from '../strategy/index.ts';

export interface OfficialLotteryDraw {
  issue: string;
  date: string;
  code: string;
  quotaPerUnit: number;
}

const HuiniaoItemSchema = z.object({
  code: z.string(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  one: z.number().int().min(0).max(9),
  two: z.number().int().min(0).max(9),
  three: z.number().int().min(0).max(9),
});

const HuiniaoResponseSchema = z.object({
  code: z.number(),
  data: z.object({
    data: z.object({
      list: z.array(HuiniaoItemSchema),
    }),
  }),
});

const SportteryListSchema = z.object({
  value: z.object({
    list: z.array(z.object({
      lotteryDrawNum: z.string(),
      lotteryDrawTime: z.string(),
      lotteryDrawResult: z.string(),
      prizeLevelList: z.array(z.object({
        prizeLevel: z.string(),
        stakeAmountFormat: z.string().optional(),
      })).optional(),
    })),
  }),
});

export async function fetchOfficialDraws(limit = 30, fetchImpl = fetch): Promise<OfficialLotteryDraw[]> {
  // Source 1: Huiniao public lottery API (accessible globally)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetchImpl(`http://api.huiniao.top/interface/home/lotteryHistory?type=pls&page=1&limit=${limit}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const json = await res.json();
      const parsed = HuiniaoResponseSchema.safeParse(json);
      if (parsed.success && parsed.data.data.data.list.length > 0) {
        return parsed.data.data.data.list.map(item => ({
          issue: item.code,
          date: item.day,
          code: `${item.one}${item.two}${item.three}`,
          quotaPerUnit: 1040,
        }));
      }
    }
  } catch {
    // Fallback to official sporttery gateway
  }

  // Source 2: China Sports Lottery official gateway
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetchImpl(`https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=35&provinceId=0&pageSize=${limit}&isVerify=1&pageNo=1`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.lottery.gov.cn/',
      },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const json = await res.json();
      const parsed = SportteryListSchema.safeParse(json);
      if (parsed.success && parsed.data.value.list.length > 0) {
        return parsed.data.value.list.map(item => {
          const rawCode = item.lotteryDrawResult.replace(/\s+/g, '');
          const straightStake = item.prizeLevelList?.find(p => p.prizeLevel === '直选')?.stakeAmountFormat;
          const quota = straightStake ? Number(straightStake.replace(/,/g, '')) || 1040 : 1040;
          return {
            issue: item.lotteryDrawNum,
            date: item.lotteryDrawTime.slice(0, 10),
            code: rawCode.slice(0, 3),
            quotaPerUnit: quota,
          };
        }).filter(item => /^\d{3}$/.test(item.code) && /^\d{4}-\d{2}-\d{2}$/.test(item.date));
      }
    }
  } catch {
    // Both failed
  }

  return [];
}

export interface SyncResult {
  synced: Array<{ date: string; code: string; issue: string }>;
  skipped: string[];
  errors: Array<{ date: string; error: string }>;
}

export async function syncOfficialResolutions(
  registry: RegistryModule,
  strategy: StrategyModule,
  options: { limit?: number; fetchImpl?: typeof fetch } = {}
): Promise<SyncResult> {
  const draws = await fetchOfficialDraws(options.limit ?? 30, options.fetchImpl);
  const result: SyncResult = { synced: [], skipped: [], errors: [] };

  for (const draw of draws) {
    const existing = strategy.getResolution(draw.date);
    if (existing) {
      result.skipped.push(draw.date);
      continue;
    }
    try {
      registry.recordResolution({
        date: draw.date,
        settlementCode: draw.code,
        quotaPerUnit: draw.quotaPerUnit,
      });
      result.synced.push({ date: draw.date, code: draw.code, issue: draw.issue });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ date: draw.date, error: msg });
    }
  }

  return result;
}
