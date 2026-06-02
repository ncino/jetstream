import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@jetstream/api-config', () => ({
  ENV: {
    ENVIRONMENT: 'test',
    CI: false,
    SFDC_API_VERSION: '63.0',
    JETSTREAM_CLIENT_URL: 'https://example.test',
    LOG_LEVEL: 'silent',
    SFDC_CONSUMER_KEY: '',
    SFDC_CONSUMER_SECRET: '',
    BASIC_AUTH_USERNAME: 'u',
    BASIC_AUTH_PASSWORD: 'p',
  },
  createRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  getExceptionLog: vi.fn(() => ({})),
  getEcaById: vi.fn(),
  getDefaultEcaForLoginUrl: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  rollbarServer: { error: vi.fn() },
}));

vi.mock('@jetstream/auth/server', () => ({
  AuthError: class extends Error {},
  checkUserAgentSimilarity: vi.fn(),
  createUserActivityFromReq: vi.fn(),
  ExpiredVerificationToken: class extends Error {},
  generateHMACDoubleCSRFToken: vi.fn(),
  getApiAddressFromReq: vi.fn(() => '127.0.0.1'),
  getCookieConfig: vi.fn(() => ({})),
  InvalidCaptcha: class extends Error {},
  MissingEntitlement: class extends Error {},
  PLACEHOLDER_USER_ID: 'placeholder',
  validateHMACDoubleCSRFToken: vi.fn(),
}));

vi.mock('@jetstream/salesforce-api', () => ({
  ApiConnection: vi.fn(),
  getApiRequestFactoryFn: vi.fn(),
  ApiRequestError: class extends Error {},
}));

vi.mock('../../db/salesforce-org.db', () => ({
  findByUniqueId_UNSAFE: vi.fn(),
  updateAccessToken_UNSAFE: vi.fn(),
  updateOrg_UNSAFE: vi.fn(),
  clearExpiration: vi.fn(),
  updateLastActivity: vi.fn(),
}));

vi.mock('../../db/user.db', () => ({
  checkUserEntitlement: vi.fn(),
}));

vi.mock('../../services/salesforce-org-encryption.service', () => ({
  decryptAccessToken: vi.fn(),
  DUMMY_INVALID_ENCRYPTED_TOKEN: '__invalid__',
}));

import * as apiConfig from '@jetstream/api-config';
import { resolveEcaForOrg } from '../route.middleware';

const ECA_PROD = {
  id: 'prod',
  label: 'Prod',
  key: 'k1',
  secret: 's1',
  defaultFor: ['https://login.salesforce.com'],
};

const ECA_FALLBACK = {
  id: 'ncinodev',
  label: 'nCino',
  key: 'k2',
  secret: 's2',
  defaultFor: ['https://test.salesforce.com'],
};

describe('resolveEcaForOrg', () => {
  beforeEach(() => {
    vi.mocked(apiConfig.getEcaById).mockReset();
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReset();
  });

  it('uses the persisted ecaId when present and valid', () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(ECA_PROD);
    const result = resolveEcaForOrg({ ecaId: 'prod', loginUrl: 'https://login.salesforce.com' });
    expect(result).toEqual({ eca: ECA_PROD, fallbackUsed: false });
    expect(apiConfig.getDefaultEcaForLoginUrl).not.toHaveBeenCalled();
  });

  it('falls back to loginUrl default when persisted ecaId is unknown', () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(null);
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReturnValue(ECA_FALLBACK);
    const result = resolveEcaForOrg({ ecaId: 'gone', loginUrl: 'https://test.salesforce.com' });
    expect(result).toEqual({
      eca: ECA_FALLBACK,
      fallbackUsed: true,
      reason: 'unknown-eca-id',
      requestedEcaId: 'gone',
    });
  });

  it('uses loginUrl default when no ecaId is persisted (legacy rows)', () => {
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReturnValue(ECA_FALLBACK);
    const result = resolveEcaForOrg({ ecaId: null, loginUrl: 'https://test.salesforce.com' });
    expect(result).toEqual({ eca: ECA_FALLBACK, fallbackUsed: false });
  });

  it('returns null when neither persisted nor default ECA resolves', () => {
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReturnValue(null);
    const result = resolveEcaForOrg({ ecaId: null, loginUrl: 'https://login.salesforce.com' });
    expect(result).toEqual({ eca: null, fallbackUsed: false });
  });
});
