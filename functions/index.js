import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createHandler } from "./core.js";
import { createStore } from "./store.js";

initializeApp();
const encryptionKey = defineSecret("BOTNEST_ENCRYPTION_KEY");
let handler;
export const botnestApi = onRequest({
  region: "us-central1", maxInstances: 3, minInstances: 0, concurrency: 20,
  timeoutSeconds: 60, memory: "256MiB", cors: false, invoker: "public",
  secrets: [encryptionKey],
}, (req, res) => {
  handler ||= createHandler({ store: createStore(getFirestore()), verifyToken: token => getAuth().verifyIdToken(token, true), getKey: () => encryptionKey.value(),
    media: {
      save: (path, bytes, contentType) => getStorage().bucket("planning-with-ai-52d58-botnest-media").file(path).save(bytes, { resumable: false, metadata: { contentType, cacheControl: "private, no-store" } }),
      read: async path => (await getStorage().bucket("planning-with-ai-52d58-botnest-media").file(path).download())[0],
    },
  });
  return handler(req, res);
});
