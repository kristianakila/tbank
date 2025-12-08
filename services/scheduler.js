const schedule = require('node-schedule');
const { db, admin } = require('../config/firebase');
const { executeRecurrentPayment } = require('./recurrent');

const scheduledJobs = new Map();

function scheduleSubscriptionPayment(userId, subscriptionData) {
  const { nextPaymentDate, amount, rebillId, email, subscriptionId } = subscriptionData;

  if (!nextPaymentDate || !rebillId) return null;

  const jobId = `sub_${userId}_${subscriptionId}`;

  if (scheduledJobs.has(jobId)) {
    scheduledJobs.get(jobId).cancel();
    scheduledJobs.delete(jobId);
  }

  const paymentDate = new Date(nextPaymentDate);
  if (paymentDate <= new Date()) return null;

  const job = schedule.scheduleJob(paymentDate, async () => {
    try {
      await executeRecurrentPayment({
        userId,
        rebillId,
        amount,
        email,
        description: 'Автоматическое списание по подписке',
        subscriptionId
      });

      const nextDate = new Date(paymentDate);
      nextDate.setMonth(nextDate.getMonth() + 1);

      await db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('subscriptions')
        .doc(subscriptionId)
        .update({
          nextPaymentDate: nextDate.toISOString(),
          lastScheduledPayment: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

      scheduleSubscriptionPayment(userId, {
        ...subscriptionData,
        nextPaymentDate: nextDate.toISOString()
      });

    } catch (error) {
      await db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('subscriptions')
        .doc(subscriptionId)
        .update({
          paymentFailures: admin.firestore.FieldValue.arrayUnion({
            date: new Date().toISOString(),
            error: error.message
          }),
          status: 'payment_failed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
  });

  scheduledJobs.set(jobId, job);
  return jobId;
}

async function restoreScheduledJobs() {
  console.log('🔍 Восстанавливаю запланированные платежи...');

  try {
    const subscriptionsSnapshot = await db.collectionGroup('subscriptions').get();
    const now = new Date();

    for (const doc of subscriptionsSnapshot.docs) {
      const data = doc.data();
      const userId = doc.ref.parent.parent.id;
      const subscriptionId = doc.id;

      if (data.status === 'active' &&
          data.nextPaymentDate &&
          new Date(data.nextPaymentDate) > now) {
        scheduleSubscriptionPayment(userId, {
          ...data,
          subscriptionId
        });
      }
    }
  } catch (error) {
    console.error('❌ Ошибка восстановления расписаний:', error.message);
  }
}

module.exports = {
  scheduleSubscriptionPayment,
  restoreScheduledJobs
};
