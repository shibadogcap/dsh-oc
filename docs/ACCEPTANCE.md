*English · [日本語](ACCEPTANCE.ja.md)*

# Definition of done

## Overall

1. T0 passes on Linux, macOS, and Windows.
2. T2 covers every real call made by OpenChamber and the TUI, with no unimplemented 404.
3. T3 covers every `session.*` published by the bridge, and the OpenChamber reducer emits no unknown.
4. In the T4 startup record, `bootstrapGlobal` and `bootstrapDirectory` have zero failures.
5. The chat scenario runs through to the end.
6. After the history is reloaded, messages, parts, and tool states match the real-time stream.
7. A forced SSE disconnect and reconnect produce neither duplicated nor missing messages and parts.
8. After a dsh restart, the session list, history, models, agent, titles, and revert aliases remain.
9. All v1 routes are deleted, and `rg` finds no registration of `/session` or `/global/event`.
10. Every route in `docs/PROTOCOL.md` carries MAP, STUB, or UNSUPPORTED.
11. `compat.json` matches the pinned version set.
12. `/api/info` responds within 100ms, listing 1000 sessions takes under 300ms, event delivery has a p95 under 50ms, and memory with 10 sessions stays under 250MB.
