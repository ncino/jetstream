import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@jetstream/api-config', () => ({
  ENV: {
    SFDC_ENCRYPTION_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
    SFDC_ENCRYPTION_ITERATIONS: 10000,
    SFDC_ENCRYPTION_CACHE_MAX_ENTRIES: 10,
    SFDC_ENCRYPTION_CACHE_TTL_MS: 1000,
    LOG_LEVEL: 'silent',
  },
  getLegacyConsumerSecret: vi.fn(),
  getExceptionLog: vi.fn(() => ({})),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  rollbarServer: { error: vi.fn() },
}));

vi.mock('@jetstream/shared/node-utils', () => ({
  encryptString: vi.fn((data: string, key: string) => `enc(${data}|${key})`),
  decryptString: vi.fn((data: string, key: string) => {
    if (data.startsWith('legacy|') && key === 'legacy-base64') {
      return data.slice('legacy|'.length);
    }
    if (data === 'mismatch') {
      throw new Error('decrypt failed');
    }
    return data;
  }),
  hexToBase64: vi.fn((hex: string) => `${hex}-base64`),
}));

import * as apiConfig from '@jetstream/api-config';
import { decryptAccessToken, DUMMY_INVALID_ENCRYPTED_TOKEN } from '../salesforce-org-encryption.service';

describe('decryptAccessToken (v1 legacy path)', () => {
  beforeEach(() => {
    vi.mocked(apiConfig.getLegacyConsumerSecret).mockReset();
  });

  it('decrypts using SFDC_LEGACY_CONSUMER_SECRET when present', async () => {
    vi.mocked(apiConfig.getLegacyConsumerSecret).mockReturnValue('legacy');
    const [access, refresh] = await decryptAccessToken({
      encryptedAccessToken: 'legacy|access refresh',
      userId: 'u',
    });
    expect(access).toBe('access');
    expect(refresh).toBe('refresh');
  });

  it('returns DUMMY_INVALID_ENCRYPTED_TOKEN when SFDC_LEGACY_CONSUMER_SECRET is unset', async () => {
    vi.mocked(apiConfig.getLegacyConsumerSecret).mockReturnValue(null);
    const [access, refresh] = await decryptAccessToken({
      encryptedAccessToken: 'mismatch',
      userId: 'u',
    });
    expect(access).toBe(DUMMY_INVALID_ENCRYPTED_TOKEN);
    expect(refresh).toBe(DUMMY_INVALID_ENCRYPTED_TOKEN);
  });
});
