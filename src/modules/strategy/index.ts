import { z } from 'zod';
import { ResolutionEventSchema, StrategyPortfolioSchema } from '../../shared/schemas/index.ts';
import type { OutcomeStatus, ResolutionEvent, StrategyPortfolio } from '../../shared/schemas/index.ts';
import type { AppDatabase } from '../../shared/database.ts';
import { DomainError } from '../../shared/errors.ts';

export interface CalendarDay {
  date: string;
  portfolio: StrategyPortfolio | null;
  resolution: ResolutionEvent | null;
  status: OutcomeStatus | null;
}

export interface StrategyEvaluator<TInput, TOutcome> {
  evaluate(input: TInput): TOutcome;
}

const threeDigitEvaluator: StrategyEvaluator<{
  portfolio: StrategyPortfolio;
  resolution: ResolutionEvent;
}, OutcomeStatus> = {
  evaluate: ({ portfolio, resolution }) => portfolio.combos.some((combo) => combo.code === resolution.settlementCode) ? 'Hit' : 'Miss',
};

export function generateCalendar(
  endDate: string,
  portfolios: StrategyPortfolio[],
  resolutions: ResolutionEvent[],
): CalendarDay[] {
  const validatedEnd = z.iso.date().refine((date) => date >= '0000-01-30', 'Calendar window must fit within four-digit years').parse(endDate);
  const uniqueDates = <T extends { date: string }>(items: T[]) => new Set(items.map((item) => item.date)).size === items.length;
  const validPortfolios = structuredClone(z.array(StrategyPortfolioSchema).refine(uniqueDates, 'Duplicate StrategyPortfolio date').parse(portfolios));
  const validResolutions = z.array(ResolutionEventSchema).refine(uniqueDates, 'Duplicate ResolutionEvent date').parse(resolutions);
  const end = new Date(`${validatedEnd}T00:00:00.000Z`);
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - 29 + index);
    const date = day.toISOString().slice(0, 10);
    const portfolio = validPortfolios.find((item) => item.date === date) ?? null;
    const resolution = validResolutions.find((item) => item.date === date) ?? null;
    const status = portfolio && resolution ? threeDigitEvaluator.evaluate({ portfolio, resolution }) : null;
    return { date, portfolio, resolution, status };
  });
}

export function createStrategyModule(db: AppDatabase) {
  function getPortfolio(date: string): StrategyPortfolio | undefined {
    const record = db.get('portfolio', z.iso.date().parse(date));
    return record === undefined ? undefined : StrategyPortfolioSchema.parse(record);
  }

  function getResolution(date: string): ResolutionEvent | undefined {
    const record = db.get('resolution', z.iso.date().parse(date));
    return record === undefined ? undefined : ResolutionEventSchema.parse(record);
  }

  function listPortfolios(): StrategyPortfolio[] {
    return z.array(StrategyPortfolioSchema).parse(db.list('portfolio')).sort((left, right) => left.date.localeCompare(right.date));
  }

  function getCalendar(endDate: string): CalendarDay[] {
    const resolutions = z.array(ResolutionEventSchema).parse(db.list('resolution'));
    return generateCalendar(endDate, listPortfolios(), resolutions);
  }

  function publishPortfolio(input: unknown): StrategyPortfolio {
    const portfolio = StrategyPortfolioSchema.parse(input);
    return db.transaction(() => {
      if (db.get('resolution', portfolio.date) !== undefined) {
        throw new DomainError('StrategyPortfolio cannot be published after its ResolutionEvent');
      }
      if (db.list('portfolio').some((item) => StrategyPortfolioSchema.parse(item).id === portfolio.id)) {
        throw new DomainError('StrategyPortfolio ID already exists');
      }
      db.insert('portfolio', portfolio.date, portfolio);
      return portfolio;
    });
  }

  function updatePortfolio(date: string, input: unknown): StrategyPortfolio {
    const validDate = z.iso.date().parse(date);
    const existing = db.get('portfolio', validDate);
    if (!existing) throw new DomainError('未找到该日期的策略组合，无法修改', 404);
    if (db.get('resolution', validDate) !== undefined) {
      throw new DomainError('该日期已录入决议，无法再修改策略');
    }
    const current = StrategyPortfolioSchema.parse(existing);
    const updated = StrategyPortfolioSchema.parse({
      ...(typeof input === 'object' && input !== null ? input : {}),
      id: current.id,
      date: validDate,
      createdAt: current.createdAt,
    });
    return db.transaction(() => {
      db.set('portfolio', validDate, updated);
      return updated;
    });
  }

  return { publishPortfolio, updatePortfolio, getPortfolio, getResolution, listPortfolios, getCalendar };
}

export type StrategyModule = ReturnType<typeof createStrategyModule>;
