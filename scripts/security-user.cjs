// Operator-only recovery utility; never deployed with public/. Requires Firebase CLI login.
const auth = require("C:/Users/to101/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js");
const project = "planning-with-ai-52d58";
const [action, uid, apply] = process.argv.slice(2);
if (
  !["disable", "enable", "revoke"].includes(action) ||
  !uid ||
  uid.length > 128
) {
  console.error(
    "Usage: node scripts/security-user.cjs disable|enable|revoke UID [--apply]",
  );
  process.exit(1);
}
if (apply !== "--apply") {
  console.log(
    JSON.stringify({
      dryRun: true,
      project,
      action,
      uid,
      note: "Add --apply only after verifying the affected account.",
    }),
  );
  process.exit(0);
}
(async () => {
  const account = auth.getGlobalDefaultAccount();
  const token = await auth.getAccessToken(account.tokens.refresh_token, [
    "https://www.googleapis.com/auth/cloud-platform",
  ]);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:update`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        localId: uid,
        ...(action === "revoke"
          ? { validSince: String(Math.floor(Date.now() / 1000)) }
          : {
              disableUser: action === "disable",
              ...(action === "disable"
                ? { validSince: String(Math.floor(Date.now() / 1000)) }
                : {}),
            }),
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) {
    console.error(`Action failed: HTTP ${response.status}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      project,
      action,
      uid,
      success: true,
      note: "Existing ID tokens require server-side revocation checks; expiration alone is not immediate revocation.",
    }),
  );
})().catch(() => {
  console.error("Unable to authenticate or contact account service.");
  process.exitCode = 1;
});
