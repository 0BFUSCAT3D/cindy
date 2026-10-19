import { useState } from 'react';
import { mountPage, forbid, subscription } from '../../ui-page/harness';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { ProviderConnectionDialog } from '../../../src/renderer/components/settings/ProviderConnectionDialog';
import { AddProviderWizard } from '../../../src/renderer/components/settings/AddProviderWizard';
import type { DetectedProviderDraft } from '../../../src/shared/providerDetection';

const models = ['team-chat', 'team-coding', 'fast-chat', 'reasoning', 'vision-chat'].map(id => ({ id, name: id }));
function Page() {
  const [identified, setIdentified] = useState<DetectedProviderDraft>();
  const [draft, setDraft] = useState<DetectedProviderDraft>();
  return identified ? <AddProviderWizard providers={[]} detected={identified}
    onReturnCustom={value => { setDraft(value); setIdentified(undefined); }}
    onClose={() => undefined} onDone={() => undefined} onOpenCustomForm={() => undefined} />
    : <ProviderConnectionDialog focusAgent="pi" draft={draft} onDetected={setIdentified}
      onClose={() => undefined} onSaved={() => undefined} />;
}
mountPage({
  host: ctx => ({ maker: {
    listProviderPresets: async () => ({ presets: BUNDLED_CATALOG.presets }),
    fetchProviderModels: async () => ctx.case === 'failed' ? { ok: false, code: 'AUTH_INVALID' } : { ok: true, models },
    detectProvider: async (input: { cancel?: boolean }) => input.cancel ? { candidates: [] }
      : { candidates: ctx.case === 'relay' ? ['sub2api'] : [], reason: ctx.case === 'relay' ? 'matched' : 'insufficient_evidence',
        catalog: ctx.case === 'failed' ? { ok: false, code: 'AUTH_INVALID' } : { ok: true, models } },
    localModelList: async () => ({ status: { kind: 'absent', appInstalled: false }, models: [], memoryGb: 0 }),
    scanLocalCli: async () => ({ detections: [] }),
    onProviderOAuthProgress: subscription('providerOAuthProgress'),
    createCustomProvider: forbid('createCustomProvider'),
    testProviderConnection: forbid('testProviderConnection'),
  } }),
  render: () => <Page />,
});
