import { getEcas } from '@jetstream/shared/data';
import { EcaPublic } from '@jetstream/types';
import { useEffect, useState } from 'react';

let cached: EcaPublic[] | null = null;
let inflight: Promise<EcaPublic[]> | null = null;

async function loadEcas(): Promise<EcaPublic[]> {
  if (cached) {
    return cached;
  }
  if (!inflight) {
    inflight = getEcas()
      .then((ecas) => {
        cached = ecas;
        return ecas;
      })
      .catch((error) => {
        inflight = null;
        throw error;
      });
  }
  return inflight;
}

export interface EcaLookup {
  /** Map of ECA id → label. Empty until the fetch resolves. */
  byId: Map<string, string>;
  /** Total number of configured ECAs (0 until fetch resolves or fails). */
  count: number;
}

/**
 * Loads the public ECA list once per session and exposes a quick id-to-label lookup.
 * Returns an empty lookup until the fetch resolves; falls back to empty on failure.
 */
export function useEcaLookup(): EcaLookup {
  const [ecas, setEcas] = useState<EcaPublic[]>(() => cached ?? []);
  useEffect(() => {
    if (cached) {
      return;
    }
    let cancelled = false;
    loadEcas()
      .then((fetched) => {
        if (!cancelled) {
          setEcas(fetched);
        }
      })
      .catch(() => {
        // Endpoint unavailable; lookup remains empty so callers can degrade gracefully.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return {
    byId: new Map(ecas.map((eca) => [eca.id, eca.label])),
    count: ecas.length,
  };
}

/** Test-only hook to clear the module-level cache between tests. */
export function __resetEcaLookupCacheForTests(): void {
  cached = null;
  inflight = null;
}
