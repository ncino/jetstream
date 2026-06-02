import { describe, expect, it } from 'vitest';
import { loadEcaRegistry } from '../eca-registry';

describe('loadEcaRegistry', () => {
  it('loads a single ECA from numbered env vars', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'prod',
      SFDC_ECA_1_LABEL: 'Production',
      SFDC_ECA_1_KEY: 'k1',
      SFDC_ECA_1_SECRET: 's1',
      SFDC_ECA_1_DEFAULT_FOR: 'prod',
    });
    expect(reg.getEcas()).toEqual([
      { id: 'prod', label: 'Production', key: 'k1', secret: 's1', defaultFor: ['https://login.salesforce.com'] },
    ]);
  });

  it('loads multiple ECAs in ascending order', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'prod',
      SFDC_ECA_1_LABEL: 'Production',
      SFDC_ECA_1_KEY: 'k1',
      SFDC_ECA_1_SECRET: 's1',
      SFDC_ECA_2_ID: 'ncinodev',
      SFDC_ECA_2_LABEL: 'nCino Dev',
      SFDC_ECA_2_KEY: 'k2',
      SFDC_ECA_2_SECRET: 's2',
      SFDC_ECA_2_DEFAULT_FOR: 'sandbox',
      SFDC_ECA_3_ID: 'partialdev',
      SFDC_ECA_3_LABEL: 'Partial Dev',
      SFDC_ECA_3_KEY: 'k3',
      SFDC_ECA_3_SECRET: 's3',
    });
    expect(reg.getEcas().map((eca) => eca.id)).toEqual(['prod', 'ncinodev', 'partialdev']);
  });

  it('stops at the first numeric gap', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'a',
      SFDC_ECA_1_LABEL: 'A',
      SFDC_ECA_1_KEY: 'k',
      SFDC_ECA_1_SECRET: 's',
      // SFDC_ECA_2_* missing entirely
      SFDC_ECA_3_ID: 'c',
      SFDC_ECA_3_LABEL: 'C',
      SFDC_ECA_3_KEY: 'k',
      SFDC_ECA_3_SECRET: 's',
    });
    expect(reg.getEcas().map((eca) => eca.id)).toEqual(['a']);
  });

  it('expands DEFAULT_FOR tokens to canonical URLs', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'a',
      SFDC_ECA_1_LABEL: 'A',
      SFDC_ECA_1_KEY: 'k',
      SFDC_ECA_1_SECRET: 's',
      SFDC_ECA_1_DEFAULT_FOR: 'prod,sandbox,pre-release,https://acme.my.salesforce.com',
    });
    expect(reg.getEcas()[0].defaultFor).toEqual([
      'https://login.salesforce.com',
      'https://test.salesforce.com',
      'https://prerellogin.pre.salesforce.com',
      'https://acme.my.salesforce.com',
    ]);
  });

  it('throws when no ECAs are configured and no legacy vars are present', () => {
    expect(() => loadEcaRegistry({})).toThrow(/at least one ECA/i);
  });

  it('throws when ECA ids are not unique', () => {
    expect(() =>
      loadEcaRegistry({
        SFDC_ECA_1_ID: 'dup',
        SFDC_ECA_1_LABEL: 'A',
        SFDC_ECA_1_KEY: 'k',
        SFDC_ECA_1_SECRET: 's',
        SFDC_ECA_2_ID: 'dup',
        SFDC_ECA_2_LABEL: 'B',
        SFDC_ECA_2_KEY: 'k',
        SFDC_ECA_2_SECRET: 's',
      }),
    ).toThrow(/duplicate ECA id/i);
  });

  it('throws when an ECA id has invalid characters', () => {
    expect(() =>
      loadEcaRegistry({
        SFDC_ECA_1_ID: 'Bad ID!',
        SFDC_ECA_1_LABEL: 'A',
        SFDC_ECA_1_KEY: 'k',
        SFDC_ECA_1_SECRET: 's',
      }),
    ).toThrow(/invalid ECA id/i);
  });

  it('throws when both legacy and numbered vars are present', () => {
    expect(() =>
      loadEcaRegistry({
        SFDC_CONSUMER_KEY: 'legacy',
        SFDC_CONSUMER_SECRET: 'legacy',
        SFDC_ECA_1_ID: 'prod',
        SFDC_ECA_1_LABEL: 'Production',
        SFDC_ECA_1_KEY: 'k',
        SFDC_ECA_1_SECRET: 's',
      }),
    ).toThrow(/cannot mix/i);
  });

  it('back-compat shim: registers a synthetic default ECA from legacy vars', () => {
    const reg = loadEcaRegistry({
      SFDC_CONSUMER_KEY: 'legacy-key',
      SFDC_CONSUMER_SECRET: 'legacy-secret',
    });
    expect(reg.getEcas()).toEqual([{ id: 'default', label: 'Default', key: 'legacy-key', secret: 'legacy-secret', defaultFor: [] }]);
  });
});

describe('EcaRegistry lookups', () => {
  const reg = loadEcaRegistry({
    SFDC_ECA_1_ID: 'prod',
    SFDC_ECA_1_LABEL: 'Production',
    SFDC_ECA_1_KEY: 'k1',
    SFDC_ECA_1_SECRET: 's1',
    SFDC_ECA_1_DEFAULT_FOR: 'prod',
    SFDC_ECA_2_ID: 'ncinodev',
    SFDC_ECA_2_LABEL: 'nCino Dev',
    SFDC_ECA_2_KEY: 'k2',
    SFDC_ECA_2_SECRET: 's2',
    SFDC_ECA_2_DEFAULT_FOR: 'sandbox',
    SFDC_ECA_3_ID: 'partialdev',
    SFDC_ECA_3_LABEL: 'Partial Dev',
    SFDC_ECA_3_KEY: 'k3',
    SFDC_ECA_3_SECRET: 's3',
  });

  it('getEcaById returns the matching ECA', () => {
    expect(reg.getEcaById('ncinodev')?.key).toBe('k2');
  });

  it('getEcaById returns null for unknown ids', () => {
    expect(reg.getEcaById('unknown')).toBeNull();
  });

  it('getDefaultEcaForLoginUrl picks the first ECA whose defaultFor includes the URL', () => {
    expect(reg.getDefaultEcaForLoginUrl('https://login.salesforce.com')?.id).toBe('prod');
    expect(reg.getDefaultEcaForLoginUrl('https://test.salesforce.com')?.id).toBe('ncinodev');
  });

  it('getDefaultEcaForLoginUrl falls back to the first ECA when no defaultFor matches', () => {
    expect(reg.getDefaultEcaForLoginUrl('https://acme.my.salesforce.com')?.id).toBe('prod');
  });
});

describe('getLegacyConsumerSecret', () => {
  it('returns SFDC_LEGACY_CONSUMER_SECRET when set', () => {
    const reg = loadEcaRegistry({
      SFDC_LEGACY_CONSUMER_SECRET: 'legacy-decrypt-key',
      SFDC_ECA_1_ID: 'prod',
      SFDC_ECA_1_LABEL: 'Production',
      SFDC_ECA_1_KEY: 'k',
      SFDC_ECA_1_SECRET: 's',
    });
    expect(reg.getLegacyConsumerSecret()).toBe('legacy-decrypt-key');
  });

  it('returns SFDC_CONSUMER_SECRET when only legacy vars are configured (back-compat)', () => {
    const reg = loadEcaRegistry({
      SFDC_CONSUMER_KEY: 'k',
      SFDC_CONSUMER_SECRET: 'legacy-secret',
    });
    expect(reg.getLegacyConsumerSecret()).toBe('legacy-secret');
  });

  it('returns null when nothing is set', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'prod',
      SFDC_ECA_1_LABEL: 'Production',
      SFDC_ECA_1_KEY: 'k',
      SFDC_ECA_1_SECRET: 's',
    });
    expect(reg.getLegacyConsumerSecret()).toBeNull();
  });
});
