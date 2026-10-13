import { z } from 'zod';

export function readServerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const port = z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1024).max(65535)).parse(environment.PORT ?? '19888');
  return {
    port,
    host: environment.HOST ?? '127.0.0.1',
    databasePath: environment.DATABASE_PATH ?? 'data/app.db',
    seed: environment.DEMO_SEED !== 'false',
  };
}
