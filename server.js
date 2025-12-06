const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ========== FIREBASE INITIALIZATION ==========
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
// =============================================

// Импортируем T-Bank
const TbankPayments = require('tbank-payments');

// Инициализация T-Bank клиента
const tbank = new TbankPayments({
  merchantId: process.env.TBANK_MERCHANT_ID,
  secret: process.env.TBANK_SECRET,
  apiUrl: process.env.TBANK_API_URL
});

// ========== СИСТЕМА ПЛАНИРОВАНИЯ ==========
const scheduledJobs = new Map();

/**
 * Расписание для автоматического списания подписки
 */
function scheduleSubscriptionPayment(userId, subscriptionData) {
  const { nextPaymentDate, amount, rebillId, email, subscriptionId } = subscriptionData;
  
  if (!nextPaymentDate || !rebillId) {
    console.error('❌ Недостаточно данных для планирования');
    return null;
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
      // Выполняем платеж
      await executeRecurrentPayment({
        userId,
        rebillId,
        amount,
        email,
        description: 'Автоматическое списание по подписке',
        subscriptionId
      });
      
      // Планируем следующий платеж через месяц
      const nextDate = new Date(paymentDate);
      nextDate.setMonth(nextDate.getMonth() + 1);
      
      // Обновляем подписку
      await db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('subscriptions')
        .doc(subscriptionId)
        .update({
          nextPaymentDate: nextDate.toISOString(),
          lastScheduledPayment: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      
      // Планируем следующий платеж
      scheduleSubscriptionPayment(userId, {
        ...subscriptionData,
        nextPaymentDate: nextDate.toISOString()
      });
      
      console.log(`✅ Следующий платеж запланирован на ${nextDate.toISOString()}`);
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
  console.log(`✅ Платеж запланирован для ${userId} на ${paymentDate.toISOString()}`);
  
  return jobId;
}

/**
 * Выполнение рекуррентного платежа
 */
async function executeRecurrentPayment(params) {
  const { userId, rebillId, amount, email, description, subscriptionId } = params;
  
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
    // ВАЖНО: Firebase требует индекс для запросов collectionGroup с несколькими условиями
    // Временно используем упрощенный запрос
    
    // Альтернативный подход 1: Получаем ВСЕ подписки и фильтруем локально
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
          
          const jobId = scheduleSubscriptionPayment(userId, {
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
    
    // Альтернативный подход 2: Временная обходная версия для отладки
    console.log('🔄 Использую альтернативный метод восстановления...');
    
    try {
      // Получаем подписки для конкретного тестового пользователя (если есть)
      const testUserId = '272401691';
      const subscriptionsRef = db.collection('telegramUsers')
        .doc(testUserId)
        .collection('subscriptions');
      
      const snapshot = await subscriptionsRef.get();
      
      let altRestoredCount = 0;
      
      snapshot.forEach(doc => {
        const subscriptionData = doc.data();
        if (subscriptionData.status === 'active' && subscriptionData.nextPaymentDate) {
          const jobId = scheduleSubscriptionPayment(testUserId, {
            ...subscriptionData,
            subscriptionId: doc.id
          });
          
          if (jobId) {
            altRestoredCount++;
          }
        }
      });
      
      console.log(`✅ Альтернативно восстановлено ${altRestoredCount} платежей для тестового пользователя`);
    } catch (altError) {
      console.error('❌ Ошибка альтернативного восстановления:', altError.message);
    }
  }
}

// ========== ПОМОЩНИКИ ДЛЯ FIREBASE ==========
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
      createdAt: admin.firestore.FieldValue.serverTimestamp()
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
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    
    if (RebillId) {
      updateData.rebillId = RebillId;
      updateData['tinkoff.RebillId'] = RebillId;
      updateData.finishedAt = admin.firestore.FieldValue.serverTimestamp();
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(webhookData.RebillId && { finishedAt: admin.firestore.FieldValue.serverTimestamp() })
      });
      
      console.log(`✅ Создан новый документ из вебхука: ${userId}/${orderId}`);
      return webhookData.RebillId;
    } catch (createError) {
      console.error('❌ Не удалось создать документ:', createError);
      return null;
    }
  }
}

/**
 * Сохраняет подписку пользователя и планирует автоматические списания
 */
async function saveUserSubscription(userId, webhookData, rebillId, amount = 390) {
  try {
    const { CardId, Pan, Amount, OrderId } = webhookData;
    
    // Рассчитываем даты
    const now = new Date();
    const nextPaymentDate = new Date(now);
    nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
    
    const subscriptionData = {
      rebillId: rebillId,
      cardLastDigits: Pan ? Pan.slice(-4) : null,
      cardId: CardId,
      status: 'active',
      amount: amount,
      initialPaymentDate: now.toISOString(),
      nextPaymentDate: nextPaymentDate.toISOString(),
      lastSuccessfulPayment: now.toISOString(),
      totalPaid: amount,
      paymentHistory: [{
        date: now.toISOString(),
        amount: amount,
        paymentId: webhookData.PaymentId,
        orderId: OrderId,
        status: 'success'
      }],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      webhookData: webhookData
    };
    
    const subscriptionId = `sub_${Date.now()}`;
    
    await db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions')
      .doc(subscriptionId)
      .set(subscriptionData);
    
    console.log(`✅ Подписка сохранена для userId=${userId}, subscriptionId=${subscriptionId}`);
    
    // Планируем автоматическое списание
    scheduleSubscriptionPayment(userId, {
      ...subscriptionData,
      subscriptionId,
      email: webhookData.Email || 'user@example.com'
    });
    
    return { subscriptionId, nextPaymentDate: nextPaymentDate.toISOString() };
  } catch (error) {
    console.error('❌ Ошибка сохранения подписки:', error);
    return false;
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
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Отменяем запланированный платеж
    const jobId = `sub_${userId}_${subscriptionId}`;
    if (scheduledJobs.has(jobId)) {
      scheduledJobs.get(jobId).cancel();
      scheduledJobs.delete(jobId);
      console.log(`✅ Отменено запланированное списание для ${jobId}`);
    }
    
    console.log(`✅ Подписка отменена: userId=${userId}, subscriptionId=${subscriptionId}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отмены подписки:', error);
    return false;
  }
}
// =============================================

// ВАЖНО: Для вебхука от T-Bank парсим raw body
app.use('/api/webhook', bodyParser.raw({ type: '*/*' }));

// Эндпоинт для вебхуков от T-Bank
app.post('/api/webhook', async (req, res) => {
  console.log('📨 ВЕБХУК: Получен запрос от T-Bank');
  
  let webhookData;
  
  try {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      const bodyString = req.body.toString();
      console.log('📨 ВЕБХУК: Raw body:', bodyString);
      
      try {
        webhookData = JSON.parse(bodyString);
      } catch (parseError) {
        const parsed = new URLSearchParams(bodyString);
        webhookData = {};
        for (const [key, value] of parsed.entries()) {
          webhookData[key] = value;
        }
      }
    } else {
      webhookData = req.body;
    }
    
    if (webhookData.PaymentId) webhookData.PaymentId = webhookData.PaymentId.toString();
    if (webhookData.RebillId) webhookData.RebillId = webhookData.RebillId.toString();
    if (webhookData.CardId) webhookData.CardId = webhookData.CardId.toString();
    
    console.log('📨 ВЕБХУК: Parsed data:', JSON.stringify(webhookData, null, 2));
    
    const {
      TerminalKey,
      OrderId,
      Success,
      Status,
      PaymentId,
      Amount,
      RebillId,
      CardId,
      Pan,
      Token
    } = webhookData;
    
    console.log('📨 ВЕБХУК:');
    console.log(`   OrderId: ${OrderId}`);
    console.log(`   PaymentId: ${PaymentId}`);
    console.log(`   Status: ${Status}`);
    console.log(`   Success: ${Success}`);
    console.log(`   RebillId: ${RebillId || 'не указан'}`);
    console.log(`   Amount: ${Amount ? Amount / 100 : 0} руб.`);
    
    // ВАЖНО: Всегда возвращаем успех сразу
    res.status(200).json({ Success: true, Error: '0' });
    
    setTimeout(async () => {
      try {
        console.log('🔄 ВЕБХУК: Начинаем обработку...');
        
        let orderInfo = null;
        
        if (OrderId) {
          orderInfo = await findOrderByTbankOrderId(OrderId);
        }
        
        if (orderInfo) {
          console.log(`✅ ВЕБХУК: Найден заказ: userId=${orderInfo.userId}, orderId=${orderInfo.orderId}`);
          
          const rebillId = await updatePaymentFromWebhook(
            orderInfo.userId, 
            orderInfo.orderId, 
            webhookData
          );
          
          if (rebillId) {
            console.log(`🎉 ВЕБХУК: RebillId сохранен: ${rebillId}`);
            
            // Сохраняем подписку пользователя с планированием
            await saveUserSubscription(orderInfo.userId, webhookData, rebillId);
          }
        } else {
          console.log('⚠️ ВЕБХУК: Заказ не найден в маппингах');
          
          try {
            const docId = PaymentId || `unknown_${Date.now()}`;
            
            await db.collection('pendingWebhooks')
              .doc(docId.toString())
              .set({
                webhookData: webhookData,
                receivedAt: admin.firestore.FieldValue.serverTimestamp(),
                processed: false,
                orderId: OrderId,
                paymentId: PaymentId
              });
            
            console.log(`✅ ВЕБХУК: Вебхук сохранен для ручной обработки (ID: ${docId})`);
            
            if (PaymentId) {
              console.log(`🔍 Пытаемся найти заказ по PaymentId: ${PaymentId} напрямую...`);
              
              const userId = '272401691';
              const ordersRef = db.collection('telegramUsers')
                .doc(userId)
                .collection('orders');
              
              const querySnapshot = await ordersRef
                .where('paymentId', '==', PaymentId)
                .limit(1)
                .get();
              
              if (!querySnapshot.empty) {
                const orderDoc = querySnapshot.docs[0];
                console.log(`✅ Найден заказ напрямую: ${orderDoc.id}`);
                
                const rebillId = await updatePaymentFromWebhook(
                  userId,
                  orderDoc.id,
                  webhookData
                );
                
                if (rebillId) {
                  await saveOrderMapping(OrderId, userId, orderDoc.id);
                  await saveUserSubscription(userId, webhookData, rebillId);
                }
              } else {
                console.log('⚠️ Заказ не найден даже по прямому поиску');
              }
            }
          } catch (saveError) {
            console.error('❌ ВЕБХУК: Ошибка сохранения:', saveError.message);
          }
        }
        
        console.log('✅ ВЕБХУК: Обработка завершена');
      } catch (asyncError) {
        console.error('❌ ВЕБХУК: Ошибка асинхронной обработки:', asyncError.message);
      }
    }, 100);
  } catch (error) {
    console.error('❌ ВЕБХУК: Критическая ошибка:', error.message);
    res.status(200).json({ Success: false, Error: error.message });
  }
});

// Промежуточный middleware для tbank
app.use((req, res, next) => {
  req.tbank = tbank;
  req.db = db;
  req.admin = admin;
  next();
});

// ========== НОВЫЕ ЭНДПОИНТЫ ДЛЯ УПРАВЛЕНИЯ ПОДПИСКАМИ ==========

/**
 * Получить информацию о подписке пользователя
 */
app.get('/api/subscription/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const subscriptionsRef = db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions');
    
    const snapshot = await subscriptionsRef
      .where('status', '==', 'active')
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      return res.json({
        success: false,
        hasActiveSubscription: false,
        message: 'Активная подписка не найдена'
      });
    }
    
    const subscription = snapshot.docs[0].data();
    const subscriptionId = snapshot.docs[0].id;
    
    // Проверяем запланированный платеж
    const jobId = `sub_${userId}_${subscriptionId}`;
    const hasScheduledJob = scheduledJobs.has(jobId);
    
    res.json({
      success: true,
      hasActiveSubscription: true,
      subscription: {
        ...subscription,
        id: subscriptionId,
        hasScheduledPayment: hasScheduledJob,
        nextPaymentDate: subscription.nextPaymentDate
      }
    });
  } catch (error) {
    console.error('❌ Ошибка получения подписки:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Отменить подписку пользователя
 */
app.post('/api/subscription/cancel', async (req, res) => {
  try {
    const { userId, subscriptionId } = req.body;
    
    if (!userId || !subscriptionId) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать userId и subscriptionId'
      });
    }
    
    const success = await cancelUserSubscription(userId, subscriptionId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Подписка успешно отменена',
        cancelledAt: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Не удалось отменить подписку'
      });
    }
  } catch (error) {
    console.error('❌ Ошибка отмены подписки:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Выполнить досрочное списание (например, для тестирования)
 */
app.post('/api/subscription/charge-now', async (req, res) => {
  try {
    const { userId, subscriptionId } = req.body;
    
    if (!userId || !subscriptionId) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать userId и subscriptionId'
      });
    }
    
    const subscriptionRef = db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions')
      .doc(subscriptionId);
    
    const subscriptionDoc = await subscriptionRef.get();
    
    if (!subscriptionDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Подписка не найдена'
      });
    }
    
    const subscriptionData = subscriptionDoc.data();
    
    if (subscriptionData.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: 'Подписка не активна'
      });
    }
    
    if (!subscriptionData.rebillId) {
      return res.status(400).json({
        success: false,
        error: 'Не найден rebillId для списания'
      });
    }
    
    // Выполняем списание
    const result = await executeRecurrentPayment({
      userId,
      rebillId: subscriptionData.rebillId,
      amount: subscriptionData.amount || 390,
      email: subscriptionData.email || 'user@example.com',
      description: 'Досрочное списание по подписке',
      subscriptionId
    });
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Списание выполнено успешно',
        paymentId: result.paymentId
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Не удалось выполнить списание'
      });
    }
  } catch (error) {
    console.error('❌ Ошибка досрочного списания:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Получить все активные подписки (административный эндпоинт)
 */
app.get('/api/admin/subscriptions', async (req, res) => {
  try {
    const subscriptionsSnapshot = await db.collectionGroup('subscriptions')
      .where('status', '==', 'active')
      .get();
    
    const subscriptions = [];
    const now = new Date();
    
    for (const doc of subscriptionsSnapshot.docs) {
      const data = doc.data();
      const userId = doc.ref.parent.parent.id;
      const subscriptionId = doc.id;
      
      // Проверяем, скоро ли следующий платеж
      const nextPayment = new Date(data.nextPaymentDate);
      const daysUntilPayment = Math.ceil((nextPayment - now) / (1000 * 60 * 60 * 24));
      
      subscriptions.push({
        userId,
        subscriptionId,
        ...data,
        nextPaymentDate: data.nextPaymentDate,
        daysUntilPayment: daysUntilPayment,
        hasScheduledJob: scheduledJobs.has(`sub_${userId}_${subscriptionId}`)
      });
    }
    
    res.json({
      success: true,
      count: subscriptions.length,
      scheduledJobs: scheduledJobs.size,
      subscriptions: subscriptions
    });
  } catch (error) {
    console.error('❌ Ошибка получения подписок:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== СУЩЕСТВУЮЩИЕ ЭНДПОИНТЫ ==========
app.post('/api/init-once', async (req, res) => {
  try {
    const { amount, email, phone, description, userId, orderId } = req.body;

    if (!amount || !email || !userId || !orderId) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать amount, email, userId, orderId'
      });
    }

    console.log('🚀 Инициализация разового платежа');
    console.log('userId:', userId, 'orderId:', orderId);

    const receipt = {
      Email: email,
      Phone: phone || '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: description || 'Разовая покупка',
          Price: amount * 100,
          Quantity: 1,
          Amount: amount * 100,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    const tbankOrderId = `once-${Date.now()}`;

    const payment = await req.tbank.initPayment({
      Amount: amount * 100,
      OrderId: tbankOrderId,
      Description: description || 'Разовый платеж',
      NotificationURL: process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook',
      Receipt: receipt
    });

    console.log('💳 Разовый платеж создан. PaymentId:', payment.PaymentId);

    await db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('orders2')
      .doc(orderId.toString())
      .set({
        tinkoff: {
          ...payment,
          Amount: amount * 100,
          OrderId: tbankOrderId,
          PaymentId: payment.PaymentId
        },
        status: 'INITIATED',
        amount: amount,
        paymentId: payment.PaymentId,
        orderId: orderId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    console.log(`✅ Разовый платеж сохранён в Firebase: userId=${userId}, orderId=${orderId}`);

    await saveOrderMapping(tbankOrderId, userId, orderId);

    res.json({
      success: true,
      paymentId: payment.PaymentId,
      paymentUrl: payment.PaymentURL,
      orderId: tbankOrderId,
      firebaseId: orderId,
      message: 'Перейдите по URL для оплаты. После оплаты вебхук обновит статус платежа.'
    });

  } catch (error) {
    console.error('❌ Ошибка разового платежа:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.post('/api/init-recurrent', async (req, res) => {
  try {
    const { amount, email, phone, description, userId, orderId } = req.body;
    
    if (!amount || !email) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать сумму и email'
      });
    }

    console.log('🚀 Инициализация рекуррентного платежа');
    console.log('userId:', userId, 'orderId:', orderId);

    const customerKey = `customer-${Date.now()}`;
    
    await req.tbank.addCustomer({
      CustomerKey: customerKey,
      Email: email,
      Phone: phone || '+79001234567',
    });
    console.log('✅ Клиент создан:', customerKey);

    const cardRequest = await req.tbank.addCard({
      CustomerKey: customerKey,
      CheckType: '3DS',
    });
    
    console.log('✅ Запрос на привязку карты создан. RequestKey:', cardRequest.RequestKey);
    
    const receipt = {
      Email: email,
      Phone: phone || '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: description || 'Подписка на сервис',
          Price: amount * 100,
          Quantity: 1,
          Amount: amount * 100,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    const tbankOrderId = orderId || `recurrent-order-${Date.now()}`;
    
    const payment = await req.tbank.initPayment({
      Amount: amount * 100,
      OrderId: tbankOrderId,
      Description: description || 'Первый платеж для рекуррентного списания',
      CustomerKey: customerKey,
      Recurrent: 'Y',
      NotificationURL: process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook',
      Receipt: receipt,
    });

    console.log('✅ PaymentId:', payment.PaymentId);

    let firebaseId = null;
    if (userId && orderId) {
      try {
        await db.collection('telegramUsers')
          .doc(userId.toString())
          .collection('orders')
          .doc(orderId)
          .set({
            tinkoff: {
              ...payment,
              CustomerKey: customerKey,
              RequestKey: cardRequest.RequestKey,
              Amount: amount * 100,
              OrderId: tbankOrderId,
              PaymentId: payment.PaymentId
            },
            status: 'INITIATED',
            amount: amount,
            paymentId: payment.PaymentId,
            orderId: orderId,
            customerKey: customerKey,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        
        firebaseId = orderId;
        console.log(`✅ Данные сохранены в Firebase: userId=${userId}, orderId=${orderId}`);
        
        await saveOrderMapping(tbankOrderId, userId, orderId);
      } catch (firebaseError) {
        console.error('❌ Ошибка сохранения в Firebase:', firebaseError);
      }
    }

    res.json({
      success: true,
      paymentId: payment.PaymentId,
      paymentUrl: payment.PaymentURL,
      customerKey: customerKey,
      requestKey: cardRequest.RequestKey,
      orderId: tbankOrderId,
      firebaseSaved: !!firebaseId,
      firebaseId: firebaseId,
      webhookUrl: process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook',
      message: 'Перейдите по paymentUrl для оплаты. RebillId придет на webhook.'
    });

  } catch (error) {
    console.error('❌ Ошибка инициализации:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.post('/api/run-payment', async (req, res) => {
  try {
    const { rebillId, amount, email, description, userId, orderId } = req.body;
    
    if (!rebillId || !amount || !email) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать rebillId, сумму и email'
      });
    }

    console.log('🚀 Запуск рекуррентного платежа');
    console.log('RebillId:', rebillId);
    console.log('userId:', userId, 'orderId:', orderId);

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

    const tbankOrderId = orderId || `recurrent-charge-${Date.now()}`;
    
    const newPayment = await req.tbank.initPayment({
      Amount: amount * 100,
      OrderId: tbankOrderId,
      Description: description || 'Автоматическое списание по подписке',
      Receipt: receipt,
    });

    console.log('✅ Платеж создан. PaymentId:', newPayment.PaymentId);

    const chargeResult = await req.tbank.chargeRecurrent({
      PaymentId: newPayment.PaymentId,
      RebillId: rebillId,
    });

    console.log('✅ Списание выполнено. Успех:', chargeResult.Success, 'Статус:', chargeResult.Status);

    const finalStatus = await req.tbank.getPaymentState({
      PaymentId: newPayment.PaymentId,
    });

    let firebaseId = null;
    if (userId && orderId) {
      try {
        await db.collection('telegramUsers')
          .doc(userId.toString())
          .collection('orders')
          .doc(orderId)
          .set({
            tinkoff: {
              ...finalStatus,
              ...chargeResult,
              RebillId: rebillId,
              Amount: amount * 100,
              PaymentId: newPayment.PaymentId,
              OrderId: tbankOrderId
            },
            status: finalStatus.Status,
            amount: amount,
            paymentId: newPayment.PaymentId,
            orderId: orderId,
            rebillId: rebillId,
            finishedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        
        firebaseId = orderId;
        
        await saveOrderMapping(tbankOrderId, userId, orderId);
      } catch (firebaseError) {
        console.error('❌ Ошибка сохранения в Firebase:', firebaseError);
      }
    }

    const response = {
      success: chargeResult.Success,
      paymentId: newPayment.PaymentId,
      status: finalStatus.Status,
      amount: amount,
      orderId: tbankOrderId,
      rebillId: rebillId,
      firebaseSaved: !!firebaseId,
      firebaseId: firebaseId,
      message: chargeResult.Success ? 'Платеж успешно выполнен' : 'Ошибка при выполнении платежа',
    };

    if (chargeResult.ErrorCode) {
      response.error = {
        code: chargeResult.ErrorCode,
        message: chargeResult.Message
      };
    }

    res.json(response);

  } catch (error) {
    console.error('❌ Ошибка выполнения платежа:');
    
    res.status(500).json({
      success: false,
      error: error.message || 'Unknown error',
      code: error.code,
      details: error.details || error.response?.data || null
    });
  }
});

app.post('/api/check-payment', async (req, res) => {
  try {
    const { paymentId, orderId, userId } = req.body;
    
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать paymentId'
      });
    }

    const status = await tbank.getPaymentState({
      PaymentId: paymentId
    });

    if (userId && orderId) {
      try {
        await db.collection('telegramUsers')
          .doc(userId.toString())
          .collection('orders')
          .doc(orderId)
          .update({
            'tinkoff.statusCheck': status,
            'tinkoff.Status': status.Status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        
        console.log(`✅ Статус обновлен в Firebase: paymentId=${paymentId}`);
      } catch (firebaseError) {
        console.error('❌ Ошибка обновления Firebase:', firebaseError);
      }
    }

    res.json({
      success: true,
      paymentId: paymentId,
      status: status.Status,
      rebillId: status.RebillId,
      cardId: status.CardId,
      amount: status.Amount ? status.Amount / 100 : 0,
      data: status
    });

  } catch (error) {
    console.error('❌ Ошибка проверки статуса:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Проверка работоспособности сервера
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'T-Bank Payment Server is running',
    timestamp: new Date().toISOString(),
    firebase: admin.apps.length > 0 ? 'connected' : 'not connected',
    scheduledJobs: scheduledJobs.size,
    webhookUrl: process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook'
  });
});

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`🚀 T-Bank Payment Server запущен на порту ${PORT}`);
  console.log(`🌐 Webhook URL: ${process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook'}`);
  console.log(`🔥 Firebase: ${admin.apps.length > 0 ? '✅ подключен' : '❌ не подключен'}`);
  
  // Восстанавливаем запланированные платежи при запуске
  await restoreScheduledJobs();
  console.log(`📅 Активных запланированных платежей: ${scheduledJobs.size}`);
});
