/** Local settings projection. This does not expose bearer credentials or native session ids. */
export interface LocalAgentConnection {
  id: string;
  name: string;
  clientId?: string;
}

export interface LocalAgentSettingsApi {
  connections(): Promise<LocalAgentConnection[]>;
  revoke(connectionId?: string): Promise<boolean>;
  onConnectionsChanged(listener: () => void): () => void;
}
