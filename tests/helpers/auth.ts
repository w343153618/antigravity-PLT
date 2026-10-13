import { expect } from 'vitest';
import type { buildApp } from '../../src/app/app.ts';
import type { Actor } from '../../src/app/access.ts';
import type { InjectOptions } from 'fastify';

export const authOptions = { bootstrapPassword: 'Test-only-password-42' };

export async function login(app: Awaited<ReturnType<typeof buildApp>>, username: 'admin' | 'dianzhang' | 'user', previous?: string) {
  const response = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: authOptions.bootstrapPassword },
    headers: previous ? { cookie: previous } : {},
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict');
  const cookie = String(response.headers['set-cookie']).split(';')[0]!;
  return {
    actor: response.json<Actor>(), cookie, headers: { cookie },
    inject(input: string | InjectOptions) {
      const options = typeof input === 'string' ? { url: input } : input;
      return app.inject({ ...options, headers: { cookie, ...options.headers } });
    },
  };
}
