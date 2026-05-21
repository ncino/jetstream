const ID_PATTERN = /^[a-z0-9-]+$/;

const TOKEN_TO_URL: Record<string, string> = {
  prod: 'https://login.salesforce.com',
  sandbox: 'https://test.salesforce.com',
  'pre-release': 'https://prerellogin.pre.salesforce.com',
};

export type EcaConfig = {
  id: string;
  label: string;
  key: string;
  secret: string;
  defaultFor: string[];
};

export type EcaPublic = Pick<EcaConfig, 'id' | 'label' | 'defaultFor'>;

export type EcaRegistry = {
  getEcas(): EcaConfig[];
  getEcaById(id: string): EcaConfig | null;
  getDefaultEcaForLoginUrl(loginUrl: string): EcaConfig | null;
  getLegacyConsumerSecret(): string | null;
};

function expandDefaultFor(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (entry.startsWith('https://')) {
        return entry;
      }
      const expanded = TOKEN_TO_URL[entry];
      if (!expanded) {
        throw new Error(`Unknown DEFAULT_FOR token: ${entry}`);
      }
      return expanded;
    });
}

function readNumberedEcas(env: Record<string, string | undefined>): EcaConfig[] {
  const ecas: EcaConfig[] = [];
  for (let n = 1; ; n++) {
    const id = env[`SFDC_ECA_${n}_ID`];
    if (!id) {
      break;
    }
    const label = env[`SFDC_ECA_${n}_LABEL`];
    const key = env[`SFDC_ECA_${n}_KEY`];
    const secret = env[`SFDC_ECA_${n}_SECRET`];
    const defaultForRaw = env[`SFDC_ECA_${n}_DEFAULT_FOR`];

    if (!ID_PATTERN.test(id)) {
      throw new Error(`Invalid ECA id at position ${n}: "${id}" — must match ${ID_PATTERN}`);
    }
    if (!label || !key || !secret) {
      throw new Error(`ECA at position ${n} is missing one of LABEL/KEY/SECRET`);
    }

    ecas.push({
      id,
      label,
      key,
      secret,
      defaultFor: expandDefaultFor(defaultForRaw),
    });
  }
  return ecas;
}

export function loadEcaRegistry(env: Record<string, string | undefined>): EcaRegistry {
  const numbered = readNumberedEcas(env);
  const hasLegacy = Boolean(env.SFDC_CONSUMER_KEY && env.SFDC_CONSUMER_SECRET);

  if (numbered.length > 0 && hasLegacy) {
    throw new Error(
      'Cannot mix legacy SFDC_CONSUMER_KEY/SECRET with numbered SFDC_ECA_N_* vars. Remove the legacy vars or remove the numbered vars.',
    );
  }

  let ecas = numbered;
  if (ecas.length === 0 && hasLegacy) {
    ecas = [
      {
        id: 'default',
        label: 'Default',
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        key: env.SFDC_CONSUMER_KEY!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        secret: env.SFDC_CONSUMER_SECRET!,
        defaultFor: [],
      },
    ];
  }

  if (ecas.length === 0) {
    throw new Error(
      'At least one ECA must be configured. Set SFDC_ECA_1_ID/LABEL/KEY/SECRET (preferred) or SFDC_CONSUMER_KEY/SECRET (legacy).',
    );
  }

  const seen = new Set<string>();
  for (const eca of ecas) {
    if (seen.has(eca.id)) {
      throw new Error(`Duplicate ECA id: "${eca.id}"`);
    }
    seen.add(eca.id);
  }

  const legacySecret = env.SFDC_LEGACY_CONSUMER_SECRET || (hasLegacy ? env.SFDC_CONSUMER_SECRET : undefined) || null;

  return {
    getEcas: () => ecas,
    getEcaById: (id) => ecas.find((eca) => eca.id === id) ?? null,
    getDefaultEcaForLoginUrl: (loginUrl) => ecas.find((eca) => eca.defaultFor.includes(loginUrl)) ?? ecas[0] ?? null,
    getLegacyConsumerSecret: () => legacySecret,
  };
}

let cached: EcaRegistry | null = null;
export function getEcaRegistry(): EcaRegistry {
  if (!cached) {
    cached = loadEcaRegistry(process.env);
  }
  return cached;
}

export function resetEcaRegistryForTests(): void {
  cached = null;
}

export function getEcas(): EcaConfig[] {
  return getEcaRegistry().getEcas();
}

export function getEcaById(id: string): EcaConfig | null {
  return getEcaRegistry().getEcaById(id);
}

export function getDefaultEcaForLoginUrl(loginUrl: string): EcaConfig | null {
  return getEcaRegistry().getDefaultEcaForLoginUrl(loginUrl);
}

export function getLegacyConsumerSecret(): string | null {
  return getEcaRegistry().getLegacyConsumerSecret();
}
