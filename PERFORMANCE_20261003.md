# Performance improvements — 2026-10-03

## Conversation refresh

Fetch workflow state concurrently with the LINE, Facebook and Instagram conversation lists. Wait for all results before applying list filters; retain the existing account-switch guard and partial failure handling.

Browser comparison using the same fictional account and a 400 ms delay on workflow and LINE conversation APIs:

| Measurement | Before | After |
| --- | ---: | ---: |
| Refresh completion | 894 ms | 486 ms |
| Gap between request starts | 415 ms | 0 ms |
| API requests in refresh | 2 | 2 |

This is a controlled browser measurement, not a production latency guarantee. The improvement removes a sequential network wait without reducing freshness or increasing request counts.

## Background data management

Stop retention summary polling while the browser tab is hidden or the account page is inactive. Returning to the foreground refreshes immediately and resumes the existing interval. Export and cleanup workers continue independently on the server.

Browser clock verification: three hidden minutes produced zero summary requests; returning to the foreground produced one immediate request.

## Validation and scope

300 existing tests passed; 85 JavaScript files passed syntax checks. Browser fixtures verified conversation actions, desktop/mobile layout, and account data management. Deploy only line-inbox.js and data-retention.js over a fresh production snapshot. Large LINE guide images already use lazy loading; their original screenshots are preserved. No backend, data retention policy, or design changes.

## Chat rendering follow-up

The animation observer previously scheduled a global navigation/panel geometry scan for every mutation in message history and conversation rows. It now skips these content-only mutations, while retaining changes to the history container's own visibility/classes and all mutations outside history. ResizeObserver still reacts to actual control size changes.

Controlled browser verification: 50 successive chat updates caused 50 global animation scans before, and zero afterward. This measures avoided work, not a claimed FPS increase. Navigation pill movement, page switching, drawer inert state and focus restoration passed in both versions. Desktop/mobile conversation actions remain covered by the existing browser fixture.
