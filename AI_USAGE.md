# AI usage and cost visibility

The AI usage page is available at `#usage`. Merchants see only their own processing counts, submitted image counts, audio clip duration, month/day breakdowns and the latest 50 requests. Only the existing monitor owner's verified Google sign-in can view token counts and estimated provider cost, or the aggregate across all merchants. The server enforces this permission and explicitly strips private fields. Existing deny-all client Firestore rules remain unchanged.

This release meters usage; it does not introduce credits, billing, automatic top-ups or quota changes. New records begin at deployment. Historical costs are not reconstructed from incomplete logs.

## Units and boundaries

- One provider generation request is counted once even when its reply is split into several bubbles. Completed means the provider returned success, not that downstream delivery succeeded or its answer passed every business check.
- Image count measures images actually submitted to the model. Vision and the answer share the same request; its image input is already included in input tokens. There is no invented fixed token count per image and no double charging.
- Audio transcription is separate from the subsequent response generation. Duration is parsed locally from the submitted audio file, accumulated in milliseconds and displayed in minutes without per-clip minute rounding. Unknown duration is explicitly counted, not silently filled with zero. Duration is informational, not used as exact token billing.
- Test conversations and knowledge image OCR are distinct workspace categories. Text/PDF/DOCX extraction, manual knowledge editing, viewing images, voice playback and human replies do not invoke AI through these paths.
- Failed API requests, canceled downstream delivery, parsing rejection, and provider retries can still have costs. Every actual provider call has its own request ledger; persistence retries are idempotent and never re-run inference. Costs missing from the response stay unknown.

## Accounting

Before inference, persist a pending request. Settle it after receiving the provider response, before callers parse/validate the answer. A timeout or a failed settlement remains visible as pending/uncertain; it is not presented as free. Pre-inference ledger failure prevents the call. Two failed settlement writes log a metadata-only diagnostic and leave the durable pending entry for reconciliation; there is no automatic invoice reconciliation in this release.

Store only metadata, not messages, prompts, transcripts, image URLs, audio bytes or secrets. Transactional updates maintain per-account and global month/day aggregates. Monetary values use integer nanodollars and the request's versioned price snapshot; history is never recalculated using new rates. The monthly global aggregate is suitable for current traffic; high-volume deployments should shard it before scaling.

Rates checked 2026-09-27 against [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [GPT-4o mini transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe), and [OpenAI pricing](https://developers.openai.com/api/docs/pricing):

| Model | Input / million tokens | Cached input / million | Output / million |
| --- | --- | --- | --- |
| GPT-5.4 mini | US$ 0.75 | US$ 0.075 | US$ 4.50 |
| GPT-4o mini transcribe | US$ 1.25 | No separate discount configured | US$ 5.00 |

Cost = ((input − cached) × input rate + cached × cached rate + output × output rate) / 1,000,000. Output is the API's output total, including any billed internal output; do not add reasoning tokens again. Missing usage or unknown model rates have unknown cost. Estimates exclude taxes, currency conversion, discounts, special processing tiers, infrastructure and channel fees; the provider invoice remains authoritative.

Example: 2,000 uncached input + 300 output tokens on GPT-5.4 mini = US$ 0.00285. With 1,000 of those input tokens cached, the estimate becomes US$ 0.002175. OpenAI's US$ 0.003/minute transcription figure is an estimate, not an additional charge on top of token cost.

## Product references

[Botpress](https://botpress.com/pricing) distinguishes conversation quota from AI spend and category breakdowns. [Intercom Fin](https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-outcomes) bills defined outcomes rather than raw token totals. BotNest keeps merchant activity and operator costs distinct; pricing and credit conversion must be a separate explicit product decision based on measured cost distributions.

## Validation and release isolation

Tests cover cached input arithmetic, missing usage, month boundaries, durable recording before inference, idempotent settlement, tenant isolation, spoofed admin attempts, HTTP authentication and audio duration. Browser checks use invented data and cover merchant/owner views, mobile layout, account changes, empty months and errors. Deploy from fresh production assets and source archives; exclude unrelated local login-security changes. No real customer recording or message is submitted for validation.

Release validation (2026-09-27): 236 repository tests and 58 JavaScript syntax checks passed. The isolated production snapshot passed 106 initial backend tests plus 9 focused final accounting/privacy tests. Synthetic WAV, OGG and M4A duration parsing was verified without provider calls. Browser tests covered the real production app router, role changes, logout cleanup, empty/error states and a 390 px viewport. Hosting version `4caa83d2ba7f9e37` contains 36 verified assets. Existing log and test endpoints also strip raw usage from merchant responses.
