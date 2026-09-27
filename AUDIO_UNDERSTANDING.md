# Incoming voice understanding

New LINE, Instagram and Messenger audio messages are downloaded, transcribed and passed as customer text into the existing AI reply pipeline. Replies remain text. The existing answer model, current business information, knowledge citations, channel switches, office hours, human takeover and usage limits remain in effect. Spoken handoff keywords are checked after transcription.

Audio is limited to one recording per message and 8 MiB, with MP3, M4A/MP4, OGG, WAV and WebM signatures accepted. Unavailable, unsupported, oversized, empty or excessively long transcriptions ask the customer for a shorter recording or text. Mixed image/audio attachments also ask for one recording rather than silently ignoring part of the message. This does not transcribe historical recordings or add voice playback or transcript display to the inbox.

LINE content is fetched directly with its encrypted channel credential; fresh audio events retain the reply token. Social URLs use the shared bounded HTTPS downloader with public DNS validation, pinned addresses, per-redirect checks and an eight-second deadline including DNS resolution. Platform credentials are never forwarded to attachment URLs. Only actual image/audio byte limits are accepted by this shared helper.

The transcription uses multipart `/v1/audio/transcriptions` with `gpt-4o-mini-transcribe` and a 30-second timeout. Transcribed speech stays in a user message, never system instructions. The answer prompt asks for clarification when important amounts, quantities, dates or intent are unclear. Speech recognition may still make mistakes. Raw recording bytes are not stored in AI logs; the existing question log contains at most 2,000 characters of the transcript. Provider processing follows the existing OpenAI account's policies.

Validation: 220 local tests and 52 JavaScript syntax checks pass. The fresh production-source release passes 114 focused tests. The 34 audio tests cover format and byte bounds, multipart request construction, captions, each channel's reply and duplicate protection, spoken handoff, human/off controls, failed or empty recordings, multi-attachment rejection and settings changes during transcription. A synthetic Windows-generated recording was successfully transcribed by the actual OpenAI service; the returned text matched “Hello, I would like to speak to a customer service agent.” Real customer delivery was not exercised by this check.

The release is built from fresh production sources, preserving unrelated working-tree edits and Hosting assets.

References: [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [GPT-4o Mini Transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe), [LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/nojs/), [Zernio attachment payloads](https://docs.zernio.com/resources/integrations/chat-sdk).

Production verification (2026-09-27): all three functions are ACTIVE. All 17 source files in each downloaded deployment archive match the isolated release. Health returns 200 and unauthenticated settings returns 401.

## Meta audio compatibility correction — 2026-09-27

Production attachment diagnostics found two omissions in the initial release: Messenger voice notes used the Ogg container, which the signature check rejected; Instagram lookaside URLs returned an HTML document when the HTTP User-Agent was absent. The downloader now identifies itself as `BotNest/1.0` on every request and redirect, and audio detection accepts Ogg version 0 with an `.ogg` filename and `audio/ogg` content type. Existing DNS pinning, public-address validation and byte limits remain in place.

Validation: 222 tests and 52 syntax checks pass; 56 media tests pass against the isolated production-source release. Added regression coverage for Ogg multipart transcription and the User-Agent plus pinned DNS across redirects. A read-only attachment check confirmed Instagram returns MP4 audio with the application User-Agent. Separate OGG/Opus and M4A files encoded from a locally synthesized English sentence both passed real OpenAI transcription. Existing customer recordings were not submitted for retranscription: automatic approval review rejected that check, so synthetic recordings were used instead. No old message events were replayed.
