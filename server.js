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
  next();
});

// Эндпоинт для инициализации рекуррентного платежа
app.post('/api/init-recurrent', async (req, res) => {
  try {
    const { amount, email, phone, description } = req.body;
    
    // Проверяем обязательные поля
    if (!amount || !email) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать сумму и email'
      });
    }

    console.log('🚀 Инициализация рекуррентного платежа');

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

    // Первый платеж по привязанной карте
    const payment = await req.tbank.initPayment({
      Amount: amount * 100,
      OrderId: `recurrent-order-${Date.now()}`,
      Description: description || 'Первый платеж для рекуррентного списания',
      CustomerKey: customerKey,
      Recurrent: 'Y',
      NotificationURL: process.env.NOTIFICATION_URL || 'https://astro-1-nns5.onrender.com/api/webhook',
      SuccessURL: process.env.SUCCESS_URL || 'https://astro-1-nns5.onrender.com/success',
      FailURL: process.env.FAIL_URL || 'https://astro-1-nns5.onrender.com/fail',
      Receipt: receipt,
    });

    console.log('PaymentId для первого платежа:', payment.PaymentId);

    res.json({
      success: true,
      paymentId: payment.PaymentId,
      paymentUrl: payment.PaymentURL,
      customerKey: customerKey,
      requestKey: cardRequest.RequestKey,
      message: 'Для завершения привязки карты перейдите по paymentUrl'
    });

  } catch (error) {
    console.error('Ошибка инициализации рекуррентного платежа:', error.message);
    if (error.response) console.error(error.response.data);
    
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
    const { rebillId, amount, email, description } = req.body;
    
    // Проверяем обязательные поля
    if (!rebillId || !amount || !email) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать rebillId, сумму и email'
      });
    }

    console.log('🚀 ЗАПУСК ПОВТОРНОГО СПИСАНИЯ');
    console.log('RebillId:', rebillId);
    console.log('Сумма:', amount);

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
    const newPayment = await req.tbank.initPayment({
      Amount: amount * 100,
      OrderId: 'recurrent-' + Date.now(),
      Description: description || 'Автоматическое списание по подписке',
      Receipt: receipt,
    });

    console.log('✅ Платеж создан:');
    console.log('ID платежа:', newPayment.PaymentId);

    // Проводим списание
    const chargeResult = await req.tbank.chargeRecurrent({
      PaymentId: newPayment.PaymentId,
      RebillId: rebillId,
    });

    console.log('✅ Списание выполнено:');
    console.log('Успех:', chargeResult.Success);
    console.log('Статус:', chargeResult.Status);

    // Проверяем итоговый статус
    const finalStatus = await req.tbank.getPaymentState({
      PaymentId: newPayment.PaymentId,
    });

    res.json({
      success: chargeResult.Success,
      paymentId: newPayment.PaymentId,
      status: finalStatus.Status,
      amount: amount,
      orderId: newPayment.OrderId,
      message: chargeResult.Success ? 'Платеж успешно выполнен' : 'Ошибка при выполнении платежа',
      error: chargeResult.ErrorCode ? {
        code: chargeResult.ErrorCode,
        message: chargeResult.Message
      } : null
    });

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
    console.log('📨 Получен вебхук от T-Bank:', req.body);
    
    // Здесь можно обработать уведомление
    // Например, обновить статус платежа в БД
    
    // Важно: всегда возвращаем OK
    res.json({ success: true, message: 'Webhook received' });
  } catch (error) {
    console.error('Ошибка обработки вебхука:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Проверка работоспособности сервера
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'T-Bank Payment Server is running',
    timestamp: new Date().toISOString()
  });
});

// Главная страница
app.get('/', (req, res) => {
  res.json({
    message: 'T-Bank Payment Server API',
    version: '1.0.0',
    endpoints: [
      'POST /api/init-recurrent - Инициализация рекуррентного платежа',
      'POST /api/run-payment - Выполнение рекуррентного платежа',
      'POST /api/webhook - Вебхук для уведомлений от T-Bank',
      'GET /health - Проверка работоспособности'
    ],
    usage: {
      initRecurrent: {
        method: 'POST',
        url: '/api/init-recurrent',
        body: {
          amount: 100, // сумма в рублях
          email: 'customer@example.com',
          phone: '+79001234567',
          description: 'Оплата подписки'
        }
      },
      runPayment: {
        method: 'POST',
        url: '/api/run-payment',
        body: {
          rebillId: '1802979056', // ваш rebillId
          amount: 100,
          email: 'customer@example.com',
          description: 'Автоматическое списание'
        }
      }
    }
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
});
