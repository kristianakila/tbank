const admin = require('firebase-admin');

/**
 * Обработка вебхуков от T-Bank
 */
async function handleWebhook(req, res, services) {
  console.log('📨 ВЕБХУК: Получен запрос от T-Bank');
  
  const {
    db,
    scheduledJobs,
    findOrderByTbankOrderId,
    saveOrderMapping,
    updatePaymentFromWebhook,
    saveUserSubscription,
    cancelUserSubscription
  } = services;
  
  let webhookData;
  
  try {
    // === 1. ПАРСИНГ RAW-BODY ===
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      const bodyString = req.body.toString();
      console.log('📨 ВЕБХУК RAW BODY:', bodyString);
      
      try {
        webhookData = JSON.parse(bodyString);
      } catch {
        const parsed = new URLSearchParams(bodyString);
        webhookData = {};
        for (const [key, value] of parsed.entries()) webhookData[key] = value;
      }
    } else {
      webhookData = req.body;
    }
    
    // Приведение типов
    if (webhookData.PaymentId) webhookData.PaymentId = webhookData.PaymentId.toString();
    if (webhookData.RebillId) webhookData.RebillId = webhookData.RebillId.toString();
    if (webhookData.CardId) webhookData.CardId = webhookData.CardId.toString();
    if (webhookData.OrderId) webhookData.OrderId = webhookData.OrderId.toString();
    
    console.log('📨 PARSED WEBHOOK:', JSON.stringify(webhookData, null, 2));

    const {
      OrderId,
      Success,
      Status,
      PaymentId,
      Amount,
      RebillId
    } = webhookData;
    
    console.log(`📨 ВЕБХУК:
    OrderId: ${OrderId}
    PaymentId: ${PaymentId}
    Status: ${Status}
    Success: ${Success}
    RebillId: ${RebillId || '—'}
    Amount: ${Amount ? Amount / 100 : 0}₽`);
    
    // === Сразу отвечаем банку 200 OK ===
    res.status(200).json({ Success: true, Error: '0' });
    
    // === Асинхронная обработка ===
    setTimeout(async () => {
      try {
        console.log('🔄 ВЕБХУК: Асинхронная обработка началась...');

        // === Защита от дублей ===
        const webhookKey = `wh_${PaymentId}_${Status}_${RebillId || 'norebill'}`;
        const webhookLogRef = db.collection('webhookLogs').doc(webhookKey);
        if ((await webhookLogRef.get()).exists) {
          console.log(`⚠️ Дубликат вебхука: ${webhookKey}`);
          return;
        }

        await webhookLogRef.set({
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: Status,
          orderId: OrderId,
          paymentId: PaymentId,
          rebillId: RebillId,
          success: Success,
          data: webhookData
        });

        let orderInfo = null;
        let rebillIdToProcess = RebillId;

        // === 1. Поиск заказа по OrderId ===
        if (OrderId) {
          orderInfo = await findOrderByTbankOrderId(OrderId);
          if (orderInfo) {
            console.log(`🔎 Найден в маппингах: userId=${orderInfo.userId}, orderId=${orderInfo.orderId}`);
          }
        }

        // === 2. Поиск по PaymentId ===
        if (!orderInfo && PaymentId) {
          console.log(`🔎 Ищу заказ по PaymentId=${PaymentId}`);

          const usersSnapshot = await db.collection('telegramUsers').limit(10).get();

          for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const ordersRef = db.collection('telegramUsers')
              .doc(userId)
              .collection('orders');

            const query = await ordersRef.where('paymentId', '==', PaymentId).limit(1).get();

            if (!query.empty) {
              const orderDoc = query.docs[0];
              orderInfo = { userId, orderId: orderDoc.id, docRef: orderDoc.ref };

              console.log(`✅ Найден заказ по PaymentId: userId=${userId}, orderId=${orderDoc.id}`);

              if (OrderId) {
                await saveOrderMapping(OrderId, userId, orderDoc.id);
              }
              break;
            }
          }
        }

        // ============================================================
        // === 3. ОБРАБОТКА НАЙДЕННОГО ЗАКАЗА (ТВОЯ ДОРАБОТКА) ========
        // ============================================================
        if (orderInfo) {
          console.log('🔍 Определяю тип заказа...');

          const orderDoc = await db.collection('orders').doc(orderInfo.orderId).get();
          const orderData = orderDoc.exists ? orderDoc.data() : null;

          // === A) Покупка товара =====================================
          if (orderData && orderData.type === 'product_purchase') {
            console.log(`🛍️ Обработка покупки товара: ${orderInfo.orderId}`);

            await updatePaymentFromWebhook(orderInfo.userId, orderInfo.orderId, webhookData);

            const purchaseService = require('./purchaseService');
            await purchaseService.updatePurchaseStatus(orderInfo, webhookData);

            console.log('🛍️ Покупка товара обработана!');
          }

          // === B) Рекуррентная подписка =============================
          else if (orderData && orderData.type === 'recurrent') {
            console.log(`🔁 Обработка рекуррентной подписки: ${orderInfo.orderId}`);

            const updatedRebillId = await updatePaymentFromWebhook(
              orderInfo.userId,
              orderInfo.orderId,
              webhookData
            );

            rebillIdToProcess = rebillIdToProcess || updatedRebillId;

            if (rebillIdToProcess) {
              await saveUserSubscription(orderInfo.userId, webhookData, rebillIdToProcess);
              console.log('🔁 Подписка обновлена!');
            }
          }

          // === C) Старая логика (совместимость) ======================
          else {
            console.log('ℹ️ Использую старую логику обработки заказа...');

            const updatedRebillId = await updatePaymentFromWebhook(
              orderInfo.userId,
              orderInfo.orderId,
              webhookData
            );

            rebillIdToProcess = rebillIdToProcess || updatedRebillId;

            if (rebillIdToProcess) {
              await saveUserSubscription(orderInfo.userId, webhookData, rebillIdToProcess);
            }
          }
        }

        // ============================================================

        else {
          // === 4. Заказ не найден ===================================
          console.log('⚠️ Заказ не найден! Сохраняю в pendingWebhooks...');

          const docId = `pending_${Date.now()}_${PaymentId || 'no_pid'}`;
          await db.collection('pendingWebhooks').doc(docId).set({
            webhookData,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            processed: false,
            orderId: OrderId,
            paymentId: PaymentId,
            rebillId: RebillId,
            status: Status,
            success: Success,
            amount: Amount
          });

          // === Попытка найти пользователя по email для подписки ===
          if (RebillId && (Status === 'CONFIRMED' || Status === 'AUTHORIZED') && webhookData.Email) {
            console.log(`🔍 Ищу пользователя по email=${webhookData.Email}`);

            const usersByEmail = await db.collection('telegramUsers')
              .where('email', '==', webhookData.Email)
              .limit(1)
              .get();

            if (!usersByEmail.empty) {
              const userId = usersByEmail.docs[0].id;

              await saveUserSubscription(userId, webhookData, RebillId);

              await db.collection('pendingWebhooks').doc(docId).update({
                processed: true,
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
                processedUserId: userId
              });

              console.log('🔁 Подписка сохранена по email!');
            }
          }
        }

        console.log('✅ ВЕБХУК: Полная обработка завершена');

      } catch (e) {
        console.error('❌ Ошибка обработки вебхука:', e);

        await db.collection('webhookErrors')
          .doc(`${Date.now()}_${webhookData.PaymentId || 'noid'}`)
          .set({
            error: e.message,
            stack: e.stack,
            webhookData,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
      }
    }, 100);

  } catch (e) {
    console.error('❌ Критическая ошибка парсинга вебхука:', e);
    res.status(200).json({ Success: false, Error: e.message });
  }
}

module.exports = { handleWebhook };
