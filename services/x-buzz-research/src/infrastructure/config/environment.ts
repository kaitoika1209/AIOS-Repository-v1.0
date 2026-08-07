export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ComposerSettings {
  readonly model: string;
  readonly effort: Effort;
}

export function readComposerSettings(env: NodeJS.ProcessEnv = process.env): ComposerSettings {
  const effort = env.X_BUZZ_EFFORT?.trim().toLowerCase();
  if (effort !== undefined && effort !== '' && !EFFORTS.includes(effort as Effort)) {
    throw new Error(`X_BUZZ_EFFORT must be one of: ${EFFORTS.join(', ')}. Received "${effort}".`);
  }

  return {
    model: env.X_BUZZ_MODEL?.trim() || 'claude-opus-5',
    effort: (effort as Effort | undefined) || 'high',
  };
}

export function requireApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Composing drafts needs it; `research` does not. ' +
        'Copy .env.example to .env and fill it in, or export the variable.',
    );
  }
  return apiKey;
}
