import { buildManualTransport } from './manual-transport';
import { TransportRegistry } from './transport-registry';

const ctx = {
  companyId: 'co-1',
  label: 'Invoice',
  document: { id: 'doc-1', typeId: 'invoice', status: 'sending', data: {} },
} as never;

describe('manual transport', () => {
  it('succeeds immediately with a message and no reference, provider id or artifacts', async () => {
    const result = await buildManualTransport().send(ctx);
    expect(result.message).toMatch(/nothing was emailed/);
    expect(result.reference).toBeUndefined();
    expect(result.providerId).toBeUndefined();
    expect(result.artifacts).toBeUndefined();
  });

  it('can carry a credit note and needs no preflight (nothing to connect)', () => {
    const transport = buildManualTransport();
    expect(transport.deliversCreditNotes).toBe(true);
    expect(transport.preflight).toBeUndefined();
  });

  it('registers like any other transport and is listed with no credential fields', () => {
    const registry = new TransportRegistry();
    registry.register('manual', 'Share link only (no email)', buildManualTransport());
    expect(registry.list()).toEqual([
      { id: 'manual', label: 'Share link only (no email)', credentialFields: [] },
    ]);
  });
});
