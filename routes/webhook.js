const express = require('express');
const router = express.Router();

const { updatePaymentFromWebhook } = require('../helpers/orders');
const { findOrderByTbankOrderId, saveOrderMapping } = require('../helpers/mapping');
const { saveUserSubscription } = require('../helpers/subscriptions');

router.post('/', async (req, res) => {
  console.log('📨 ВЕБХУК: Получен запрос от T-Bank');

  let webhookData;

  try {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      const bodyString = req.body.toString();
      try {
        webhookData = JSON.parse(bodyString);
      } catch {
        const parsed = new URLSearchParams(bodyString);
        webhookData = {};
        for (const [k, v] of parsed.entries()) webhookData[k] = v;
      }
    } else {
      webhookData = req.body;
    }

    if (webhookData.PaymentId) webhookData.PaymentId = webhookData.PaymentId.toString();
    if (webhookData.RebillId) webhookData.RebillId = webhookData.RebillId.toString();
    if (webhookData.OrderId) webhookData.OrderId = webhookData.OrderId.toString();

    const orderInfo = await findOrderByTbankOrderId(webhookData.OrderId);

    if (!orderInfo) {
      return res.status(200).send('OK');
    }

    const { userId, orderId } = orderInfo;

    await saveOrderMapping(webhookData.OrderId, userId, orderId);
    const rebillId = await updatePaymentFromWebhook(userId, orderId, webhookData);

    if (rebillId) {
      await saveUserSubscription(userId, webhookData, rebillId);
    }

    return res.status(200).send('OK');

  } catch (error) {
    console.error('❌ Ошибка вебхука:', error);
    return res.status(200).send('OK');
  }
});

module.exports = router;
