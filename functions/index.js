import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createHandler } from "./core.js";
import { createStore } from "./store.js";

initializeApp();
const encryptionKey = defineSecret("BOTNEST_ENCRYPTION_KEY");
export const botnestApi = onRequest({
  region: "us-central1", maxInstances: 3, minInstances: 0, concurrency: 20,
  timeoutSeconds: 60, memory: "256MiB", cors: false, invoker: "public",
  secrets: [encryptionKey],
}, createHandler({ store: createStore(getFirestore()), verifyToken: token => getAuth().verifyIdToken(token, true), getKey: () => encryptionKey.value() }));
