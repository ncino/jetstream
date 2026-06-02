import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@jetstream/shared/data', () => ({
  getEcas: vi.fn(),
}));

import * as data from '@jetstream/shared/data';
import { __resetEcaLookupCacheForTests, useEcaLookup } from '../useEcaLookup';

const mockEcas = [
  { id: 'prod', label: 'Production', defaultFor: ['https://login.salesforce.com'] },
  { id: 'ncinodev', label: 'nCino Dev', defaultFor: ['https://test.salesforce.com'] },
];

describe('useEcaLookup', () => {
  beforeEach(() => {
    __resetEcaLookupCacheForTests();
    vi.mocked(data.getEcas).mockReset();
  });

  it('returns an empty lookup before the fetch resolves', () => {
    vi.mocked(data.getEcas).mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useEcaLookup());
    expect(result.current.byId.size).toBe(0);
    expect(result.current.count).toBe(0);
  });

  it('populates the lookup after the fetch resolves', async () => {
    vi.mocked(data.getEcas).mockResolvedValue(mockEcas);
    const { result } = renderHook(() => useEcaLookup());
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(result.current.byId.get('prod')).toBe('Production');
    expect(result.current.byId.get('ncinodev')).toBe('nCino Dev');
  });

  it('does not refetch on remount once cached', async () => {
    vi.mocked(data.getEcas).mockResolvedValue(mockEcas);
    const first = renderHook(() => useEcaLookup());
    await waitFor(() => expect(first.result.current.count).toBe(2));
    first.unmount();

    const second = renderHook(() => useEcaLookup());
    expect(second.result.current.count).toBe(2);
    expect(vi.mocked(data.getEcas)).toHaveBeenCalledTimes(1);
  });

  it('returns an empty lookup if the fetch rejects', async () => {
    vi.mocked(data.getEcas).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useEcaLookup());
    // Wait a microtask for the rejection to settle
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.count).toBe(0);
  });
});
