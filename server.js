const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

// Инициализация Firebase
require('./config/firebase');

// Импорт сервисов
const schedulerService = require('./services/schedulerService');
const firebaseService = require('./services/firebaseService');
const tbankService = require('./services/tbankService');
const webhookService = require('./services/webhookService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Получаем инстансы сервисов
const tbank = tbankService.getTbankInstance();
const db = firebaseService.getDatabase();
const admin = firebaseService.getAdmin();
const { scheduledJobs, scheduleSubscriptionPayment, executeRecurrentPayment, restoreScheduledJobs } = schedulerService;
const { saveUserSubscription, cancelUserSubscription, findOrderByTbankOrderId, saveOrderMapping, updatePaymentFromWebhook } = firebaseService;

const PurchaseService = require('./services/purchaseService');
const Product = require('./models/Product');

// ========== ЭНДПОИНТЫ ДЛЯ ПОКУПКИ ТОВАРОВ ==========

/**
 * Получить список товаров
 */
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.getAllProducts();
    res.json({
      success: true,
      products
    });
  } catch (error) {
    console.error('❌ Ошибка получения товаров:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Получить информацию о товаре
 */
app.get('/api/products/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const product = await Product.getProductById(productId);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Товар не найден'
      });
    }
    
    res.json({
      success: true,
      product
    });
  } catch (error) {
    console.error('❌ Ошибка получения товара:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Инициализировать покупку товара
 */
app.post('/api/products/purchase', async (req, res) => {
  try {
    const { userId, productId, email, phone, description } = req.body;
    
    if (!userId || !productId || !email) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать userId, productId и email'
      });
    }
    
    const result = await PurchaseService.initProductPurchase({
      userId,
      productId,
      email,
      phone,
      description
    });
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Ошибка инициализации покупки:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Получить покупки пользователя
 */
app.get('/api/users/:userId/purchases', async (req, res) => {
  try {
    const { userId } = req.params;
    const purchases = await PurchaseService.getUserPurchases(userId);
    
    res.json({
      success: true,
      purchases
    });
  } catch (error) {
    console.error('❌ Ошибка получения покупок:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Получить купленные товары пользователя
 */
app.get('/api/users/:userId/purchased-products', async (req, res) => {
  try {
    const { userId } = req.params;
    const products = await PurchaseService.getUserPurchasedProducts(userId);
    
    res.json({
      success: true,
      products
    });
  } catch (error) {
    console.error('❌ Ошибка получения купленных товаров:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Проверить, купил ли пользователь товар
 */
app.get('/api/users/:userId/has-purchased/:productId', async (req, res) => {
  try {
    const { userId, productId } = req.params;
    const hasPurchased = await PurchaseService.hasUserPurchasedProduct(userId, productId);
    
    res.json({
      success: true,
      hasPurchased,
      productId
    });
  } catch (error) {
    console.error('❌ Ошибка проверки покупки:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Увеличить счетчик скачиваний
 */
app.post('/api/users/:userId/download/:productId', async (req, res) => {
  try {
    const { userId, productId } = req.params;
    
    const newCount = await PurchaseService.incrementDownloadCount(userId, productId);
    
    res.json({
      success: true,
      downloadCount: newCount,
      productId
    });
  } catch (error) {
    console.error('❌ Ошибка увеличения счетчика скачиваний:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Получить статистику пользователя
 */
app.get('/api/users/:userId/stats', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = req.db;
    
    const userRef = db.collection('telegramUsers').doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Пользователь не найден'
      });
    }
    
    const userData = userDoc.data();
    
    // Получаем количество покупок
    const purchasesRef = db.collection('telegramUsers')
      .doc(userId)
      .collection('purchases');
    const purchasesSnapshot = await purchasesRef.get();
    
    // Получаем купленные товары
    const purchasedProductsRef = db.collection('telegramUsers')
      .doc(userId)
      .collection('purchasedProducts');
    const productsSnapshot = await purchasedProductsRef.get();
    
    const stats = {
      totalSpent: userData.totalSpent || 0,
      totalPurchases: purchasesSnapshot.size,
      totalProducts: productsSnapshot.size,
      lastPurchaseDate: userData.lastPurchaseDate || null,
      createdAt: userData.createdAt || null
    };
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('❌ Ошибка получения статистики:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Обновляем существующий эндпоинт для проверки статуса платежа
app.post('/api/check-payment', async (req, res) => {
  try {
    const { paymentId, orderId, userId } = req.body;
    const tbank = req.tbank;
    const db = req.db;
    
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
        // Проверяем тип заказа
        const orderDoc = await db.collection('orders').doc(orderId).get();
        const orderData = orderDoc.exists ? orderDoc.data() : null;
        
        if (orderData && orderData.type === 'product_purchase') {
          // Обновляем заказ товара
          await db.collection('orders').doc(orderId).update({
            'tinkoff.statusCheck': status,
            'tinkoff.Status': status.Status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // Обновляем в профиле пользователя
          await db.collection('telegramUsers')
            .doc(userId.toString())
            .collection('purchases')
            .doc(orderId)
            .update({
              status: status.Status,
              success: status.Success,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              ...(status.Success && { delivered: true, purchasedAt: new Date().toISOString() })
            });
        } else {
          // Старая логика для обратной совместимости
          await db.collection('telegramUsers')
            .doc(userId.toString())
            .collection('orders')
            .doc(orderId)
            .update({
              'tinkoff.statusCheck': status,
              'tinkoff.Status': status.Status,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
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

// ========== ЭНДПОИНТЫ ==========

// Middleware для передачи зависимостей
app.use((req, res, next) => {
  req.tbank = tbank;
  req.db = db;
  req.admin = admin;
  req.scheduler = {
    scheduledJobs,
    scheduleSubscriptionPayment,
    executeRecurrentPayment
  };
  req.firebaseService = {
    saveUserSubscription,
    cancelUserSubscription,
    findOrderByTbankOrderId,
    saveOrderMapping,
    updatePaymentFromWebhook
  };
  next();
});

// ВАЖНО: Для вебхука от T-Bank парсим raw body
app.use('/api/webhook', bodyParser.raw({ type: '*/*' }));

// Эндпоинт для вебхуков от T-Bank
app.post('/api/webhook', async (req, res) => {
  await webhookService.handleWebhook(req, res, {
    db,
    scheduledJobs,
    findOrderByTbankOrderId,
    saveOrderMapping,
    updatePaymentFromWebhook,
    saveUserSubscription,
    cancelUserSubscription
  });
});

// ========== ЭНДПОИНТЫ ДЛЯ УПРАВЛЕНИЯ ПОДПИСКАМИ ==========

/**
 * Получить информацию о подписке пользователя
 */
app.get('/api/subscription/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = req.db;
    const scheduledJobs = req.scheduler.scheduledJobs;
    
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
    
    const success = await req.firebaseService.cancelUserSubscription(userId, subscriptionId);
    
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
    
    const db = req.db;
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
    const result = await req.scheduler.executeRecurrentPayment({
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
    const db = req.db;
    const scheduledJobs = req.scheduler.scheduledJobs;
    
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
    const tbank = req.tbank;
    const db = req.db;
    const admin = req.admin;
    const saveOrderMapping = req.firebaseService.saveOrderMapping;

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

    const payment = await tbank.initPayment({
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
    const tbank = req.tbank;
    const db = req.db;
    const admin = req.admin;
    const saveOrderMapping = req.firebaseService.saveOrderMapping;
    
    if (!amount || !email) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать сумму и email'
      });
    }

    console.log('🚀 Инициализация рекуррентного платежа');
    console.log('userId:', userId, 'orderId:', orderId);

    const customerKey = `customer-${Date.now()}`;
    
    await tbank.addCustomer({
      CustomerKey: customerKey,
      Email: email,
      Phone: phone || '+79001234567',
    });
    console.log('✅ Клиент создан:', customerKey);

    const cardRequest = await tbank.addCard({
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
    
    const payment = await tbank.initPayment({
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
    const tbank = req.tbank;
    const db = req.db;
    const admin = req.admin;
    const saveOrderMapping = req.firebaseService.saveOrderMapping;
    
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
    
    const newPayment = await tbank.initPayment({
      Amount: amount * 100,
      OrderId: tbankOrderId,
      Description: description || 'Автоматическое списание по подписке',
      Receipt: receipt,
    });

    console.log('✅ Платеж создан. PaymentId:', newPayment.PaymentId);

    const chargeResult = await tbank.chargeRecurrent({
      PaymentId: newPayment.PaymentId,
      RebillId: rebillId,
    });

    console.log('✅ Списание выполнено. Успех:', chargeResult.Success, 'Статус:', chargeResult.Status);

    const finalStatus = await tbank.getPaymentState({
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
    const tbank = req.tbank;
    const db = req.db;
    const admin = req.admin;
    
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
  const admin = firebaseService.getAdmin();
  const scheduledJobs = schedulerService.scheduledJobs;
  
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
  console.log(`🔥 Firebase: ${firebaseService.getAdmin().apps.length > 0 ? '✅ подключен' : '❌ не подключен'}`);
  
  // Восстанавливаем запланированные платежи при запуске
  await restoreScheduledJobs();
  console.log(`📅 Активных запланированных платежей: ${scheduledJobs.size}`);
});
