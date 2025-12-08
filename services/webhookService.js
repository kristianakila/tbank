// ============================================
// ФАЙЛ: services/webhookService.js
// НАЗНАЧЕНИЕ: Обработка входящих вебхуков платежного провайдера.
// - поддерживает product_purchase, recurrent и старую (fallback) логику
// - идемпотентность по webhookId/paymentId
// - логирование и защита от отсутствующих сервисов
// ============================================

const admin = require('firebase-admin');
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const purchaseService = require('./purchaseService');
const notificationsService = require('./notificationsService'); // опционально: отправка email/push
const logger = require('./logger') || console; // предполагается ваш логгер, иначе console

/**
 * Хелпер: безопасно получить поле из объекта
 */
function get(obj, path, defaultValue = null) {
  return path.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : defaultValue), obj);
}

/**
 * Основная функция обработки вебхука
 * @param {Express.Request} req
 * @param {Express.Response} res
 * @param {Object} services - набор вспомогательных сервисов, ожидается updatePaymentFromWebhook, handleRecurrentPayment и т.д.
 */
async function handleWebhook(req, res, services = {}) {
  const receivedAt = new Date().toISOString();
  const webhookData = req.body || {};
  const headers = req.headers || {};

  // Простейшая проверка и лог входа
  logger.info && logger.info(`📥 incoming webhook at ${receivedAt}`, { body: webhookData });

  try {
    // 1) Проверка на уникальность / идемпотентность
    // Поддерживаем webhookId или paymentId+eventType как idempotency key
    const webhookId = webhookData.webhookId || webhookData.notificationId || webhookData.eventId || null;
    const paymentId = webhookData.paymentId || webhookData.order_number || webhookData.orderId || null;

    // Сформируем ключ для идемпотентности
    const idempotencyKey = webhookId || (paymentId ? `payment_${paymentId}` : null);

    if (idempotencyKey) {
      const existing = await db.collection('webhookLogs').doc(idempotencyKey).get();
      if (existing.exists) {
        logger.warn && logger.warn('⚠️ webhook duplicate - already processed', { idempotencyKey });
        // Возвращаем 200, чтобы провайдер не резал повторно
        return res.status(200).json({ success: true, message: 'duplicate' });
      }
    }

    // 2) Базовая валидация: ожидали ли конкретные поля?
    // (Здесь можно добавить верификацию подписи, если провайдер её присылает)
    // const signature = headers['x-signature'] || headers['x-hub-signature'];
    // verifySignature(signature, req.rawBody, SECRET);

    // 3) Попытаться извлечь orderInfo (если у вас в старом коде оно добывается иначе — сохраняем совместимость)
    // Предполагается, что в webhookData есть link на существующий заказ: orderId, customerKey/userId и т.п.
    const orderId = webhookData.orderId || webhookData.order_number || webhookData.meta?.orderId || null;
    const userId = webhookData.userId || webhookData.customerKey || webhookData.meta?.userId || webhookData.clientId || null;

    // Если orderId отсутствует — падаем в fallback (может быть просто оплата без привязанного заказа)
    let orderInfo = null;
    if (orderId) {
      orderInfo = { orderId, userId };
    } else if (paymentId && webhookData.customerKey) {
      // попытка собрать из paymentId и customerKey
      orderInfo = { orderId: paymentId, userId: webhookData.customerKey };
    }

    // 4) Обработаем найденный order (если есть)
    if (orderInfo && orderInfo.orderId) {
      // Получаем тип заказа из общей таблицы orders
      const orderDocRef = db.collection('orders').doc(orderInfo.orderId);
      const orderDoc = await orderDocRef.get();
      const orderData = orderDoc.exists ? orderDoc.data() : null;

      // Для надёжности — если orderData отсутствует, пытаемся найти запись в payments или purchases
      if (!orderData) {
        logger.info && logger.info('order not found in orders collection, trying payments/purchases', { orderId: orderInfo.orderId });
        const payDoc = await db.collection('payments').doc(orderInfo.orderId).get();
        if (payDoc.exists) {
          const pay = payDoc.data();
          // если в оплате есть привязка к заказу
          if (pay.orderType) {
            orderData = { type: pay.orderType, ...pay };
          } else if (pay.purchaseId) {
            // пример
            orderData = { type: 'product_purchase', purchaseId: pay.purchaseId, ...pay };
          }
        }
      }

      // --- product_purchase: товар / однократная покупка ---
      if (orderData && orderData.type === 'product_purchase') {
        logger.info && logger.info(`🛍️ Обработка product_purchase: ${orderInfo.orderId}`);

        // 1) Обновляем статус оплаты (uses provided services.updatePaymentFromWebhook)
        if (typeof services.updatePaymentFromWebhook === 'function') {
          try {
            await services.updatePaymentFromWebhook(orderInfo.userId, orderInfo.orderId, webhookData);
            logger.info && logger.info('Payment updated via services.updatePaymentFromWebhook', { orderId: orderInfo.orderId });
          } catch (err) {
            logger.error && logger.error('Error in services.updatePaymentFromWebhook', err);
            // Не бросаем — идём дальше чтобы попытаться обновить purchase
          }
        } else {
          logger.warn && logger.warn('services.updatePaymentFromWebhook is not a function or not provided');
        }

        // 2) Обновляем статус покупки/заказа (purchaseService)
        try {
          await purchaseService.updatePurchaseStatus(orderInfo, webhookData);
          logger.info && logger.info('Purchase status updated', { orderId: orderInfo.orderId });
        } catch (err) {
          logger.error && logger.error('purchaseService.updatePurchaseStatus failed', err);
          // сохраняем ошибку в логах + возвращаем 500 (либо продолжаем в зависимости от требований)
          await db.collection('webhookErrors').add({
            createdAt: FieldValue.serverTimestamp(),
            orderId: orderInfo.orderId,
            userId: orderInfo.userId || null,
            webhookData,
            error: (err && err.stack) || String(err),
          });
          // отвечаем 200, чтобы провайдер не повторял webhook; в логах уже будет ошибка для ревью
          if (idempotencyKey) {
            await db.collection('webhookLogs').doc(idempotencyKey).set({
              processedAt: FieldValue.serverTimestamp(),
              type: 'product_purchase',
              orderId: orderInfo.orderId,
              note: 'error_during_purchase_update',
            });
          }
          return res.status(200).json({ success: true, message: 'processed_with_errors' });
        }

        // 3) Доп. логика: нотификация пользователю, создание записи в purchases и т.д.
        try {
          // Пример: отметка в orders
          await orderDocRef.set({
            lastWebhookAt: FieldValue.serverTimestamp(),
            lastWebhookRaw: webhookData,
            status: webhookData.status || webhookData.paymentStatus || 'paid',
          }, { merge: true });

          // Уведомление пользователю (если есть сервис)
          if (notificationsService && typeof notificationsService.notifyUserPurchaseCompleted === 'function') {
            await notificationsService.notifyUserPurchaseCompleted(orderInfo.userId, orderInfo.orderId);
          }
        } catch (err) {
          logger.warn && logger.warn('Warning during post-purchase steps', err);
        }

        // Финальный лог обработки
        if (idempotencyKey) {
          await db.collection('webhookLogs').doc(idempotencyKey).set({
            processedAt: FieldValue.serverTimestamp(),
            type: 'product_purchase',
            orderId: orderInfo.orderId,
            userId: orderInfo.userId || null,
            webhookRaw: webhookData,
          });
        }

        return res.status(200).json({ success: true });
      }

      // --- recurrent: автоплатеж / подписка ---
      else if (orderData && orderData.type === 'recurrent') {
        logger.info && logger.info(`🔁 Обработка recurrent payment: ${orderInfo.orderId}`);

        // Если у вас есть сервис для рекуррентных платежей — используем его
        if (typeof services.handleRecurrentPayment === 'function') {
          try {
            await services.handleRecurrentPayment(orderInfo.userId, orderInfo.orderId, webhookData);
            logger.info && logger.info('Recurrent payment handled by services.handleRecurrentPayment', { orderId: orderInfo.orderId });
          } catch (err) {
            logger.error && logger.error('services.handleRecurrentPayment failed', err);
            await db.collection('webhookErrors').add({
              createdAt: FieldValue.serverTimestamp(),
              type: 'recurrent',
              orderId: orderInfo.orderId,
              webhookData,
              error: (err && err.stack) || String(err),
            });
            if (idempotencyKey) {
              await db.collection('webhookLogs').doc(idempotencyKey).set({
                processedAt: FieldValue.serverTimestamp(),
                type: 'recurrent',
                orderId: orderInfo.orderId,
                note: 'error_handling_recurrent',
              });
            }
            return res.status(200).json({ success: true, message: 'processed_with_errors' });
          }

        } else {
          // фоллбек — обновляем payment и продлеваем/помечаем подписку
          logger.warn && logger.warn('services.handleRecurrentPayment is not provided; falling back to inline handling');

          // Обновляем запись payment
          try {
            if (typeof services.updatePaymentFromWebhook === 'function') {
              await services.updatePaymentFromWebhook(orderInfo.userId, orderInfo.orderId, webhookData);
            }

            // Пример: обновление подписки в коллекции subscriptions
            const subscriptionsRef = db.collection('subscriptions').doc(orderInfo.orderId);
            const subsDoc = await subscriptionsRef.get();
            if (subsDoc.exists) {
              const subs = subsDoc.data();
              // вычисляем новое expiryDate (пример: добавить месяц)
              const now = new Date();
              const nextExpiry = subs.expiryDate ? new Date(subs.expiryDate.toDate ? subs.expiryDate.toDate() : subs.expiryDate) : now;
              // Добавим 1 месяц — примерная логика, подстроить под ваш план
              nextExpiry.setMonth(nextExpiry.getMonth() + (subs.intervalMonths || 1));
              await subscriptionsRef.set({
                expiryDate: admin.firestore.Timestamp.fromDate(nextExpiry),
                lastPaymentWebhookAt: FieldValue.serverTimestamp(),
                lastWebhookRaw: webhookData,
              }, { merge: true });
            } else {
              // если подписка не найдена — просто логируем
              logger.warn && logger.warn('subscriptions doc not found for recurrent order', { orderId: orderInfo.orderId });
            }
          } catch (err) {
            logger.error && logger.error('Inline recurrent fallback failed', err);
          }
        }

        if (idempotencyKey) {
          await db.collection('webhookLogs').doc(idempotencyKey).set({
            processedAt: FieldValue.serverTimestamp(),
            type: 'recurrent',
            orderId: orderInfo.orderId,
            userId: orderInfo.userId || null,
            webhookRaw: webhookData,
          });
        }

        return res.status(200).json({ success: true });
      }

      // --- fallback / обратная совместимость / неизвестный тип ---
      else {
        logger.info && logger.info('⚙️ Fallback webhook handling (unknown or legacy order type)', { orderId: orderInfo.orderId });

        // Попытка обновить платеж
        if (typeof services.updatePaymentFromWebhook === 'function') {
          try {
            await services.updatePaymentFromWebhook(orderInfo.userId, orderInfo.orderId, webhookData);
            logger.info && logger.info('Payment updated in fallback path', { orderId: orderInfo.orderId });
          } catch (err) {
            logger.error && logger.error('updatePaymentFromWebhook failed in fallback', err);
            await db.collection('webhookErrors').add({
              createdAt: FieldValue.serverTimestamp(),
              type: 'fallback',
              orderId: orderInfo.orderId,
              webhookData,
              error: (err && err.stack) || String(err),
            });
          }
        } else {
          // Если нет сервиса — сохраняем запись в payments
          try {
            await db.collection('payments').doc(orderInfo.orderId).set({
              updatedAt: FieldValue.serverTimestamp(),
              lastWebhook: webhookData,
              lastWebhookAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          } catch (err) {
            logger.error && logger.error('Failed to create/update payments doc in fallback', err);
          }
        }

        if (idempotencyKey) {
          await db.collection('webhookLogs').doc(idempotencyKey).set({
            processedAt: FieldValue.serverTimestamp(),
            type: 'fallback',
            orderId: orderInfo.orderId,
            userId: orderInfo.userId || null,
            webhookRaw: webhookData,
          });
        }

        return res.status(200).json({ success: true });
      }
    } // end if orderInfo

    // --- Если orderInfo отсутствует — возможно это нотификация об оплате без orderId (локальные пополнения баланса) ---
    logger.info && logger.info('No orderInfo found - handling as generic payment notification');

    // Попытка: если webhook содержит customerKey/userId и amount -> пополнение баланса
    const possibleUserId = userId || webhookData.customerKey || webhookData.clientId || null;
    const amount = Number(webhookData.amount || webhookData.sum || webhookData.total || 0);

    if (possibleUserId && amount > 0) {
      try {
        // Запись payment
        const paymentRef = db.collection('payments').doc(paymentId || `${possibleUserId}_${Date.now()}`);
        await paymentRef.set({
          userId: possibleUserId,
          amount,
          raw: webhookData,
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        // Пополнение баланса пользователя в telegramUsers/{userId}/balance (если такая логика у вас)
        const userRef = db.collection('telegramUsers').doc(possibleUserId);
        const userDoc = await userRef.get();
        if (userDoc.exists) {
          // например, баланс хранится в поле balance.amount
          await userRef.set({
            balance: {
              amount: FieldValue.increment(amount),
              lastTopupAt: FieldValue.serverTimestamp(),
            }
          }, { merge: true });

          // Notify
          if (notificationsService && typeof notificationsService.notifyUserBalanceTopup === 'function') {
            await notificationsService.notifyUserBalanceTopup(possibleUserId, amount);
          }
        } else {
          logger.warn && logger.warn('telegramUsers doc not found for topup', { userId: possibleUserId });
        }
      } catch (err) {
        logger.error && logger.error('Error handling generic payment notification', err);
      }

      if (idempotencyKey) {
        await db.collection('webhookLogs').doc(idempotencyKey).set({
          processedAt: FieldValue.serverTimestamp(),
          type: 'generic_topup',
          userId: possibleUserId,
          amount,
          webhookRaw: webhookData,
        });
      }

      return res.status(200).json({ success: true });
    }

    // Ничего не нашли — логируем и отвечаем 400 (или 200, если хотите гасить провайдер)
    logger.warn && logger.warn('Webhook did not match any known pattern', { body: webhookData });

    // Сохраняем для дебага
    await db.collection('webhookUnhandled').add({
      createdAt: FieldValue.serverTimestamp(),
      body: webhookData,
      headers,
    });

    // Отвечаем 200 чтобы провайдер не переотсылал (меняйте поведение по вашим требованиям)
    return res.status(200).json({ success: true, message: 'unhandled_but_logged' });

  } catch (err) {
    // Глобальный catch — записываем ошибку и возвращаем 500
    logger.error && logger.error('Critical error in webhook handler', err);
    await db.collection('webhookErrors').add({
      createdAt: FieldValue.serverTimestamp(),
      error: (err && err.stack) || String(err),
      rawBody: req.body,
    });

    // По умолчанию возвращаем 500 — если хотите гасить и возвращать 200, измените здесь
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
}

module.exports = { handleWebhook };
