Customer-facing security report removed. Deploy using .deploy-instagram/firebase.json (production baseline without pending login-security work).
Removed customer navigation, JS/CSS, API handler and per-account metrics writes, including AI triggers. Existing historical customer metrics are retained but no longer read or updated.
Operator monitor remains at /watch-938adf15f764493c9d8c2ad6205da79b.html and /api/security-monitor. Access requires current Google sign-in and verified Google identity 111918945038301227460. Global metrics remain enabled.
Validation: 47 inbox and security tests passed, including rejection of removed customer endpoint and unauthorized operator identities.
