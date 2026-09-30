# BotNest UI simplification — 2026-09-26

Published to https://planning-with-ai-52d58.web.app.
Final Firebase Hosting version: `19bccaf274c539f6`.

The login, inbox, AI assistant, customers, connections and account pages now use a shared white/gray theme, system typography, and blue primary actions in `public/minimal-ui.css`. Navigation labels are shorter. Secondary instructions and account identifiers use expandable details. The inbox customer panel opens on demand at every screen size, leaving more room for conversations. Existing controls, authentication persistence and automatic history loading are retained.

Deployment was staged in `.deploy-cost/minimal` from the current production release, preserving its configuration and unrelated files. Only `index.html`, `app.js`, `ai-settings.js`, `line-inbox.js` and the new stylesheet changed. No Functions release was performed, and unrelated local login-security work was excluded.

Validation:

- `npm run check`: 37 JavaScript files passed syntax checks.
- `npm test`: 121 tests passed.
- Staged JavaScript syntax checks passed.
- Browser visual review at desktop and 390 px widths using local fictional data; checked login, inbox, customer drawer, account, AI settings/knowledge, customer list and channel settings.
- Fixed knowledge-list overflow at mobile width; no browser errors in the final inbox preview.
- Compared all published file hashes with the final stage after deployment; exact match.
- Production login page verified without using a real user's credentials. Signed-in screens were reviewed through the local fixture.

The ignored `.deploy-cost/patch-minimal.cjs` records the initial source transformation, while subsequent CSS refinements are captured in `public/minimal-ui.css`. Do not rerun the transformation over already transformed markup.
