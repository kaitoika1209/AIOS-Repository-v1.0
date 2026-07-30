import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.string().startsWith('postgresql://'),
  AIOS_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  AIOS_WORKER_ROLES: z.string().min(1),
  CLERK_ISSUER_URL: z.url().startsWith('https://'),
  OPENAI_API_KEY_REF: z.string().min(1),
});

export type AiosEnvironment = z.infer<typeof environmentSchema>;

export function parseEnvironment(input: Record<string, string | undefined>): AiosEnvironment {
  return environmentSchema.parse(input);
}
