# Incoming image understanding

LINE, Instagram and Messenger incoming image messages now enter the existing AI reply pipeline. The current model receives the current message's image bytes with its caption and recent text context. Current business settings and enabled knowledge remain the source for business claims.

- LINE downloads authenticated message content directly; reading does not depend on opening the inbox. Fresh image webhooks retain the reply token.
- Social webhooks retain image attachments and captions. HTTPS downloads validate public DNS, pin the address and revalidate redirects, without forwarding platform credentials.
- JPEG, PNG and WebP are supported, up to 5 MiB per image and three attachments per social message. LINE delivers individual image events. Old image attachments are not downloaded again as history.
- Existing channel switches, hours, human takeover, rate limits, leases, deduplication and post-inference settings/knowledge checks still apply.
- Missing, expired, unsupported or oversized images request a clearer image or text instead of inventing content. The prompt treats image instructions as untrusted and does not equate a payment screenshot with verified payment.
- Image bytes stay in memory for the Responses request (`store: false`); they are not added to AI logs. Existing platform attachment URLs remain in the stored social message. Provider processing remains subject to the existing OpenAI account's data policies.

Validation: the original 166 tests plus 20 image tests pass (186 total), and source syntax checks pass. Tests cover all three transports with mocked provider responses, webhook authentication and captions, byte bounds, unsafe URL/redirect rejection, no downloads during human/off mode, no duplicate replies, and business-source grounding. These checks do not establish real-world OCR accuracy or verify delivery using a real customer account.

Release uses a fresh production backend snapshot, applying only the image feature and preserving other local work. Hosting assets are unchanged.

Production verification (2026-09-27): botnestApi, lineAiAutoReply and facebookAiAutoReply are ACTIVE. All 15 source files in each downloaded deployment archive match the isolated release. Existing health endpoint returns 200; unauthenticated settings requests return 401. The isolated backend also passes 80 focused tests.
