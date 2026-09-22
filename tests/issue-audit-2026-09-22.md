# Issue verification — 0.6.11

Baseline: `db00313bbda5fb762fada89bf789ee6d0d021fb8` (0.6.10).
Reviewed all 18 issues; #17 and #18 were open at audit time. This report records
verification before publication, not a claim that installed sessions have upgraded.

| Issues | Verification and disposition |
| --- | --- |
| #1, #7, #9, #16, #17 | Existing lazy initialization and null-broker recovery are retained. Reproduced stale-socket startup races, a losing broker deleting the winner's socket, stale ready state, concurrent reconnect leaking clients, and replay of a dispatched action after a lost reply. Fixed with exclusive startup, owned listener cleanup, readiness reset, one attachment per MCP, and no replay after dispatch. Default attachment no longer kills a not-yet-ready native host. Status includes a connection error when unavailable. The original #17 report does not establish which of these paths or an old still-running MCP caused that historical failure. |
| #2 | Real isolated Chrome contenteditable fill preserves blank lines and URL/mention separation (`prove-hands`). No new text-entry defect found. |
| #3 | Found two remaining cleanup defects: isolated CfT shutdown rewrote the daily native-host manifest, and a global PID fallback could kill another CfT instance. Both fixed; cleanup is limited to the instance's own browser. |
| #4 | Source audit confirms no CDP attachment in pointer painting, no per-page wake loop, and bounded reconnect backoff plus an alarm. No recurrence of the reported daily-Chrome livelock was established; unrelated Chrome DevTools MCP load is not evidence of this issue. |
| #5, #6 | Kept debugger/probe origin exclusions and explicit rejection of arbitrary evaluate on denied origins. Added regression proving denied origins cannot reach debugger.attach. No production SSO/login or real external send was attempted. |
| #8 | Reproduced multiple simultaneous stale-socket contenders all winning on the old path. The new startup lock elects one reachable broker; failed contenders cannot remove its socket. Existing multiplexed-client regression passes. |
| #10 | Reproduced a hidden checkbox toggling twice because DOM fallback dispatched click and then called click(). Fixed both DOM click paths to activate once. Fixed the old test's `/checked/` assertion, which also accepted `unchecked`. Real checkbox state is now checked explicitly. |
| #11 | Real cross-origin fixture iframe click reaches its send handler. Existing coordinate fallback is retained. |
| #12 | Grouped and ungrouped tab ownership is checked by full session ID. Removed the emulated-tab authorization bypass. Other sessions, unknown ungrouped tabs, and tabs moved into a user-named group remain protected. |
| #13, #15 | MCP advertises emulate; real isolated Chrome reaches phone width and resets. Removed unconditional activation of a background tab. |
| #14 | Real 400-button fixture respects the snapshot cap; a polling page's wait returns within its budget. |
| #18 | Tab ownership is recorded before grouping in `chrome.storage.session`; ungrouping and a real MV3 worker stop/start no longer lose it. Owner can list/click/close; other sessions cannot. Failed tab creation cleans up its own new tab. |

## Verification

- `node --test tests/test-*.mjs`: broker competition/readiness, reconnect deduplication,
  no replay, tab serialization, session ownership, host isolation, denied origins.
- Existing checks: `test-framing`, `prove-singleton-broker`, `prove-session-groups`,
  `prove-stale-broker`, `prove-daily-socket`.
- `node tests/prove-hands.mjs`: isolated Chrome for Testing; real input, clicking,
  iframe action, contenteditable lines and screenshot.
- `node tests/prove-tab-recovery.mjs` (requires `playwright-core`, or
  `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs`): real extension,
  ungrouping, worker restart, ownership denial, failed-create cleanup, custom
  checkbox, cross-origin click, phone viewport and bounded snapshot/wait. Captures
  `tests/artifacts/tab-recovery.png`; checks daily native-host manifests byte for byte.
- Independent review reproduced the broker and CfT cleanup failures before their
  fixes. Two-process lock stress completed 400 recovery rounds without overlap.

## Scope and lifecycle

The `storage` permission is required for session ownership. Session storage
survives worker suspension; browser restart, extension reload/update/disable
clears it. After that, grouped legacy tabs can be adopted only by their matching
session; already-ungrouped unknown tabs fail closed. Existing ungrouped tabs from
before this version cannot be safely assigned to an owner retroactively.

Installing this version requires updating the plugin/extension and starting new
MCP processes. No daily Chrome session was restarted or installed plugin changed
for this verification. No CI workflow was added.
