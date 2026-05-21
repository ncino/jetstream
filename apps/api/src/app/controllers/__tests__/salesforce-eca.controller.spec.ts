import { describe, expect, it, vi } from 'vitest';

vi.mock('@jetstream/api-config', () => ({
  ENV: {
    ENVIRONMENT: 'test',
    CI: false,
    SFDC_API_VERSION: '63.0',
    JETSTREAM_CLIENT_URL: 'https://example.test',
    LOG_LEVEL: 'silent',
  },
  getEcas: vi.fn(),
  getExceptionLog: vi.fn(() => ({})),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  rollbarServer: { error: vi.fn() },
}));

vi.mock('@jetstream/auth/server', () => ({
  getApiAddressFromReq: vi.fn(() => '127.0.0.1'),
}));

import * as apiConfig from '@jetstream/api-config';
import { routeDefinition } from '../salesforce-eca.controller';

function makeReq() {
  return {
    session: { user: { id: 'u1' } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    query: {},
    params: {},
    body: {},
    externalAuth: undefined,
  } as any;
}

function makeRes() {
  return {
    json: vi.fn(),
    locals: { requestId: 'req-1' },
    log: { info: vi.fn(), error: vi.fn() },
  } as any;
}

describe('listEcas', () => {
  it('returns id/label/defaultFor only, never key/secret', async () => {
    vi.mocked(apiConfig.getEcas).mockReturnValue([
      { id: 'prod', label: 'Production', key: 'SECRET-KEY', secret: 'SECRET', defaultFor: ['https://login.salesforce.com'] },
      { id: 'ncinodev', label: 'nCino Dev', key: 'K2', secret: 'S2', defaultFor: ['https://test.salesforce.com'] },
    ]);

    const handler = routeDefinition.listEcas.controllerFn();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      ecas: [
        { id: 'prod', label: 'Production', defaultFor: ['https://login.salesforce.com'] },
        { id: 'ncinodev', label: 'nCino Dev', defaultFor: ['https://test.salesforce.com'] },
      ],
    });
  });
});
