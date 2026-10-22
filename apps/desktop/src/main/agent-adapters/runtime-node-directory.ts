import type { RuntimeNodeRef, RuntimeNodeStatus } from '@cindy/maker-core/agent-adapters';

const RUNTIME_NODE_ID_MAX_LENGTH = 128;

export class RuntimeNodeDirectoryError extends Error {
  readonly name = 'RuntimeNodeDirectoryError';

  constructor(
    readonly code: 'invalid-id' | 'duplicate' | 'not-found',
    message: string,
  ) {
    super(message);
  }
}

function assertRuntimeNodeId(id: string): void {
  if (id.length === 0 || id.length > RUNTIME_NODE_ID_MAX_LENGTH) {
    throw new RuntimeNodeDirectoryError(
      'invalid-id',
      `Runtime node id must contain 1-${RUNTIME_NODE_ID_MAX_LENGTH} characters`,
    );
  }
}

function copyNode(node: RuntimeNodeRef): RuntimeNodeRef {
  return {
    id: node.id,
    kind: node.kind,
    status: node.status,
    ...(node.label !== undefined ? { label: node.label } : {}),
  };
}

/**
 * Main-process directory for execution locations.
 *
 * This is deliberately an in-memory directory in P1. It does not inspect the
 * filesystem, SSH credentials, device-link state, or Agent login state itself;
 * Desktop sources are projected into it through the runtime's read-only source
 * injection.
 */
export class RuntimeNodeDirectory {
  private readonly nodes = new Map<string, RuntimeNodeRef>();

  constructor(initialNodes: readonly RuntimeNodeRef[] = []) {
    for (const node of initialNodes) this.register(node);
  }

  register(node: RuntimeNodeRef): void {
    assertRuntimeNodeId(node.id);
    if (this.nodes.has(node.id)) {
      throw new RuntimeNodeDirectoryError(
        'duplicate',
        `Runtime node is already registered: ${node.id}`,
      );
    }
    this.nodes.set(node.id, copyNode(node));
  }

  upsert(node: RuntimeNodeRef): void {
    assertRuntimeNodeId(node.id);
    this.nodes.set(node.id, copyNode(node));
  }

  /**
   * Atomically replace the directory with a read-only source projection.
   *
   * Validate the complete input before mutating the current snapshot so a
   * malformed refresh cannot leave a half-updated node directory.
   */
  replace(nodes: readonly RuntimeNodeRef[]): void {
    const next = new Map<string, RuntimeNodeRef>();
    for (const node of nodes) {
      assertRuntimeNodeId(node.id);
      if (next.has(node.id)) {
        throw new RuntimeNodeDirectoryError(
          'duplicate',
          `Runtime node is already registered: ${node.id}`,
        );
      }
      next.set(node.id, copyNode(node));
    }
    this.nodes.clear();
    for (const [id, node] of next) this.nodes.set(id, node);
  }

  updateStatus(id: string, status: RuntimeNodeStatus): RuntimeNodeRef {
    const current = this.get(id);
    if (!current) {
      throw new RuntimeNodeDirectoryError('not-found', `Runtime node is not registered: ${id}`);
    }
    const next = { ...current, status };
    this.nodes.set(id, next);
    return copyNode(next);
  }

  remove(id: string): boolean {
    return this.nodes.delete(id);
  }

  get(id: string): RuntimeNodeRef | undefined {
    const node = this.nodes.get(id);
    return node ? copyNode(node) : undefined;
  }

  list(): readonly RuntimeNodeRef[] {
    return [...this.nodes.values()].map(copyNode);
  }
}
