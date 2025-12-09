const schedule = require('node-schedule');
const admin = require('firebase-admin');
const { getDatabase } = require('../config/firebase');
const tbankService = require('./tbankService');

const scheduledJobs = new Map();
const db = getDatabase();

/**
 * Получить цену повторного списания из Firebase
 */
async function getRecurringPaymentPrice() {
  try {
    const subscriptionProductRef = db.collection('subscriptionProducts')
      .doc('subscription_1765286344111');
    const subscriptionProductDoc = await subscriptionProductRef.get();
    
    if (subscriptionProductDoc.exists) {
      const productData = subscriptionProductDoc.data();
      if (productData.recurringPaymentPrice) {
        const price = productData.recurringPaymentPrice;
        console.log(`✅ Получена цена повторного списания из Firebase: ${price}`);
        return price;
      }
    }
    
    console.log('⚠️ Цена повторного списания не найдена, используется значение по умолчанию');
    return null;
  } catch (error) {
    console.error('❌ Ошибка получения цены повторного списания:', error.message);
    return null;
  }
}

/**
 * Расписание для автоматического списания подписки
 */
async function scheduleSubscriptionPayment(userId, subscriptionData) {
  const { nextPaymentDate, rebillId, email, subscriptionId } = subscriptionData;
  
  if (!nextPaymentDate || !rebillId) {
    console.error('❌ Недостаточно данных для планирования');
    return null;
  }

  // Получаем текущую цену повторного списания
  let amount = subscriptionData.amount || 390; // Значение по умолчанию
  const recurringPrice = await getRecurringPaymentPrice();
  
  if (recurringPrice !== null) {
    amount = recurringPrice;
    console.log(`💰 Установлена цена списания: ${amount} (из Firebase)`);
  } else {
    console.log(`💰 Используется сохраненная цена: ${amount}`);
  }

  const jobId = `sub_${userId}_${subscriptionId}`;
  
  // Отменяем предыдущее задание, если оно существует
  if (scheduledJobs.has(jobId)) {
    scheduledJobs.get(jobId).cancel();
    scheduledJobs.delete(jobId);
    console.log(`🗑️ Отменено предыдущее задание для ${jobId}`);
  }

  const paymentDate = new Date(nextPaymentDate);
  
  // Проверяем, что дата в будущем
  if (paymentDate <= new Date()) {
    console.error('❌ Дата платежа должна быть в будущем');
    return null;
  }

  // Создаем задание для списания
  const job = schedule.scheduleJob(paymentDate, async () => {
    console.log(`⏰ Выполняю автоматическое списание для пользователя ${userId}`);
    
    try {
      // Получаем актуальную цену на момент списания
      const currentRecurringPrice = await getRecurringPaymentPrice();
      const paymentAmount = currentRecurringPrice !== null ? currentRecurringPrice : amount;
      
      // Выполняем платеж
      await executeRecurrentPayment({
        userId,
        rebillId,
        amount: paymentAmount,
        email,
        description: 'Автоматическое списание по подписке',
        subscriptionId
      });
      
      // Планируем следующий платеж через месяц
      const nextDate = new Date(paymentDate);
      nextDate.setMonth(nextDate.getMonth() + 1);
      
      // Обновляем подписку с актуальной ценой
      await db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('subscriptions')
        .doc(subscriptionId)
        .update({
          nextPaymentDate: nextDate.toISOString(),
          lastScheduledPayment: new Date().toISOString(),
          amount: paymentAmount, // Обновляем сумму следующего платежа
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      
      // Планируем следующий платеж
      await scheduleSubscriptionPayment(userId, {
        ...subscriptionData,
        nextPaymentDate: nextDate.toISOString(),
        amount: paymentAmount
      });
      
      console.log(`✅ Следующий платеж запланирован на ${nextDate.toISOString()} с суммой ${paymentAmount}`);
    } catch (error) {
      console.error(`❌ Ошибка автоматического списания для ${userId}:`, error);
      
      // Отмечаем неудачную попытку
      await db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('subscriptions')
        .doc(subscriptionId)
        .update({
          'paymentFailures': admin.firestore.FieldValue.arrayUnion({
            date: new Date().toISOString(),
            error: error.message
          }),
          status: 'payment_failed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
  });

  scheduledJobs.set(jobId, job);
  console.log(`✅ Платеж запланирован для ${userId} на ${paymentDate.toISOString()} с суммой ${amount}`);
  
  return jobId;
}

/**
 * Выполнение рекуррентного платежа
 */
async function executeRecurrentPayment(params) {
  const { userId, rebillId, amount, email, description, subscriptionId } = params;
  const tbank = tbankService.getTbankInstance();
  
  try {
    const orderId = `recurrent-auto-${Date.now()}-${userId}`;
    
    // Создаем чек
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

    // Создаем новый платеж
    const newPayment = await tbank.initPayment({
      Amount: amount * 100,
      OrderId: orderId,
      Description: description || 'Автоматическое списание по подписке',
      Receipt: receipt,
    });

    console.log(`✅ Платеж создан. PaymentId: ${newPayment.PaymentId}`);

    // Проводим списание
    const chargeResult = await tbank.chargeRecurrent({
      PaymentId: newPayment.PaymentId,
      RebillId: rebillId,
    });

    console.log(`✅ Списание выполнено. Успех: ${chargeResult.Success}, Статус: ${chargeResult.Status}`);

    // Сохраняем результат платежа
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

    // Обновляем статус подписки
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
      
      console.log(`✅ Платеж успешно выполнен и сохранен для ${userId}`);
      return { success: true, paymentId: newPayment.PaymentId };
    } else {
      throw new Error(`Ошибка списания: ${chargeResult.Message || 'Unknown error'}`);
    }
  } catch (error) {
    console.error(`❌ Ошибка выполнения платежа для ${userId}:`, error);
    throw error;
  }
}

/**
 * Восстановление расписания при запуске сервера
 */
async function restoreScheduledJobs() {
  console.log('🔍 Восстанавливаю запланированные платежи...');
  
  try {
    const subscriptionsSnapshot = await db.collectionGroup('subscriptions').get();
    
    let restoredCount = 0;
    const now = new Date();
    
    for (const doc of subscriptionsSnapshot.docs) {
      try {
        const subscriptionData = doc.data();
        const userId = doc.ref.parent.parent.id;
        const subscriptionId = doc.id;
        
        // Проверяем условия локально
        if (subscriptionData.status === 'active' && 
            subscriptionData.nextPaymentDate &&
            new Date(subscriptionData.nextPaymentDate) > now) {
          
          const jobId = await scheduleSubscriptionPayment(userId, {
            ...subscriptionData,
            subscriptionId
          });
          
          if (jobId) {
            restoredCount++;
            console.log(`✅ Восстановлено расписание для пользователя ${userId}, подписка ${subscriptionId}`);
          }
        }
      } catch (error) {
        console.error(`❌ Ошибка восстановления подписки ${doc.id}:`, error);
      }
    }
    
    console.log(`✅ Восстановлено ${restoredCount} запланированных платежей из ${subscriptionsSnapshot.size} найденных подписок`);
    
  } catch (error) {
    console.error('❌ Ошибка при восстановлении расписания:', error.message);
  }
}

module.exports = {
  scheduledJobs,
  scheduleSubscriptionPayment,
  executeRecurrentPayment,
  restoreScheduledJobs,
  getRecurringPaymentPrice // Экспортируем для использования в других модулях
};
