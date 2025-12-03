const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
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
  merchantId: process.env.TBANK_MERCHANT_ID || '1691507148627',
  secret: process.env.TBANK_SECRET || 'rlkzhollw74x8uvv',
  apiUrl: process.env.TBANK_API_URL || 'https://securepay.tinkoff.ru'
});

// ========== ПОМОЩНИКИ ДЛЯ FIREBASE ==========
/**
 * Ищет заказ по OrderId в специальной коллекции для быстрого поиска
 */
async function findOrderByTbankOrderId(tbankOrderId) {
  try {
    // Создаем отдельную коллекцию для быстрого поиска
    const orderRef = db.collection('orderMappings').doc(tbankOrderId);
    const orderDoc = await orderRef.get();
    
    if (orderDoc.exists) {
      const data = orderDoc.data();
      return {
        userId: data.userId,
        orderId: data.orderId,
        docRef: db.collection('telegramUsers')
          .doc(data.userId.toString())
          .collection('orders')
          .doc(data.orderId)
      };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Ошибка поиска заказа:', error);
    return null;
  }
}

/**
 * Сохраняет маппинг OrderId -> userId/orderId для быстрого поиска
 */
async function saveOrderMapping(tbankOrderId, userId, orderId) {
  try {
    await db.collection('orderMappings').doc(tbankOrderId).set({
      userId: userId,
      orderId: orderId,
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
    
    // Добавляем RebillId если есть
    if (RebillId) {
      updateData.rebillId = RebillId;
      updateData['tinkoff.RebillId'] = RebillId;
      updateData.finishedAt = admin.firestore.FieldValue.serverTimestamp();
      console.log(`🔄 RebillId получен: ${RebillId}`);
    }
    
    // Добавляем CardId если есть
    if (CardId) {
      updateData['tinkoff.CardId'] = CardId;
    }
    
    // Обновляем документ
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
    
    // Попробуем создать документ, если его нет
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
 * Сохраняет подписку пользователя
 */
async function saveUserSubscription(userId, webhookData, rebillId) {
  try {
    const { CardId, Pan } = webhookData;
    
    const subscriptionData = {
      rebillId: rebillId,
      cardLastDigits: Pan ? Pan.slice(-4) : null,
      cardId: CardId,
      status: 'active',
      lastPayment: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      webhookData: webhookData
    };
    
    await db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('subscriptions')
      .doc('active')
      .set(subscriptionData, { merge: true });
    
    console.log(`✅ Подписка сохранена для userId=${userId}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка сохранения подписки:', error);
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
    // T-Bank может отправлять данные в разных форматах
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      // Парсим raw body
      const bodyString = req.body.toString();
      console.log('📨 ВЕБХУК: Raw body:', bodyString);
      
      try {
        webhookData = JSON.parse(bodyString);
      } catch (parseError) {
        // Пробуем парсить как URL encoded
        const parsed = new URLSearchParams(bodyString);
        webhookData = {};
        for (const [key, value] of parsed.entries()) {
          webhookData[key] = value;
        }
      }
    } else {
      webhookData = req.body;
    }
    
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
    
    // Логируем важные данные
    console.log('📨 ВЕБХУК:');
    console.log(`   OrderId: ${OrderId}`);
    console.log(`   PaymentId: ${PaymentId}`);
    console.log(`   Status: ${Status}`);
    console.log(`   Success: ${Success}`);
    console.log(`   RebillId: ${RebillId || 'не указан'}`);
    console.log(`   Amount: ${Amount ? Amount / 100 : 0} руб.`);
    
    // ВАЖНО: Всегда возвращаем успех сразу
    res.status(200).json({ Success: true, Error: '0' });
    
    // Асинхронно обрабатываем вебхук
    setTimeout(async () => {
      try {
        console.log('🔄 ВЕБХУК: Начинаем обработку...');
        
        let orderInfo = null;
        
        // Пытаемся найти заказ по OrderId через маппинг
        if (OrderId) {
          orderInfo = await findOrderByTbankOrderId(OrderId);
        }
        
        if (orderInfo) {
          console.log(`✅ ВЕБХУК: Найден заказ: userId=${orderInfo.userId}, orderId=${orderInfo.orderId}`);
          
          // Обновляем данные из вебхука
          const rebillId = await updatePaymentFromWebhook(
            orderInfo.userId, 
            orderInfo.orderId, 
            webhookData
          );
          
          if (rebillId) {
            console.log(`🎉 ВЕБХУК: RebillId сохранен: ${rebillId}`);
            
            // Сохраняем подписку пользователя
            await saveUserSubscription(orderInfo.userId, webhookData, rebillId);
          }
        } else {
          console.log('⚠️ ВЕБХУК: Заказ не найден в маппингах');
          console.log('   OrderId:', OrderId);
          console.log('   PaymentId:', PaymentId);
          
          // Сохраняем для ручной обработки
          try {
            await db.collection('pendingWebhooks')
              .doc(PaymentId || `unknown_${Date.now()}`)
              .set({
                webhookData: webhookData,
                receivedAt: admin.firestore.FieldValue.serverTimestamp(),
                processed: false,
                orderId: OrderId
              });
            
            console.log('✅ ВЕБХУК: Вебхук сохранен для ручной обработки');
          } catch (saveError) {
            console.error('❌ ВЕБХУК: Ошибка сохранения:', saveError);
          }
        }
        
        console.log('✅ ВЕБХУК: Обработка завершена');
        
      } catch (asyncError) {
        console.error('❌ ВЕБХУК: Ошибка асинхронной обработки:', asyncError.message);
        console.error('❌ ВЕБХУК: Stack:', asyncError.stack);
      }
    }, 100); // Небольшая задержка для гарантии ответа T-Bank
    
  } catch (error) {
    console.error('❌ ВЕБХУК: Критическая ошибка:', error.message);
    // Все равно возвращаем 200 OK для T-Bank
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

// Эндпоинт для инициализации рекуррентного платежа
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
    
    // Создаем клиента
    await req.tbank.addCustomer({
      CustomerKey: customerKey,
      Email: email,
      Phone: phone || '+79001234567',
    });
    console.log('✅ Клиент создан:', customerKey);

    // Инициализируем привязку карты
    const cardRequest = await req.tbank.addCard({
      CustomerKey: customerKey,
      CheckType: '3DS',
    });
    
    console.log('✅ Запрос на привязку карты создан. RequestKey:', cardRequest.RequestKey);
    
    // Создаем чек
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
    
    // Первый платеж
    const payment = await req.tbank.initPayment({
      Amount: amount * 100,
      OrderId: tbankOrderId,
      Description: description || 'Первый платеж для рекуррентного списания',
      CustomerKey: customerKey,
      Recurrent: 'Y',
      NotificationURL: process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook',
      SuccessURL: process.env.SUCCESS_URL || 'https://astro-1-nns5.onrender.com/success',
      FailURL: process.env.FAIL_URL || 'https://astro-1-nns5.onrender.com/fail',
      Receipt: receipt,
    });

    console.log('✅ PaymentId:', payment.PaymentId);

    // Сохраняем в Firebase
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
        
        // Сохраняем маппинг для быстрого поиска вебхуком
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
    if (error.response) console.error('Детали:', error.response.data);
    
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

// Эндпоинт для выполнения рекуррентного платежа
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

    const tbankOrderId = orderId || `recurrent-charge-${Date.now()}`;
    
    // Создаем новый платеж
    const newPayment = await req.tbank.initPayment({
      Amount: amount * 100,
      OrderId: tbankOrderId,
      Description: description || 'Автоматическое списание по подписке',
      Receipt: receipt,
    });

    console.log('✅ Платеж создан. PaymentId:', newPayment.PaymentId);

    // Проводим списание
    const chargeResult = await req.tbank.chargeRecurrent({
      PaymentId: newPayment.PaymentId,
      RebillId: rebillId,
    });

    console.log('✅ Списание выполнено. Успех:', chargeResult.Success, 'Статус:', chargeResult.Status);

    // Проверяем итоговый статус
    const finalStatus = await req.tbank.getPaymentState({
      PaymentId: newPayment.PaymentId,
    });

    // Сохраняем в Firebase
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
        
        // Сохраняем маппинг для этого платежа тоже
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
    
    if (error.code) console.log('Код ошибки:', error.code);
    if (error.message) console.log('Сообщение:', error.message);
    if (error.details) console.log('Детали:', error.details);

    res.status(500).json({
      success: false,
      error: error.message || 'Unknown error',
      code: error.code,
      details: error.details || error.response?.data || null
    });
  }
});

// Эндпоинт для ручной привязки вебхука к заказу
app.post('/api/link-webhook', async (req, res) => {
  try {
    const { tbankOrderId, userId, orderId } = req.body;
    
    if (!tbankOrderId || !userId || !orderId) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать tbankOrderId, userId и orderId'
      });
    }

    await saveOrderMapping(tbankOrderId, userId, orderId);
    
    res.json({
      success: true,
      message: `Маппинг создан: ${tbankOrderId} -> ${userId}/${orderId}`
    });
    
  } catch (error) {
    console.error('❌ Ошибка создания маппинга:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Эндпоинт для проверки статуса платежа
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

    let firebaseData = null;
    
    // Если есть userId и orderId, обновляем Firebase
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
      updated: !!firebaseData,
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
    webhookUrl: process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook'
  });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 T-Bank Payment Server запущен на порту ${PORT}`);
  console.log(`🌐 Webhook URL: ${process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook'}`);
  console.log(`🔥 Firebase: ${admin.apps.length > 0 ? '✅ подключен' : '❌ не подключен'}`);
});
