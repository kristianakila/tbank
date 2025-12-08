const { db, admin } = require('../config/firebase');
const { scheduleSubscriptionPayment } = require('../services/scheduler');

async function cancelUserSubscription(userId, subscriptionId) {
  await db.collection('telegramUsers')
    .doc(userId.toString())
    .collection('subscriptions')
    .doc(subscriptionId)
    .update({
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

  const jobId = `sub_${userId}_${subscriptionId}`;
  return true;
}

async function saveUserSubscription(userId, webhookData, rebillId, amount = 390) {
  const { CardId, Pan, OrderId } = webhookData;

  const subscriptionsRef = db.collection('telegramUsers')
    .doc(userId.toString())
    .collection('subscriptions');

  const existing = await subscriptionsRef
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (!existing.empty) {
    const doc = existing.docs[0];
    const data = doc.data();

    if (data.rebillId === rebillId) {
      const updateData = {
        lastSuccessfulPayment: new Date().toISOString(),
        totalPaid: admin.firestore.FieldValue.increment(amount),
        paymentHistory: admin.firestore.FieldValue.arrayUnion({
          date: new Date().toISOString(),
          amount: amount,
          paymentId: webhookData.PaymentId,
          orderId: OrderId,
          status: 'success'
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        nextPaymentDate: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString(),
        webhookData: webhookData
      };

      await doc.ref.update(updateData);

      scheduleSubscriptionPayment(userId, {
        ...data,
        ...updateData,
        subscriptionId: doc.id,
        email: webhookData.Email || 'user@example.com',
        amount
      });

      return { subscriptionId: doc.id, updated: true };
    }

    await cancelUserSubscription(userId, doc.id);
  }

  const now = new Date();
  const next = new Date();
  next.setMonth(next.getMonth() + 1);

  const subscriptionId = `sub_${Date.now()}`;
  const subscriptionData = {
    rebillId,
    cardLastDigits: Pan ? Pan.slice(-4) : null,
    cardId: CardId,
    status: 'active',
    amount,
    initialPaymentDate: now.toISOString(),
    nextPaymentDate: next.toISOString(),
    lastSuccessfulPayment: now.toISOString(),
    totalPaid: amount,
    paymentHistory: [{
      date: now.toISOString(),
      amount,
      paymentId: webhookData.PaymentId,
      orderId: OrderId,
      status: 'success'
    }],
    webhookData,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await subscriptionsRef.doc(subscriptionId).set(subscriptionData);

  scheduleSubscriptionPayment(userId, {
    ...subscriptionData,
    subscriptionId,
    email: webhookData.Email || 'user@example.com'
  });

  return { subscriptionId, nextPaymentDate: next.toISOString() };
}

module.exports = {
  saveUserSubscription,
  cancelUserSubscription
};
