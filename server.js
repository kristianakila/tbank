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
  // Инициализация Firebase
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

// Промежуточный middleware для tbank
app.use((req, res, next) => {
  req.tbank = tbank;
  req.db = db; // Добавляем Firestore в запрос
  req.admin = admin; // Добавляем admin в запрос
  next();
});

// ========== ПОМОЩНИКИ ДЛЯ FIREBASE ==========
/**
 * Сохраняет платеж в Firebase
 * @param {string} userId - ID пользователя Telegram
 * @param {string} orderId - ID заказа
 * @param {object} tinkoffData - Данные от T-Bank
 * @param {string} rebillId - RebillId (если есть)
 */
async function savePaymentToFirebase(userId, orderId, tinkoffData, rebillId = null) {
  try {
    if (!userId || !orderId) {
      console.warn('⚠️ Не указаны userId или orderId для сохранения в Firebase');
      return null;
    }

    const paymentData = {
      tinkoff: tinkoffData,
      status: tinkoffData.Status || 'INITIATED',
      amount: tinkoffData.Amount ? tinkoffData.Amount / 100 : 0,
      paymentId: tinkoffData.PaymentId,
      orderId: tinkoffData.OrderId || orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Добавляем rebillId если есть
    if (rebillId) {
      paymentData.rebillId = rebillId;
      paymentData.finishedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    // Сохраняем в Firestore
    const docRef = db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('orders')
      .doc(orderId);

    await docRef.set(paymentData, { merge: true });
    
    console.log(`✅ Платеж сохранен в Firebase: userId=${userId}, orderId=${orderId}`);
    return docRef.id;
  } catch (error) {
    console.error('❌ Ошибка сохранения в Firebase:', error.message);
    return null;
  }
}

/**
 * Обновляет статус платежа в Firebase
 */
async function updatePaymentStatus(userId, orderId, status, tinkoffData = {}) {
  try {
    const updateData = {
      status: status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...tinkoffData
    };

    await db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('orders')
      .doc(orderId)
      .update(updateData);

    console.log(`✅ Статус обновлен: userId=${userId}, orderId=${orderId}, status=${status}`);
  } catch (error) {
    console.error('❌ Ошибка обновления статуса:', error.message);
  }
}
// =============================================

// Эндпоинт для инициализации рекуррентного платежа
app.post('/api/init-recurrent', async (req, res) => {
  try {
    const { amount, email, phone, description, userId, orderId } = req.body;
    
    // Проверяем обязательные поля
    if (!amount || !email) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать сумму и email'
      });
    }

    console.log('🚀 Инициализация рекуррентного платежа');
    console.log('userId:', userId, 'orderId:', orderId);

    // Создаём уникального клиента
    const customerKey = `customer-${Date.now()}`;
    
    // Создаем клиента
    await req.tbank.addCustomer({
      CustomerKey: customerKey,
      Email: email,
      Phone: phone || '+79001234567',
    });
    console.log('Клиент создан:', customerKey);

    // Инициализируем привязку карты (3DS)
    const cardRequest = await req.tbank.addCard({
      CustomerKey: customerKey,
      CheckType: '3DS', // собираем 3DS
    });
    
    console.log('Запрос на привязку карты создан. RequestKey:', cardRequest.RequestKey);
    
    // Создаем чек для платежа
    const receipt = {
      Email: email,
      Phone: phone || '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: description || 'Подписка на сервис',
          Price: amount * 100, // Конвертируем в копейки
          Quantity: 1,
          Amount: amount * 100,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // Генерируем уникальный OrderId
    const tbankOrderId = orderId || `recurrent-order-${Date.now()}`;
    
    // Первый платеж по привязанной карте
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

    console.log('✅ PaymentId для первого платежа:', payment.PaymentId);

    // Сохраняем в Firebase если есть userId и orderId
    let firebaseId = null;
    if (userId && orderId) {
      firebaseId = await savePaymentToFirebase(
        userId, 
        orderId, 
        {
          ...payment,
          CustomerKey: customerKey,
          RequestKey: cardRequest.RequestKey,
          Amount: amount * 100
        }
      );
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
      message: 'Для завершения привязки карты перейдите по paymentUrl'
    });

  } catch (error) {
    console.error('❌ Ошибка инициализации рекуррентного платежа:', error.message);
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
    
    // Проверяем обязательные поля
    if (!rebillId || !amount || !email) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать rebillId, сумму и email'
      });
    }

    console.log('🚀 ЗАПУСК ПОВТОРНОГО СПИСАНИЯ');
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

    // Генерируем новый orderId для T-Bank
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

    // Сохраняем в Firebase если есть userId и orderId
    let firebaseId = null;
    if (userId && orderId) {
      firebaseId = await savePaymentToFirebase(
        userId, 
        orderId, 
        {
          ...finalStatus,
          ...chargeResult,
          RebillId: rebillId,
          Amount: amount * 100
        },
        rebillId // Передаем rebillId для обновления
      );
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

    // Добавляем ошибку если есть
    if (chargeResult.ErrorCode) {
      response.error = {
        code: chargeResult.ErrorCode,
        message: chargeResult.Message
      };
    }

    res.json(response);

  } catch (error) {
    console.error('❌ Ошибка выполнения рекуррентного платежа:');
    
    // Подробный анализ ошибки
    if (error.code) {
      console.log('Код ошибки:', error.code);
    }
    
    if (error.message) {
      console.log('Сообщение:', error.message);
    }
    
    if (error.details) {
      console.log('Детали:', error.details);
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Unknown error',
      code: error.code,
      details: error.details || error.response?.data || null
    });
  }
});

// Эндпоинт для вебхуков (уведомлений от T-Bank)
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('📨 Получен вебхук от T-Bank:', JSON.stringify(req.body, null, 2));
    
    const { PaymentId, OrderId, Status, Success, RebillId, Amount } = req.body;
    
    // Всегда возвращаем OK сразу, чтобы T-Bank не считал доставку неудачной
    res.json({ success: true, message: 'Webhook received' });
    
    // Асинхронно обрабатываем вебхук
    setTimeout(async () => {
      try {
        console.log('🔄 Обработка вебхука асинхронно...');
        
        // Здесь вы можете найти userId по OrderId из вашей БД
        // Пример: ищем заказ в Firestore по OrderId
        // Это зависит от вашей структуры данных
        
        // ВАЖНО: Вам нужно реализовать логику поиска userId по OrderId
        // Примерная логика:
        /*
        const ordersQuery = await db.collectionGroup('orders')
          .where('tinkoff.OrderId', '==', OrderId)
          .limit(1)
          .get();
        
        if (!ordersQuery.empty) {
          const orderDoc = ordersQuery.docs[0];
          const userId = orderDoc.ref.parent.parent.id;
          const orderId = orderDoc.id;
          
          // Обновляем статус в Firebase
          await updatePaymentStatus(userId, orderId, Status, {
            ...req.body,
            finishedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        */
        
        console.log('✅ Вебхук обработан');
        
      } catch (asyncError) {
        console.error('❌ Ошибка асинхронной обработки вебхука:', asyncError.message);
      }
    }, 0);

  } catch (error) {
    console.error('Ошибка обработки вебхука:', error);
    // Все равно возвращаем 200 OK для T-Bank
    res.json({ success: false, error: error.message });
  }
});

// Новый эндпоинт для сохранения платежа в Firebase
app.post('/api/save-payment', async (req, res) => {
  try {
    const { userId, orderId, paymentData, rebillId } = req.body;
    
    if (!userId || !orderId || !paymentData) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать userId, orderId и paymentData'
      });
    }

    const firebaseId = await savePaymentToFirebase(userId, orderId, paymentData, rebillId);
    
    res.json({
      success: true,
      firebaseId: firebaseId,
      message: 'Платеж сохранен в Firebase'
    });
    
  } catch (error) {
    console.error('❌ Ошибка сохранения платежа:', error);
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
    firebase: admin.apps.length > 0 ? 'connected' : 'not connected'
  });
});

// Главная страница
app.get('/', (req, res) => {
  res.json({
    message: 'T-Bank Payment Server API with Firebase',
    version: '1.1.0',
    endpoints: [
      'POST /api/init-recurrent - Инициализация рекуррентного платежа',
      'POST /api/run-payment - Выполнение рекуррентного платежа',
      'POST /api/webhook - Вебхук для уведомлений от T-Bank',
      'POST /api/save-payment - Сохранить платеж в Firebase',
      'GET /health - Проверка работоспособности'
    ]
  });
});

// Обработка ошибок 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path
  });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 T-Bank Payment Server запущен на порту ${PORT}`);
  console.log(`🌐 Доступен по адресу: http://localhost:${PORT}`);
  console.log(`🔧 Режим: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase: ${admin.apps.length > 0 ? '✅ подключен' : '❌ не подключен'}`);
});
