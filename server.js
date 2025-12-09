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


// ========== СУЩЕСТВУЮЩИЕ ЭНДПОИНТЫ ==========
app.post('/api/init-once', async (req, res) => {
  try {
    const { amount, email, phone, description, userId, orderId, productId, productType, productTitle } = req.body;
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
    console.log('📦 Product data:', { productId, productType, productTitle });

    // Создаем описание с информацией о товаре
    const productDescription = productTitle 
      ? `Разовый платеж: ${productTitle}`
      : (description || 'Разовая покупка');

    const receipt = {
      Email: email,
      Phone: phone || '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: productDescription,
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
      Description: productDescription,
      NotificationURL: process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook',
      Receipt: receipt
    });

    console.log('💳 Разовый платеж создан. PaymentId:', payment.PaymentId);

    // Подготовка данных для сохранения
    const orderData = {
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
      productId: productId || null,
      productType: productType || 'forecast',
      productTitle: productTitle || productDescription,
      description: productDescription,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Сохраняем данные о заказе
    await db.collection('telegramUsers')
      .doc(userId.toString())
      .collection('orders2')
      .doc(orderId.toString())
      .set(orderData);

    console.log(`✅ Разовый платеж сохранён в Firebase: userId=${userId}, orderId=${orderId}`);
    console.log(`📦 Product info saved: productId=${productId}, type=${productType}`);

    // Также обновляем основной документ пользователя
    await db.collection('telegramUsers')
      .doc(userId.toString())
      .update({
        'purchase.productId': productId || null,
        'purchase.productTitle': productTitle || productDescription,
        'purchase.productType': productType || 'forecast',
        'updatedAt': admin.firestore.FieldValue.serverTimestamp()
      });

    await saveOrderMapping(tbankOrderId, userId, orderId);

    res.json({
      success: true,
      paymentId: payment.PaymentId,
      paymentUrl: payment.PaymentURL,
      orderId: tbankOrderId,
      firebaseId: orderId,
      productId: productId,
      productType: productType,
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


// Запуск сервера
app.listen(PORT, async () => {
  console.log(`🚀 T-Bank Payment Server запущен на порту ${PORT}`);
  console.log(`🌐 Webhook URL: ${process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook'}`);
  console.log(`🔥 Firebase: ${firebaseService.getAdmin().apps.length > 0 ? '✅ подключен' : '❌ не подключен'}`);
  
  // Восстанавливаем запланированные платежи при запуске
  await restoreScheduledJobs();
  console.log(`📅 Активных запланированных платежей: ${scheduledJobs.size}`);
});
