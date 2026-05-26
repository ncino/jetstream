import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { atom } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@jetstream/shared/data', () => ({
  getEcas: vi.fn(),
}));

vi.mock('@jetstream/shared/ui-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@jetstream/shared/ui-utils')>();
  return {
    ...actual,
    addOrg: vi.fn(),
  };
});

vi.mock('@jetstream/ui/app-state', () => {
  const applicationCookieAtom = atom({ serverUrl: 'https://example.test' });
  const orgGroupAtom = atom(null);
  return {
    fromAppState: {
      applicationCookieState: applicationCookieAtom,
      jetstreamActiveGroupSelector: orgGroupAtom,
    },
  };
});

vi.mock('../../analytics', () => ({
  useAmplitude: () => ({ trackEvent: vi.fn() }),
}));

import * as data from '@jetstream/shared/data';
import { AddOrg } from '../AddOrg';

const mockEcas = [
  { id: 'prod', label: 'Production', defaultFor: ['https://login.salesforce.com'] },
  { id: 'sandbox', label: 'Sandbox App', defaultFor: ['https://test.salesforce.com'] },
  { id: 'partner', label: 'Partner App', defaultFor: [] },
];

async function openPopoverAndWait() {
  fireEvent.click(screen.getByRole('button', { name: /add org/i }));
  await waitFor(() => screen.getByLabelText(/connected app/i));
  return screen.getByLabelText(/connected app/i) as HTMLSelectElement;
}

beforeEach(() => {
  vi.mocked(data.getEcas).mockResolvedValue(mockEcas);
});

describe('AddOrg ECA dropdown', () => {
  it('defaults to the ECA whose defaultFor matches the current login URL', async () => {
    const onAddOrg = vi.fn();
    render(<AddOrg onAddOrg={onAddOrg} />);
    const select = await openPopoverAndWait();
    await waitFor(() => expect(select.value).toBe('prod'));
  });

  it('snaps default when the user changes org type', async () => {
    const onAddOrg = vi.fn();
    render(<AddOrg onAddOrg={onAddOrg} />);
    const select = await openPopoverAndWait();
    await waitFor(() => expect(select.value).toBe('prod'));
    fireEvent.click(screen.getByLabelText('Sandbox'));
    await waitFor(() => expect(select.value).toBe('sandbox'));
  });

  it('preserves user override when org type changes (if still valid)', async () => {
    const onAddOrg = vi.fn();
    render(<AddOrg onAddOrg={onAddOrg} />);
    const select = await openPopoverAndWait();
    await waitFor(() => expect(select.value).toBe('prod'));
    fireEvent.change(select, { target: { value: 'partner' } });
    expect(select.value).toBe('partner');
    fireEvent.click(screen.getByLabelText('Sandbox'));
    expect(select.value).toBe('partner');
  });

  it('disables the dropdown when only a single ECA is configured', async () => {
    vi.mocked(data.getEcas).mockResolvedValue([{ id: 'only', label: 'Only App', defaultFor: ['https://login.salesforce.com'] }]);
    const onAddOrg = vi.fn();
    render(<AddOrg onAddOrg={onAddOrg} />);
    const select = await openPopoverAndWait();
    await waitFor(() => expect(select.value).toBe('only'));
    expect(select.disabled).toBe(true);
  });

  it('passes the selected ecaId to onAddOrgHandlerFn on submit', async () => {
    const onAddOrgHandlerFn = vi.fn();
    const onAddOrg = vi.fn();
    render(<AddOrg onAddOrg={onAddOrg} onAddOrgHandlerFn={onAddOrgHandlerFn} />);
    const select = await openPopoverAndWait();
    await waitFor(() => expect(select.value).toBe('prod'));
    fireEvent.change(select, { target: { value: 'partner' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onAddOrgHandlerFn).toHaveBeenCalledTimes(1);
    const [options] = onAddOrgHandlerFn.mock.calls[0];
    expect(options.ecaId).toBe('partner');
    expect(options.loginUrl).toBe('https://login.salesforce.com');
  });
});
