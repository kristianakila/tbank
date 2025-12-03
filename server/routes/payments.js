const express = require('express');
const router = express.Router();
const TbankPayments = require('tbank-payments');
const config = require('../config');

// Инициализация клиента T-Bank
const tbank = new TbankPayments({
  apiKey: config.tbank.apiKey,
  terminalKey: config.tbank.terminalKey,
  secretKey: config.tbank.secretKey,
  apiUrl: config.tbank.apiUrl,
  isTest: process.env.NODE_ENV !== 'production',
});

// Валидация входящих данных
const validateRequest = (schema) => (req, res, next) => {
  try {
    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Ошибка валидации',
        details: error.details.map(d => d.message),
      });
    }
    req.validatedData = value;
    next();
  } catch (err) {
    next(err);
  }
};

// 1. Инициализация платежа
router.post('/init', async (req, res, next) => {
  try {
    const { 
      amount, 
      orderId, 
      description, 
      customerKey,
      successURL,
      failURL,
      notificationURL,
      data
    } = req.body;

    const payment = await tbank.initPayment({
      Amount: amount * 100, // Конвертируем в копейки
      OrderId: orderId,
      Description: description,
      CustomerKey: customerKey,
      SuccessURL: successURL,
      FailURL: failURL,
      NotificationURL: notificationURL || `${req.protocol}://${req.get('host')}/api/payments/notification`,
      Data: data,
    });

    res.json({
      success: true,
      data: payment,
    });
  } catch (error) {
    next(error);
  }
});

// 2. Получение статуса платежа
router.get('/status/:paymentId', async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const status = await tbank.getPaymentStatus({
      PaymentId: paymentId,
    });

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
});

// 3. Возврат платежа
router.post('/refund', async (req, res, next) => {
  try {
    const { paymentId, amount, reason } = req.body;
    
    const refund = await tbank.refundPayment({
      PaymentId: paymentId,
      Amount: amount * 100, // Конвертируем в копейки
      Reason: reason,
    });

    res.json({
      success: true,
      data: refund,
    });
  } catch (error) {
    next(error);
  }
});

// 4. СБП платеж
router.post('/sbp', async (req, res, next) => {
  try {
    const { 
      amount, 
      orderId, 
      description, 
      phone,
      successURL,
      failURL
    } = req.body;

    const sbpPayment = await tbank.sbp.initPayment({
      amount: amount * 100,
      orderId,
      description,
      phone,
      successUrl: successURL,
      failUrl: failURL,
    });

    res.json({
      success: true,
      data: sbpPayment,
    });
  } catch (error) {
    next(error);
  }
});

// 5. Получение QR-кода
router.post('/qr', async (req, res, next) => {
  try {
    const { 
      amount, 
      orderId, 
      description,
      data,
      qrType = 'QRStatic'
    } = req.body;

    const qrData = await tbank.qr.create({
      Amount: amount * 100,
      OrderId: orderId,
      Description: description,
      Data: data,
      QrType: qrType,
    });

    res.json({
      success: true,
      data: qrData,
    });
  } catch (error) {
    next(error);
  }
});

// 6. Уведомления от T-Bank (webhook)
router.post('/notification', async (req, res, next) => {
  try {
    const notification = req.body;
    
    // Валидация подписи (если необходимо)
    // const isValid = tbank.verifyNotification(notification);
    
    // Обработка уведомления
    console.log('Получено уведомление:', notification);
    
    // Здесь можно обновить статус заказа в вашей БД
    // await updateOrderStatus(notification.OrderId, notification.Status);
    
    // Всегда возвращаем успех, иначе T-Bank будет повторять отправку
    res.status(200).send('OK');
  } catch (error) {
    console.error('Ошибка обработки уведомления:', error);
    res.status(200).send('OK'); // Все равно OK, чтобы не было повторных отправок
  }
});

// 7. Получение списка платежей
router.get('/list', async (req, res, next) => {
  try {
    const { from, to, limit = 10 } = req.query;
    
    const payments = await tbank.getPaymentsList({
      From: from,
      To: to,
      Limit: parseInt(limit),
    });

    res.json({
      success: true,
      data: payments,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
