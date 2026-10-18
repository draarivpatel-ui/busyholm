# WP-03 adapter boundary

Published first so WP-04, WP-05 and WP-06 can implement against it.
Package `busyholm-collector`, Rust library and sidecar binary `collector`.
Import `collector::{Adapter, AdapterContext, AdapterError, EventSender}`.
Contracts are re-exported as `collector::contracts`.

Implement `Adapter: Send` with `tool() -> Tool`. Optional methods:

- `map_hook(&mut self, body: &[u8], ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError>`
- `rebuild(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError>`
- `poll(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError>`

Use `ctx.now_ms()` for observed time and `ctx.instance(tool, raw_id)` for the shared
HMAC identity. Convert source seconds to milliseconds. Preserve source timestamps
in `et` for startup freshness. Rebuild returns observations, not earned history.
Watchers can use `EventSender::send(event)` directly. It validates and enqueues
without blocking, returning `InvalidEvent`, `Full` or `Closed`. Retry or rescan on
`Full`. Raw payloads, paths, arbitrary strings and parser errors never enter the bus.
Error classes are closed enums. All raw content is discarded inside the mapper.

Receiver wire requirements: POST `/e/<secret>` on `127.0.0.1:<port>`, JSON content,
no Origin, exact Host, and `X-Busyholm-Token: <token>`. Runtime configuration is
private, separate from JSON stdout. Header token and path secret are independent.
Adapters are selected by a fixed tool endpoint/header, never by a payload path.
The full receiver integration API follows in the implementation commits.
