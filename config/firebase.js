const admin = require('firebase-admin');

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });

  console.log('✅ Firebase Admin инициализирован');
} catch (error) {
  console.error('❌ Ошибка инициализации Firebase:', error.message);
}

const db = admin.firestore();

module.exports = { admin, db };
