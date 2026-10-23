import { useState } from 'react';
import { mountPage, forbid } from '../../ui-page/harness';
import { BotPortraitPicker } from '../../../src/renderer/features/bots/BotPortraitPicker';
import cindy from '../../../src/renderer/assets/bot-presets/cindy.png';

function Portrait() {
  const [value, setValue] = useState(cindy);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <BotPortraitPicker value={value} onChange={setValue} />
      <output data-testid="avatar-result" className="hidden">
        {value}
      </output>
    </div>
  );
}
mountPage({
  host: { profileUpdate: forbid('profileUpdate') },
  render: () => <Portrait />,
});
