# Instagram channel binding

Instagram uses the existing Zernio tenant profile, with `loginMethod=instagram_login`.
The server verifies the returned account against the tenant profile and platform before saving `zernio.instagram`.
Existing `zernio.facebook` is preserved. Instagram inbox, text replies, CRM autosave and customer directory are now supported. Instagram AI automatic replies remain disabled.

Production deployment source for this change: `.deploy-instagram/firebase.json`.
The Functions baseline was downloaded from the deployed `botnestApi`; only core.js and store.js were changed.
The local main functions/index.js includes a separate pending login-security feature. Do not deploy that unfinished feature implicitly.
The staging Hosting baseline preserves removal of Facebook website login and has no pending login-security UI.

Validation: 48 inbox/security tests passed against both local and isolated deployment code; local channels UI visually inspected.
Actual Instagram consent must be completed by the account owner.

Reference: https://docs.zernio.com/platforms/instagram

2026-09-20: Verified live Zernio Instagram inbox returned one matching conversation. UI fixture verified Instagram badge and right-hand CRM. IG query uses server-owned account ID and explicit platform=instagram; no client account ID is trusted.
