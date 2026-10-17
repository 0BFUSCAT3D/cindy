import { useEffect, useRef } from 'react';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import type { DurableOutboxRecord } from './durableOutbox';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';
import { completeNewSessionDurableEdit, findNewSessionEditDraft } from './newSessionCreation';

type CreationRecord = DurableOutboxRecord & { creation: NonNullable<DurableOutboxRecord['creation']> };

/** The form owns one edit claim until its recovery route changes or unmounts. */
export function useNewSessionDurableEdit({ sessionId, deviceId, owner, leaveForeignRecovery, onRestore }: {
  sessionId: string;
  deviceId: string;
  owner: MobileAuthOwnerGeneration;
  leaveForeignRecovery: () => boolean;
  onRestore: (record: CreationRecord) => void;
}) {
  const callbacks = useRef({ leaveForeignRecovery, onRestore });
  callbacks.current = { leaveForeignRecovery, onRestore };
  useEffect(() => {
    if (callbacks.current.leaveForeignRecovery() || !sessionId) return;
    let active = true;
    let restored = false;
    let releaseEditClaim: (() => void) | undefined;
    const restore = () => {
      if (!active || restored || !isMobileAuthOwnerCurrent(owner)) return;
      const record = getCurrentMobileOutboxRecords().find(r => r.item.sessionId === sessionId && r.creation
        && r.accountId === owner.accountKey && r.deviceId === deviceId);
      if (!record?.creation || record.prepared) return;
      restored = true;
      callbacks.current.onRestore(record as CreationRecord);
      releaseEditClaim = completeNewSessionDurableEdit(sessionId, record.deviceId);
    };
    const unsubscribe = mobileDurableOutbox.subscribe(restore);
    void mobileDurableOutbox.ready().then(restore);
    return () => { active = false; unsubscribe(); releaseEditClaim?.(); };
  }, [sessionId, deviceId, owner]);
}

/** Resume only while this form is still blank when asynchronous storage becomes ready. */
export function useAutoResumeNewSessionDraft({ enabled, deviceId, workingDir, owner, hasInput, onResume }: {
  enabled: boolean;
  deviceId: string;
  workingDir: string | null;
  owner: MobileAuthOwnerGeneration;
  hasInput: () => boolean;
  onResume: (params: { recoverySessionId: string; deviceId: string }) => void;
}) {
  const callbacks = useRef({ hasInput, onResume });
  callbacks.current = { hasInput, onResume };
  useEffect(() => {
    if (!enabled || !deviceId) return;
    let active = true;
    const resume = () => {
      if (!active || !isMobileAuthOwnerCurrent(owner) || callbacks.current.hasInput()) return;
      const saved = findNewSessionEditDraft(deviceId, workingDir);
      if (!saved) return;
      active = false;
      callbacks.current.onResume({ recoverySessionId: saved.item.sessionId, deviceId: saved.deviceId });
    };
    const unsubscribe = mobileDurableOutbox.subscribe(resume);
    void mobileDurableOutbox.ready().then(resume);
    return () => { active = false; unsubscribe(); };
  }, [enabled, deviceId, workingDir, owner]);
}
