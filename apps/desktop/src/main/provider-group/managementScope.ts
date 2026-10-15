import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** 账号进入清理边界时旧 owner key 仍有效，管理操作必须同时核对切换状态。 */
export function captureProviderManagementScope(ownerKey: () => string = activeOwnerScopeKey): () => void {
  const owner = ownerKey();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || ownerKey() !== owner) {
      throwIpcError('PRECONDITION_FAILED', 'The account changed during provider management');
    }
  };
  assertCurrent();
  return assertCurrent;
}
