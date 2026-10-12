import { describe, expect, it, vi } from 'vitest';

import { QueuedAttachmentOwnershipRegistry } from '../queuedAttachmentOwnership';

describe('QueuedAttachmentOwnershipRegistry', () => {
  it('defers discard during persistence and transfers ownership to the durable row', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', cleanup);
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.discardClient('session-1', 'client-1');
    expect(cleanup).not.toHaveBeenCalled();

    registry.releaseClient('session-1', 'client-1');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('runs a deferred discard when persistence fails', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', cleanup);
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.discardClient('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', {
      retainForRetry: true,
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps a retryable owner after persistence fails without a discard', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', cleanup);
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', {
      retainForRetry: true,
    });
    expect(cleanup).not.toHaveBeenCalled();

    await registry.discardClient('session-1', 'client-1');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans a non-retryable owner when persistence fails', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', cleanup);
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', {
      retainForRetry: false,
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('holds remote cleanup until the queue crosses a durable boundary', async () => {
    const localCleanup = vi.fn(async () => {});
    const remoteCleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', localCleanup, {
      cleanupAfterDurable: remoteCleanup,
    });
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    expect(ownerId).toBeTruthy();
    expect(remoteCleanup).not.toHaveBeenCalled();
    await registry.markDurable('session-1', 'client-1', ownerId!);

    expect(remoteCleanup).toHaveBeenCalledTimes(1);
    expect(localCleanup).not.toHaveBeenCalled();
    await registry.markDurable('session-1', 'client-1', ownerId!);
    expect(remoteCleanup).toHaveBeenCalledTimes(1);

    registry.releaseClient('session-1', 'client-1');
    expect(localCleanup).not.toHaveBeenCalled();
  });

  it('cleans both local and remote ownership on explicit discard', async () => {
    const localCleanup = vi.fn(async () => {});
    const remoteCleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    registry.register('session-1', 'client-1', localCleanup, {
      cleanupAfterDurable: remoteCleanup,
    });

    await registry.discardClient('session-1', 'client-1');

    expect(localCleanup).toHaveBeenCalledTimes(1);
    expect(remoteCleanup).toHaveBeenCalledTimes(1);
  });

  it('retains both ownership callbacks for a retryable persistence failure', async () => {
    const localCleanup = vi.fn(async () => {});
    const remoteCleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', localCleanup, {
      cleanupAfterDurable: remoteCleanup,
    });
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', {
      retainForRetry: true,
    });
    expect(localCleanup).not.toHaveBeenCalled();
    expect(remoteCleanup).not.toHaveBeenCalled();

    await registry.discardClient('session-1', 'client-1');
    expect(localCleanup).toHaveBeenCalledTimes(1);
    expect(remoteCleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans superseded owners while preserving the accepted replacement', async () => {
    const oldLocal = vi.fn(async () => {});
    const oldRemote = vi.fn(async () => {});
    const newLocal = vi.fn(async () => {});
    const newRemote = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const oldOwnerId = registry.register('session-1', 'client-1', oldLocal, {
      cleanupAfterDurable: oldRemote,
    });
    registry.activateCurrentOwner('session-1', 'client-1', oldOwnerId!);
    const newOwnerId = registry.register('session-1', 'client-1', newLocal, {
      cleanupAfterDurable: newRemote,
    });
    registry.activateCurrentOwner('session-1', 'client-1', newOwnerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', { retainForRetry: true });

    expect(oldLocal).toHaveBeenCalledTimes(1);
    expect(oldRemote).toHaveBeenCalledTimes(1);
    expect(newLocal).not.toHaveBeenCalled();
    expect(newRemote).not.toHaveBeenCalled();

    await registry.discardClient('session-1', 'client-1');
    expect(newLocal).toHaveBeenCalledTimes(1);
    expect(newRemote).toHaveBeenCalledTimes(1);
  });

  it('settles the persisted replacement atomically and cleans the old owner', async () => {
    const oldLocal = vi.fn(async () => {});
    const oldRemote = vi.fn(async () => {});
    const newLocal = vi.fn(async () => {});
    const newRemote = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const oldOwnerId = registry.register('session-1', 'client-1', oldLocal, {
      cleanupAfterDurable: oldRemote,
    });
    registry.activateCurrentOwner('session-1', 'client-1', oldOwnerId!);
    const newOwnerId = registry.register('session-1', 'client-1', newLocal, {
      cleanupAfterDurable: newRemote,
    });
    registry.activateCurrentOwner('session-1', 'client-1', newOwnerId!);

    await registry.settleDurable('session-1', 'client-1');

    expect(oldLocal).toHaveBeenCalledTimes(1);
    expect(oldRemote).toHaveBeenCalledTimes(1);
    expect(newLocal).not.toHaveBeenCalled();
    expect(newRemote).toHaveBeenCalledTimes(1);
    expect(registry.getCurrentOwnerId('session-1', 'client-1')).toBeNull();
  });

  it('keeps the current owner when a queue edit still references its media without a new copy', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', undefined, {
      parts: [{ refs: ['cindy-media://blobs/a.png', '/blobs/a.png'], cleanup }],
    });
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    const survivor = registry.retainReferencedOwners(
      'session-1',
      'client-1',
      null,
      (ref) => ref === 'cindy-media://blobs/a.png',
    );
    await registry.discardClient('session-1', 'client-1', survivor ?? undefined);

    expect(survivor).toBe(ownerId);
    expect(cleanup).not.toHaveBeenCalled();
    await registry.discardClient('session-1', 'client-1');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('splits one materialisation so an edit releases only its dropped attachments', async () => {
    const keptLocal = vi.fn(async () => {});
    const droppedLocal = vi.fn(async () => {});
    const remote = vi.fn(async () => {});
    const otherLocal = vi.fn(async () => {});
    const newLocal = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    // One enqueue materialised two attachments; the edit keeps one of them.
    const enqueuedOwnerId = registry.register('session-1', 'client-1', undefined, {
      cleanupAfterDurable: remote,
      parts: [
        { refs: ['cindy-media://blobs/kept.png'], cleanup: keptLocal },
        { refs: ['cindy-media://blobs/dropped.png'], cleanup: droppedLocal },
      ],
    });
    registry.activateCurrentOwner('session-1', 'client-1', enqueuedOwnerId!);
    registry.register('session-1', 'client-1', undefined, {
      parts: [{ refs: ['cindy-media://blobs/other.png'], cleanup: otherLocal }],
    });
    const newOwnerId = registry.register('session-1', 'client-1', undefined, {
      parts: [{ refs: ['cindy-media://blobs/new.png'], cleanup: newLocal }],
    });

    const replacement = new Set(['cindy-media://blobs/kept.png', 'cindy-media://blobs/new.png']);
    const survivor = registry.retainReferencedOwners('session-1', 'client-1', newOwnerId, (ref) =>
      replacement.has(ref),
    );
    registry.activateCurrentOwner('session-1', 'client-1', survivor!);
    await registry.discardClient('session-1', 'client-1', survivor!);

    expect(survivor).toBe(newOwnerId);
    expect(droppedLocal).toHaveBeenCalledTimes(1);
    expect(otherLocal).toHaveBeenCalledTimes(1);
    expect(keptLocal).not.toHaveBeenCalled();
    expect(newLocal).not.toHaveBeenCalled();
    // The remote source moved with the kept attachment and waits for the durable boundary.
    expect(remote).not.toHaveBeenCalled();

    await registry.markDurable('session-1', 'client-1', survivor!);
    expect(remote).toHaveBeenCalledTimes(1);
    await registry.settleDurable('session-1', 'client-1');
    expect(keptLocal).not.toHaveBeenCalled();
    expect(newLocal).not.toHaveBeenCalled();
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it('does not clean a duplicate materialisation that was never accepted', async () => {
    const acceptedCleanup = vi.fn(async () => {});
    const duplicateCleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const acceptedOwnerId = registry.register('session-1', 'client-1', acceptedCleanup);
    registry.activateCurrentOwner('session-1', 'client-1', acceptedOwnerId!);
    registry.register('session-1', 'client-1', duplicateCleanup);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', { retainForRetry: true });

    expect(duplicateCleanup).toHaveBeenCalledTimes(1);
    expect(acceptedCleanup).not.toHaveBeenCalled();
    await registry.discardClient('session-1', 'client-1');
    expect(acceptedCleanup).toHaveBeenCalledTimes(1);
  });
});
