import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@jetstream/api-config', () => ({
  ENV: {
    SFDC_CALLBACK_URL: 'https://example.test/cb',
    JETSTREAM_CLIENT_URL: 'https://example.test',
    LOG_LEVEL: 'silent',
    SFDC_API_VERSION: '63.0',
    ENVIRONMENT: 'test',
    CI: false,
    SFDC_CONSUMER_KEY: 'legacy-key',
    SFDC_CONSUMER_SECRET: 'legacy-secret',
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  rollbarServer: { error: vi.fn() },
  getExceptionLog: vi.fn((err) => ({ message: err?.message })),
  getEcaById: vi.fn(),
  getDefaultEcaForLoginUrl: vi.fn(),
}));

vi.mock('@jetstream/salesforce-oauth', () => ({
  salesforceOauthInit: vi.fn(async () => ({
    authorizationUrl: new URL('https://salesforce.test/auth'),
    code_verifier: 'cv',
    nonce: 'nonce',
    state: 'state',
  })),
  salesforceOauthCallback: vi.fn(),
}));

vi.mock('@jetstream/auth/server', () => ({
  getApiAddressFromReq: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../db/salesforce-org.db', () => ({
  findByUniqueId_UNSAFE: vi.fn(),
}));

vi.mock('../../db/organization.db', () => ({
  findById: vi.fn(),
}));

vi.mock('../../services/salesforce-org-encryption.service', () => ({
  encryptAccessToken: vi.fn(),
}));

import * as apiConfig from '@jetstream/api-config';
import * as oauthService from '@jetstream/salesforce-oauth';
import { routeDefinition } from '../oauth.controller';

const FAKE_ECA = {
  id: 'prod',
  label: 'Production',
  key: 'k1',
  secret: 's1',
  defaultFor: ['https://login.salesforce.com'],
};

function makeReq(query: Record<string, string>) {
  return {
    session: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    query,
    params: {},
    body: {},
    externalAuth: undefined,
  } as any;
}

function makeRes() {
  return {
    redirect: vi.fn(),
    locals: { requestId: 'req-1' },
    log: { info: vi.fn(), error: vi.fn() },
  } as any;
}

describe('salesforceOauthInitAuth', () => {
  beforeEach(() => {
    vi.mocked(apiConfig.getEcaById).mockReset();
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReset();
    vi.mocked(oauthService.salesforceOauthInit).mockClear();
  });

  it('uses the ECA matching the supplied ecaId query param', async () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(FAKE_ECA);
    const req = makeReq({ loginUrl: 'https://login.salesforce.com', ecaId: 'prod' });
    const res = makeRes();
    const handler = routeDefinition.salesforceOauthInitAuth.controllerFn();
    await handler(req, res, vi.fn());
    expect(apiConfig.getEcaById).toHaveBeenCalledWith('prod');
    expect(vi.mocked(oauthService.salesforceOauthInit).mock.calls[0][0]).toMatchObject({
      clientId: 'k1',
      clientSecret: 's1',
    });
    expect(req.session.orgAuth.ecaId).toBe('prod');
  });

  it('falls back to the loginUrl-default ECA when no ecaId is given', async () => {
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReturnValue(FAKE_ECA);
    const req = makeReq({ loginUrl: 'https://login.salesforce.com' });
    const res = makeRes();
    const handler = routeDefinition.salesforceOauthInitAuth.controllerFn();
    await handler(req, res, vi.fn());
    expect(apiConfig.getDefaultEcaForLoginUrl).toHaveBeenCalledWith('https://login.salesforce.com');
    expect(req.session.orgAuth.ecaId).toBe('prod');
  });

  it('forwards an error to next() when the supplied ecaId does not exist', async () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(null);
    const req = makeReq({ loginUrl: 'https://login.salesforce.com', ecaId: 'unknown' });
    const res = makeRes();
    const next = vi.fn();
    const handler = routeDefinition.salesforceOauthInitAuth.controllerFn();
    await handler(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const errorArg = next.mock.calls[0][0];
    expect(errorArg).toBeInstanceOf(Error);
    expect(String(errorArg.message)).toMatch(/unknown ecaId/i);
  });
});

describe('salesforceOauthCallback', () => {
  beforeEach(() => {
    vi.mocked(apiConfig.getEcaById).mockReset();
    vi.mocked(oauthService.salesforceOauthCallback).mockReset();
  });

  it('redirects to /oauth-link/ with an error when the session ecaId is no longer configured', async () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(null);
    const req = {
      session: {
        orgAuth: {
          code_verifier: 'cv',
          nonce: 'n',
          state: 's',
          loginUrl: 'https://login.salesforce.com',
          ecaId: 'gone',
        },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      query: {},
      params: {},
      body: {},
      externalAuth: undefined,
    } as any;
    const res = {
      redirect: vi.fn(),
      locals: { requestId: 'req-1' },
      log: { info: vi.fn(), error: vi.fn() },
    } as any;

    const handler = routeDefinition.salesforceOauthCallback.controllerFn();
    await handler(req, res, vi.fn());

    expect(apiConfig.getEcaById).toHaveBeenCalledWith('gone');
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const redirectUrl = res.redirect.mock.calls[0][0] as string;
    expect(redirectUrl).toContain('/oauth-link/');
    expect(redirectUrl).toContain('error=Authentication%20Error');
    expect(vi.mocked(oauthService.salesforceOauthCallback)).not.toHaveBeenCalled();
  });
});
