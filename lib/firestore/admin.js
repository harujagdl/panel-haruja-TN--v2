import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getServiceAccount() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }

  const jsonRaw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (jsonRaw) {
    const parsed = JSON.parse(jsonRaw);
    if (parsed?.private_key) parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
    return parsed;
  }

  throw new Error('Faltan credenciales de Firebase Admin. Define FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY o FIREBASE_SERVICE_ACCOUNT_JSON.');
}

export function getAdminDb() {
  if (!getApps().length) {
    initializeApp({ credential: cert(getServiceAccount()) });
  }
  return getFirestore();
}
