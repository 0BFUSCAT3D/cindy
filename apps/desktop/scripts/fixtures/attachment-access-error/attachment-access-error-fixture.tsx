import { ErrorMessageCard } from '../../../src/renderer/components/chat/ErrorMessageCard';
import { mountPage } from '../../ui-page/harness';

void mountPage({
  render: () => (
    <div className="p-4">
      <ErrorMessageCard message="[DEVICE_LINK_MEDIA_ACCESS_DENIED] Cannot read the source attachment." />
    </div>
  ),
});
