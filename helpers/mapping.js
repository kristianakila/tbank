const { db, admin } = require('../config/firebase');

async function saveOrderMapping(tbankOrderId, userId, orderId) {
  await db.collection('orderMappings').doc(tbankOrderId.toString()).set({
    userId: userId.toString(),
    orderId: orderId.toString(),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function findOrderByTbankOrderId(tbankOrderId) {
  const ref = db.collection('orderMappings').doc(tbankOrderId.toString());
  const doc = await ref.get();
  if (!doc.exists) return null;

  const data = doc.data();
  return {
    userId: data.userId,
    orderId: data.orderId,
    docRef: db.collection('telegramUsers')
      .doc(data.userId)
      .collection('orders')
      .doc(data.orderId)
  };
}

module.exports = { saveOrderMapping, findOrderByTbankOrderId };
