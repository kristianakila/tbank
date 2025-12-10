const admin = require('firebase-admin');
const { getDatabase, getAdmin } = require('../config/firebase');
const schedulerService = require('./schedulerService');

const db = getDatabase();
const adminInstance = getAdmin();

/**
 * Ищет заказ по OrderId в специальной коллекции для быстрого поиска
 */
async function findOrderByTbankOrderId(tbankOrderId) {
  try {
    if (!tbankOrderId) {
      console.log('⚠️ Пустой OrderId для поиска');
      return null;
    }
    
    const orderRef = db.collection('orderMappings').doc(tbankOrderId.toString());
    const orderDoc = await orderRef.get();
    
    if (orderDoc.exists) {
      const data = orderDoc.data();
      return {
        userId: data.userId,
        orderId: data.orderId,
        docRef: db.collection('telegramUsers')
          .doc(data.userId.toString())
          .collection('orders')
          .doc(data.orderId.toString())
      };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Ошибка поиска заказа:', error.message);
    return null;
  }
}

/**
 * Сохраняет маппинг OrderId -> userId/orderId для быстрого поиска
 */
async function saveOrderMapping(tbankOrderId, userId, orderId) {
  try {
    if (!tbankOrderId || !userId || !orderId) {
      console.error('❌ Ошибка: пустые параметры для маппинга');
      return;
    }
    
    await db.collection('orderMappings').doc(tbankOrderId.toString()).set({
      userId: userId.toString(),
      orderId: orderId.toString(),
      createdAt: adminInstance.firestore.FieldValue.serverTimestamp()
    });
    console.log(`✅ Маппинг сохранен: ${tbankOrderId} -> ${userId}/${orderId}`);
  } catch (error) {
    console.error('❌ Ошибка сохранения маппинга:', error);
  }
}

/**
 * Обновляет платеж в Firebase с данными из вебхука
 */
async function updatePaymentFromWebhook(userId, orderId, webhookData) {
  try {
    const {
      PaymentId,
      OrderId,
      Success,
      Status,
      Amount,
      RebillId,
      CardId,
      Pan,
      Token,
      PaymentURL
    } = webhookData;
    
    const updateData = {
      'tinkoff.webhook': webhookData,
      'tinkoff.Status': Status,
      'tinkoff.Success': Success,
      'tinkoff.Amount': Amount,
      'tinkoff.PaymentId': PaymentId,
      status: Status,
      updatedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
    };
    
    if (RebillId) {
      updateData.rebillId = RebillId;
      updateData['tinkoff.RebillId'] = RebillId;
      updateData.finishedAt = adminInstance.firestore.FieldValue.serverTimestamp();
      console.log(`🔄 RebillId получен: ${RebillId}`);
    }
    
    if (CardId) {
      updateData['tinkoff.CardId'] = CardId;
    }
    
    const docRef = db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('orders')
      .doc(orderId);
    
    await docRef.update(updateData);
    
    console.log(`✅ Платеж обновлен из вебхука: userId=${userId}, orderId=${orderId}`);
    console.log(`📊 Статус: ${Status}, RebillId: ${RebillId || 'не получен'}`);
    
    return RebillId;
  } catch (error) {
    console.error('❌ Ошибка обновления из вебхука:', error.message);
    
    try {
      const docRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('orders')
        .doc(orderId);
      
      await docRef.set({
        tinkoff: webhookData,
        status: webhookData.Status || 'UNKNOWN',
        amount: webhookData.Amount ? webhookData.Amount / 100 : 0,
        paymentId: webhookData.PaymentId,
        orderId: orderId,
        rebillId: webhookData.RebillId || null,
        createdAt: adminInstance.firestore.FieldValue.serverTimestamp(),
        updatedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
        ...(webhookData.RebillId && { finishedAt: adminInstance.firestore.FieldValue.serverTimestamp() })
      });
      
      console.log(`✅ Создан новый документ из вебхука: ${userId}/${orderId}`);
      return webhookData.RebillId;
    } catch (createError) {
      console.error('❌ Не удалось создать документ:', createError);
      return null;
    }
  }
}

async function saveUserSubscription(userId, webhookData, rebillId) {
  try {
    const { CardId, Pan, Amount, OrderId, PaymentId } = webhookData;
    
    // === 1. ПРОВЕРКА НА ДУБЛИРОВАНИЕ ===
    const paymentKey = `payment_${PaymentId}`;
    const paymentCheckRef = db.collection('processedPayments').doc(paymentKey);
    const paymentCheckDoc = await paymentCheckRef.get();
    
    if (paymentCheckDoc.exists) {
      const existingData = paymentCheckDoc.data();
      console.log(`⚠️ Платеж ${PaymentId} уже обработан ранее. Подписка: ${existingData.subscriptionId || 'нет ID'}`);
      
      // Если подписка уже существует, возвращаем ее ID
      if (existingData.subscriptionId) {
        return { 
          alreadyProcessed: true, 
          subscriptionId: existingData.subscriptionId,
          userId: existingData.userId
        };
      }
    }
    
    // === 2. ПОЛУЧЕНИЕ ЦЕН ИЗ БАЗЫ ДАННЫХ ===
    // Получаем цену первого платежа
    const firstPaymentPrice = await getFirstPaymentPrice();
    console.log(`💰 Цена первого платежа из БД: ${firstPaymentPrice} руб.`);
    
    // Получаем цену повторного списания
    const recurringPaymentPrice = await getRecurringPaymentPrice();
    console.log(`💰 Цена повторного списания из БД: ${recurringPaymentPrice} руб.`);
    
    // === 3. ПРОВЕРКА АКТИВНЫХ ПОДПИСОК ===
    const subscriptionsRef = db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions');
    
    // Ищем активные подписки
    const existingSubscriptions = await subscriptionsRef
      .where('status', '==', 'active')
      .limit(1)
      .get();
    
    let subscriptionId;
    let isExistingSubscription = false;
    
    if (!existingSubscriptions.empty) {
      const existingDoc = existingSubscriptions.docs[0];
      const existingData = existingDoc.data();
      subscriptionId = existingDoc.id;
      
      // Если уже есть активная подписка с таким же rebillId
      if (existingData.rebillId === rebillId) {
        console.log(`⚠️ У пользователя ${userId} уже есть активная подписка с rebillId ${rebillId}`);
        console.log(`📝 Обновляю существующую подписку ${subscriptionId}`);
        
        // Проверяем, не был ли этот платеж уже добавлен
        const existingPayment = existingData.paymentHistory?.find(
          payment => payment.paymentId === PaymentId
        );
        
        if (existingPayment) {
          console.log(`⚠️ Платеж ${PaymentId} уже есть в истории подписки ${subscriptionId}`);
          
          // Помечаем платеж как обработанный
          await paymentCheckRef.set({
            paymentId: PaymentId,
            userId: userId,
            subscriptionId: subscriptionId,
            processedAt: new Date().toISOString(),
            amount: firstPaymentPrice,
            status: 'already_in_history'
          }, { ignoreUndefinedProperties: true });
          
          return { 
            alreadyProcessed: true, 
            subscriptionId: subscriptionId,
            updated: false 
          };
        }
        
        // Обновляем существующую подписку
        const updateData = {
          lastSuccessfulPayment: new Date().toISOString(),
          totalPaid: adminInstance.firestore.FieldValue.increment(firstPaymentPrice),
          paymentHistory: adminInstance.firestore.FieldValue.arrayUnion({
            date: new Date().toISOString(),
            amount: firstPaymentPrice,
            paymentId: PaymentId,
            orderId: OrderId,
            status: 'success',
            type: 'recurring_payment'
          }),
          updatedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
          nextPaymentDate: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString(),
          webhookData: webhookData,
          amount: recurringPaymentPrice
        };
        
        await existingDoc.ref.update(updateData);
        
        // Обновляем планирование
        await schedulerService.scheduleSubscriptionPayment(userId, {
          ...existingData,
          ...updateData,
          subscriptionId,
          email: webhookData.Email || existingData.email || 'user@example.com',
          amount: recurringPaymentPrice
        });
        
        // Помечаем платеж как обработанный
        await paymentCheckRef.set({
          paymentId: PaymentId,
          userId: userId,
          subscriptionId: subscriptionId,
          processedAt: new Date().toISOString(),
          amount: firstPaymentPrice,
          status: 'updated_existing_subscription'
        }, { ignoreUndefinedProperties: true });
        
        return { subscriptionId: subscriptionId, updated: true };
      }
      
      // Если есть активная подписка, но с другим rebillId
      console.log(`⚠️ У пользователя ${userId} уже есть активная подписка. Отменяю старую и создаю новую.`);
      await cancelUserSubscription(userId, subscriptionId);
    }
    
    // === 4. СОЗДАНИЕ НОВОЙ ПОДПИСКИ ===
    const now = new Date();
    const nextPaymentDate = new Date(now);
    nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
    
    subscriptionId = `sub_${Date.now()}`;
    
    const subscriptionData = {
      rebillId: rebillId,
      cardLastDigits: Pan ? Pan.slice(-4) : null,
      cardId: CardId,
      status: 'active',
      amount: recurringPaymentPrice,
      initialPaymentDate: now.toISOString(),
      nextPaymentDate: nextPaymentDate.toISOString(),
      lastSuccessfulPayment: now.toISOString(),
      totalPaid: firstPaymentPrice,
      paymentHistory: [{
        date: now.toISOString(),
        amount: firstPaymentPrice,
        paymentId: PaymentId,
        orderId: OrderId,
        status: 'success',
        type: 'initial_payment'
      }],
      priceSettings: {
        firstPaymentPrice: firstPaymentPrice,
        recurringPaymentPrice: recurringPaymentPrice,
        savedAt: now.toISOString()
      },
      createdAt: adminInstance.firestore.FieldValue.serverTimestamp(),
      updatedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
      webhookData: webhookData
    };
    
    await subscriptionsRef.doc(subscriptionId).set(subscriptionData);
    
    console.log(`✅ Подписка сохранена для userId=${userId}, subscriptionId=${subscriptionId}`);
    console.log(`💰 Первый платеж (из БД): ${firstPaymentPrice} руб.`);
    console.log(`💰 Цена повторного списания (из БД): ${recurringPaymentPrice} руб.`);
    
    // Планируем автоматическое списание
    await schedulerService.scheduleSubscriptionPayment(userId, {
      ...subscriptionData,
      subscriptionId,
      email: webhookData.Email || 'user@example.com',
      amount: recurringPaymentPrice
    });
    
    // Помечаем платеж как обработанный
    await paymentCheckRef.set({
      paymentId: PaymentId,
      userId: userId,
      subscriptionId: subscriptionId,
      processedAt: new Date().toISOString(),
      amount: firstPaymentPrice,
      status: 'new_subscription_created'
    }, { ignoreUndefinedProperties: true });
    
    return { 
      subscriptionId, 
      nextPaymentDate: nextPaymentDate.toISOString(),
      firstPaymentPrice: firstPaymentPrice,
      recurringPaymentPrice: recurringPaymentPrice 
    };
    
  } catch (error) {
    console.error('❌ Ошибка сохранения подписки:', error);
    
    // Логируем ошибку
    try {
      await db.collection('subscriptionErrors').doc(`${Date.now()}_${userId}`).set({
        userId: userId,
        paymentId: webhookData?.PaymentId,
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        webhookData: webhookData
      }, { ignoreUndefinedProperties: true });
    } catch (logError) {
      console.error('❌ Не удалось сохранить ошибку:', logError);
    }
    
    return false;
  }
}

// Вспомогательные функции (добавьте в этот же файл):

/**
 * Получает цену первого платежа из базы данных
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
    
    console.log('⚠️ Цена первого платежа не найдена, используется значение по умолчанию: 390');
    return 390;
  } catch (error) {
    console.error('❌ Ошибка получения цены первого платежа:', error.message);
    return 390;
  }
}

/**
 * Получает цену повторного списания из базы данных
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
    
    console.log('⚠️ Цена повторного списания не найдена, используется значение по умолчанию: 390');
    return 390;
  } catch (error) {
    console.error('❌ Ошибка получения цены повторного списания:', error.message);
    return 390;
  }
}

/**
 * Отменяет подписку пользователя
 */
async function cancelUserSubscription(userId, subscriptionId) {
  try {
    const subscriptionRef = db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions')
      .doc(subscriptionId);
    
    await subscriptionRef.update({
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      updatedAt: adminInstance.firestore.FieldValue.serverTimestamp()
    });
    
    // Отменяем запланированный платеж
    const jobId = `sub_${userId}_${subscriptionId}`;
    if (schedulerService.scheduledJobs.has(jobId)) {
      schedulerService.scheduledJobs.get(jobId).cancel();
      schedulerService.scheduledJobs.delete(jobId);
      console.log(`✅ Отменено запланированное списание для ${jobId}`);
    }
    
    console.log(`✅ Подписка отменена: userId=${userId}, subscriptionId=${subscriptionId}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отмены подписки:', error);
    return false;
  }
}

module.exports = {
  getDatabase,
  getAdmin,
  findOrderByTbankOrderId,
  saveOrderMapping,
  updatePaymentFromWebhook,
  saveUserSubscription,
  cancelUserSubscription
};
