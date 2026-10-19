import { mountPage, subscription } from '../../ui-page/harness';
import { PluginTargetPickerHost } from '../../../src/renderer/cindy-brain/PluginTargetPickerHost';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { PluginTargetPickerPush } from '../../../src/shared/pluginTargets';

const ownerStamp = { dataOwnerId: 'fixture-owner', ownerGeneration: 1 };
setDataOwnerGeneration(ownerStamp.dataOwnerId, ownerStamp.ownerGeneration);

void mountPage({
  host: (ctx) => ({
    onAuthStateChange: subscription('authState'),
    ghosts: {
      onTargetPicker: (listener: (payload: PluginTargetPickerPush, stamp: typeof ownerStamp) => void) => {
        queueMicrotask(() => listener({ requestId: 'fixture-picker', pluginName: 'Example Plugin',
          kind: ctx.data.kind as PluginTargetPickerPush['kind'], persistent: ctx.data.persistent === true,
          candidates: ctx.data.candidates as PluginTargetPickerPush['candidates'] }, ownerStamp));
        return () => {};
      },
      onTargetPickerDismiss: subscription('pickerDismiss'),
      resolveTargetPicker: async () => ({ handled: true }),
    },
  }),
  render: () => <PluginTargetPickerHost />,
});
