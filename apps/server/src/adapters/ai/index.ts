import type { Config } from '../../config.js';
import type { PreCheckProvider } from '../../ports/index.js';
import { AnthropicPreCheckProvider } from './anthropic.js';
import { MockPreCheckProvider } from './mock.js';

/** `off` returns undefined: the HTTP layer then hides the feature and nothing else changes. */
export function createPreCheckProvider(config: Pick<Config, 'AI_PROVIDER' | 'ANTHROPIC_API_KEY' | 'AI_MODEL'>): PreCheckProvider | undefined {
  switch (config.AI_PROVIDER) {
    case 'off':
      return undefined;
    case 'mock':
      return new MockPreCheckProvider();
    case 'anthropic':
      return new AnthropicPreCheckProvider(config.ANTHROPIC_API_KEY!, config.AI_MODEL);
  }
}
