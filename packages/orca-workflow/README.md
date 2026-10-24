# Orca workflow

Shared collaboration logic for Cindy hosts. The package has no Electron, desktop singleton, filesystem database, or application-window dependency.

- `@cindy/orca-workflow` retains the existing MCP bridge, message formatting and prompts.
- `@cindy/orca-workflow/host/orcaLifecycleService` owns team activation, worker initialization and compensation.
- `@cindy/orca-workflow/host/orcaWorkerCreationService` owns model admission, creation reservations, worker routes and creation rollback.
- `@cindy/orca-workflow/host/orcaTeamService` owns worker controls, accepted-dispatch settlement, queue controls and terminal reports.
- `@cindy/orca-workflow/host/orcaInterAgentDispatcher` owns direct, queued and same-turn delivery. Hosts supply storage, session, queue and logging ports. Keep the dependency object live: hosts may update these ports while a dispatcher is running.
- `@cindy/orca-workflow/host/orcaRemoteWorkerRuntime` owns remote dispatch receipts, reachability, polling and report settlement.
- `@cindy/orca-workflow/host/orcaRemoteWorkerHost` handles authenticated remote worker creation and release. The host must save task identity and Lead attribution in the same commit; explicit Worker tools are advertised separately from automatic report polling.

The remote Worker MCP provider shares the local Worker tool schemas and caller checks, with no local Lead fallback. `host/orcaRemoteWorkerBridge` forwards only through the persisted Lead link and host-captured accepted input identities.

Desktop adapters preserve the existing imports and logger defaults. Host adapters must implement the full port contracts, including ownership rechecks and accepted/rollback/commit ordering. Extracting these services does not, by itself, enable collaboration in another host.

The existing Desktop lifecycle, worker creation, dispatch, queue and permission regression tests exercise these shared implementations. The product contract remains `docs/dev-rules/orca-team-architecture.md`.
