const schedule = require('node-schedule');
const admin = require('firebase-admin');
const { getDatabase } = require('../config/firebase');
const tbankService = require('./tbankService');

const scheduledJobs = new Map();
const db = getDatabase();

/**
 * Получить цену первого платежа из Firebase
 */
async function getFirstPaymentPrice() {
  try {
    const subscriptionProductRef = db.collection('subscriptionProducts')
      .doc('subscription_1765286344111');
    const subscriptionProductDoc = await subscriptionProductRef.get();
    
    if (subscriptionProductDoc.exists) {
      const productData = subscriptionProductDoc.data();
      if (productData.firstPaymentPrice !== undefined) {
        const price = productData.firstPaymentPrice;
        console.log(`✅ Получена цена первого платежа из Firebase: ${price}`);
        return price;
      }
    }
    
    console.log('⚠️ Цена первого платежа не найдена, используется значение по умолчанию');
    return 390; // Значение по умолчанию
  } catch (error) {
    console.error('❌ Ошибка получения цены первого платежа:', error.message);
    return 390; // Значение по умолчанию при ошибке
  }
}

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
      if (productData.recurringPaymentPrice !== undefined) {
        const price = productData.recurringPaymentPrice;
        console.log(`✅ Получена цена повторного списания из Firebase: ${price}`);
        return price;
      }
    }
    
    console.log('⚠️ Цена повторного списания не найдена, используется значение по умолчанию');
    return 390; // Значение по умолчанию
  } catch (error) {
    console.error('❌ Ошибка получения цены повторного списания:', error.message);
    return 390; // Значение по умолчанию при ошибке
  }
}

/**
 * Проверка на наличие других активных подписок у пользователя
 */
async function checkOtherActiveSubscriptions(userId, currentSubscriptionId) {
  try {
    const subscriptionsRef = db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions');
    
    // Найти все активные подписки кроме текущей
    const activeSubscriptions = await subscriptionsRef
      .where('status', '==', 'active')
      .get();
    
    const otherActiveSubscriptions = [];
    
    activeSubscriptions.forEach(doc => {
      if (doc.id !== currentSubscriptionId) {
        otherActiveSubscriptions.push({
          id: doc.id,
          data: doc.data()
        });
      }
    });
    
    if (otherActiveSubscriptions.length > 0) {
      console.log(`⚠️ У пользователя ${userId} найдены другие активные подписки:`, 
        otherActiveSubscriptions.map(sub => sub.id));
      return otherActiveSubscriptions;
    }
    
    return [];
  } catch (error) {
    console.error('❌ Ошибка проверки активных подписок:', error.message);
    return [];
  }
}

/**
 * Отмена всех других активных подписок пользователя
 */
async function cancelOtherActiveSubscriptions(userId, keepSubscriptionId) {
  try {
    const otherSubscriptions = await checkOtherActiveSubscriptions(userId, keepSubscriptionId);
    
    if (otherSubscriptions.length === 0) {
      return { cancelled: 0, errors: 0 };
    }
    
    let cancelled = 0;
    let errors = 0;
    
    for (const subscription of otherSubscriptions) {
      try {
        const subscriptionRef = db.collection('telegramUsers')
          .doc(userId.toString())
          .collection('subscriptions')
          .doc(subscription.id);
        
        await subscriptionRef.update({
          status: 'cancelled_by_system',
          cancellationReason: 'multiple_active_subscriptions',
          cancelledAt: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Отменяем запланированное списание
        const jobId = `sub_${userId}_${subscription.id}`;
        if (scheduledJobs.has(jobId)) {
          scheduledJobs.get(jobId).cancel();
          scheduledJobs.delete(jobId);
          console.log(`🗑️ Отменено запланированное списание для ${jobId}`);
        }
        
        cancelled++;
        console.log(`✅ Отменена дублирующая подписка ${subscription.id} для пользователя ${userId}`);
      } catch (error) {
        console.error(`❌ Ошибка отмены подписки ${subscription.id}:`, error.message);
        errors++;
      }
    }
    
    return { cancelled, errors };
  } catch (error) {
    console.error('❌ Ошибка при отмене других подписок:', error.message);
    return { cancelled: 0, errors: 1 };
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

  // Проверяем и отменяем другие активные подписки
  const cancellationResult = await cancelOtherActiveSubscriptions(userId, subscriptionId);
  if (cancellationResult.errors > 0) {
    console.log(`⚠️ Были ошибки при отмене других подписок для ${userId}`);
  }
  if (cancellationResult.cancelled > 0) {
    console.log(`✅ Отменено ${cancellationResult.cancelled} других активных подписок для ${userId}`);
  }

  // Получаем актуальную цену повторного списания
  const amount = await getRecurringPaymentPrice();
  console.log(`💰 Установлена цена списания: ${amount} (из Firebase)`);

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
      // Проверяем, что текущая подписка все еще активна
      const subscriptionRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('subscriptions')
        .doc(subscriptionId);
      
      const subscriptionDoc = await subscriptionRef.get();
      
      if (!subscriptionDoc.exists) {
        console.error(`❌ Подписка ${subscriptionId} не найдена, отменяем списание`);
        scheduledJobs.delete(jobId);
        return;
      }
      
      const subscriptionData = subscriptionDoc.data();
      if (subscriptionData.status !== 'active') {
        console.error(`❌ Подписка ${subscriptionId} не активна (статус: ${subscriptionData.status}), отменяем списание`);
        scheduledJobs.delete(jobId);
        return;
      }
      
      // Проверяем, что у пользователя нет других активных подписок
      const otherActiveSubscriptions = await checkOtherActiveSubscriptions(userId, subscriptionId);
      if (otherActiveSubscriptions.length > 0) {
        console.error(`❌ У пользователя ${userId} найдены другие активные подписки, отменяем текущее списание`);
        scheduledJobs.delete(jobId);
        return;
      }

      // Получаем актуальную цену на момент списания
      const currentRecurringPrice = await getRecurringPaymentPrice();
      const paymentAmount = currentRecurringPrice;
      
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
      await subscriptionRef.update({
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
    // Проверяем, что подписка все еще активна перед списанием
    const subscriptionRef = db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions')
      .doc(subscriptionId);
    
    const subscriptionDoc = await subscriptionRef.get();
    
    if (!subscriptionDoc.exists) {
      throw new Error(`Подписка ${subscriptionId} не найдена`);
    }
    
    const subscriptionData = subscriptionDoc.data();
    if (subscriptionData.status !== 'active') {
      throw new Error(`Подписка ${subscriptionId} не активна (статус: ${subscriptionData.status})`);
    }
    
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
      await subscriptionRef.update({
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
    
    // Собираем всех пользователей и их подписки
    const userSubscriptions = new Map(); // userId -> Array of subscriptions
    
    // Сначала группируем подписки по пользователям
    for (const doc of subscriptionsSnapshot.docs) {
      const subscriptionData = doc.data();
      const userId = doc.ref.parent.parent.id;
      const subscriptionId = doc.id;
      
      if (subscriptionData.status === 'active' && 
          subscriptionData.nextPaymentDate &&
          new Date(subscriptionData.nextPaymentDate) > now) {
        
        if (!userSubscriptions.has(userId)) {
          userSubscriptions.set(userId, []);
        }
        
        userSubscriptions.get(userId).push({
          id: subscriptionId,
          data: subscriptionData,
          docRef: doc.ref
        });
      }
    }
    
    // Для каждого пользователя оставляем только одну самую новую подписку
    for (const [userId, subscriptions] of userSubscriptions.entries()) {
      if (subscriptions.length === 0) continue;
      
      // Сортируем по дате создания (самая новая первая)
      subscriptions.sort((a, b) => {
        const dateA = a.data.createdAt ? new Date(a.data.createdAt) : new Date(0);
        const dateB = b.data.createdAt ? new Date(b.data.createdAt) : new Date(0);
        return dateB.getTime() - dateA.getTime();
      });
      
      // Оставляем только самую новую подписку
      const keepSubscription = subscriptions[0];
      const otherSubscriptions = subscriptions.slice(1);
      
      // Отменяем старые подписки
      for (const oldSubscription of otherSubscriptions) {
        try {
          await oldSubscription.docRef.update({
            status: 'cancelled_by_system',
            cancellationReason: 'multiple_subscriptions_on_restart',
            cancelledAt: new Date().toISOString(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`✅ Отменена старая подписка ${oldSubscription.id} при восстановлении для ${userId}`);
        } catch (error) {
          console.error(`❌ Ошибка отмены старой подписки ${oldSubscription.id}:`, error.message);
        }
      }
      
      // Восстанавливаем только одну подписку
      try {
        const jobId = await scheduleSubscriptionPayment(userId, {
          ...keepSubscription.data,
          subscriptionId: keepSubscription.id
        });
        
        if (jobId) {
          restoredCount++;
          console.log(`✅ Восстановлено расписание для пользователя ${userId}, подписка ${keepSubscription.id}`);
        }
      } catch (error) {
        console.error(`❌ Ошибка восстановления подписки ${keepSubscription.id}:`, error);
      }
    }
    
    console.log(`✅ Восстановлено ${restoredCount} запланированных платежей из ${subscriptionsSnapshot.size} найденных подписок`);
    console.log(`📅 Активных запланированных платежей: ${scheduledJobs.size}`);
    
  } catch (error) {
    console.error('❌ Ошибка при восстановлении расписания:', error.message);
  }
}

module.exports = {
  scheduledJobs,
  scheduleSubscriptionPayment,
  executeRecurrentPayment,
  restoreScheduledJobs,
  getFirstPaymentPrice,
  getRecurringPaymentPrice,
  checkOtherActiveSubscriptions,
  cancelOtherActiveSubscriptions
};
