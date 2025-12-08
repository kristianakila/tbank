const admin = require('firebase-admin');
require('dotenv').config();

let db = null;
let isInitialized = false;

/**
 * Инициализация Firebase
 */
function initializeFirebase() {
  if (isInitialized) {
    console.log('⚠️ Firebase уже инициализирован');
    return;
  }
  
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    
    db = admin.firestore();
    isInitialized = true;
    
    console.log('✅ Firebase Admin инициализирован');
  } catch (error) {
    console.error('❌ Ошибка инициализации Firebase:', error.message);
    throw error;
  }
}

/**
 * Получить экземпляр базы данных
 */
function getDatabase() {
  if (!isInitialized) {
    initializeFirebase();
  }
  return db;
}

/**
 * Получить экземпляр admin
 */
function getAdmin() {
  if (!isInitialized) {
    initializeFirebase();
  }
  return admin;
}

module.exports = {
  initializeFirebase,
  getDatabase,
  getAdmin,
  isInitialized
};
