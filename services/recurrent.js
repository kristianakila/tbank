const { db, admin } = require('../config/firebase');
const tbank = require('./tbank');

async function executeRecurrentPayment(params) {
  const { userId, rebillId, amount, email, description, subscriptionId } = params;

  const orderId = `recurrent-auto-${Date.now()}-${userId}`;

  const receipt = {
    Email: email,
    Phone: '+79001234567',
    Taxation: 'osn',
    Items: [
      {
        Name: description || 'Автоматическое списание по подписке',
        Price: amount * 100,
        Quantity: 1,
        Amount: amount * 100,
        Tax: 'vat20',
        PaymentMethod: 'full_payment',
        PaymentObject: 'service'
      }
    ]
  };

  const newPayment = await tbank.initPayment({
    Amount: amount * 100,
    OrderId: orderId,
    Description: description || 'Автоматическое списание по подписке',
    Receipt: receipt,
  });

  const chargeResult = await tbank.chargeRecurrent({
    PaymentId: newPayment.PaymentId,
    RebillId: rebillId,
  });

  await db.collection('telegramUsers')
    .doc(userId.toString())
    .collection('orders')
    .doc(orderId)
    .set({
      tinkoff: {
        ...chargeResult,
        RebillId: rebillId,
        Amount: amount * 100,
        PaymentId: newPayment.PaymentId,
        OrderId: orderId
      },
      type: 'recurrent_auto',
      status: chargeResult.Status,
      amount: amount,
      paymentId: newPayment.PaymentId,
      orderId: orderId,
      rebillId: rebillId,
      subscriptionId: subscriptionId,
      success: chargeResult.Success,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

  if (chargeResult.Success) {
    await db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions')
      .doc(subscriptionId)
      .update({
        lastSuccessfulPayment: new Date().toISOString(),
        totalPaid: admin.firestore.FieldValue.increment(amount),
        paymentHistory: admin.firestore.FieldValue.arrayUnion({
          date: new Date().toISOString(),
          amount: amount,
          paymentId: newPayment.PaymentId,
          orderId: orderId,
          status: 'success'
        }),
        status: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    return { success: true, paymentId: newPayment.PaymentId };
  } else {
    throw new Error(`Ошибка списания: ${chargeResult.Message || 'Unknown error'}`);
  }
}

module.exports = { executeRecurrentPayment };
