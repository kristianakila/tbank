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
            
            // Проверяем в orders2 (для разовых платежей)
            const orders2Ref = db.collection('telegramUsers')
              .doc(userId)
              .collection('orders2');
            const orders2Query = await orders2Ref.where('paymentId', '==', PaymentId).limit(1).get();

            if (!orders2Query.empty) {
              const orderDoc = orders2Query.docs[0];
              orderInfo = { 
                userId, 
                orderId: orderDoc.id, 
                docRef: orderDoc.ref,
                collection: 'orders2' 
              };

              console.log(`✅ Найден заказ в orders2 по PaymentId: userId=${userId}, orderId=${orderDoc.id}`);

              if (OrderId) {
                await saveOrderMapping(OrderId, userId, orderDoc.id);
              }
              break;
            }

            // Проверяем в orders (для обратной совместимости)
            const ordersRef = db.collection('telegramUsers')
              .doc(userId)
              .collection('orders');
            const ordersQuery = await ordersRef.where('paymentId', '==', PaymentId).limit(1).get();

            if (!ordersQuery.empty) {
              const orderDoc = ordersQuery.docs[0];
              orderInfo = { 
                userId, 
                orderId: orderDoc.id, 
                docRef: orderDoc.ref,
                collection: 'orders' 
              };

              console.log(`✅ Найден заказ в orders по PaymentId: userId=${userId}, orderId=${orderDoc.id}`);

              if (OrderId) {
                await saveOrderMapping(OrderId, userId, orderDoc.id);
              }
              break;
            }
          }
        }

        // ============================================================
        // === 3. ОБРАБОТКА НАЙДЕННОГО ЗАКАЗА ========================
        // ============================================================
        if (orderInfo) {
          console.log('🔍 Определяю тип заказа...');

          // === ДОБАВЛЕНО: Получаем данные заказа для сохранения информации о товаре ===
          let orderData = null;
          if (orderInfo.collection === 'orders2') {
            const orderDoc = await db.collection('telegramUsers')
              .doc(orderInfo.userId)
              .collection('orders2')
              .doc(orderInfo.orderId)
              .get();
            orderData = orderDoc.exists ? orderDoc.data() : null;
          } else {
            const orderDoc = await db.collection('orders').doc(orderInfo.orderId).get();
            orderData = orderDoc.exists ? orderDoc.data() : null;
          }

          console.log('📦 Данные заказа:', JSON.stringify({
            productId: orderData?.productId,
            productType: orderData?.productType,
            productTitle: orderData?.productTitle,
            type: orderData?.type
          }, null, 2));

          // === A) Покупка товара =====================================
          if ((orderData && orderData.type === 'product_purchase') || 
              (orderData && orderData.productId)) {
            console.log(`🛍️ Обработка покупки товара: ${orderInfo.orderId}`);

            await updatePaymentFromWebhook(orderInfo.userId, orderInfo.orderId, webhookData);

            // ДОБАВЛЕНО: Сохраняем данные о товаре
            const productUpdateData = {
              status: Success ? 'PAID' : 'FAILED',
              webhookData: webhookData,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              ...(Success && { paidAt: admin.firestore.FieldValue.serverTimestamp() })
            };

            // Добавляем данные о товаре, если они есть в заказе
            if (orderData.productId) productUpdateData.productId = orderData.productId;
            if (orderData.productType) productUpdateData.productType = orderData.productType;
            if (orderData.productTitle) productUpdateData.productTitle = orderData.productTitle;

            // Обновляем заказ в соответствующей коллекции
            if (orderInfo.collection === 'orders2') {
              await db.collection('telegramUsers')
                .doc(orderInfo.userId)
                .collection('orders2')
                .doc(orderInfo.orderId)
                .set(productUpdateData, { merge: true });
            } else {
              await db.collection('orders')
                .doc(orderInfo.orderId)
                .set(productUpdateData, { merge: true });
            }

            // ДОБАВЛЕНО: Обновляем основной документ пользователя с информацией о товаре
            const userUpdateData = {
              'purchase.status': Success ? 'paid' : 'failed',
              'purchase.updatedAt': admin.firestore.FieldValue.serverTimestamp(),
              ...(Success && {
                'purchase.paidAt': admin.firestore.FieldValue.serverTimestamp(),
                'purchase.paymentId': PaymentId
              })
            };

            // Сохраняем информацию о товаре в основном документе
            if (Success && orderData.productId) {
              userUpdateData['purchase.productId'] = orderData.productId;
              userUpdateData['purchase.productType'] = orderData.productType || 'forecast';
              userUpdateData['purchase.productTitle'] = orderData.productTitle || 'Разовый прогноз';
              userUpdateData['purchase.description'] = orderData.description || `Покупка: ${orderData.productTitle || 'товар'}`;
            }

            await db.collection('telegramUsers')
              .doc(orderInfo.userId)
              .set(userUpdateData, { merge: true });

            console.log(`✅ Данные о покупке товара сохранены: productId=${orderData.productId}`);

            // Вызываем сервис покупок, если он существует
            try {
              const purchaseService = require('./purchaseService');
              await purchaseService.updatePurchaseStatus(orderInfo, webhookData);
            } catch (e) {
              console.log('ℹ️ purchaseService не найден или произошла ошибка:', e.message);
            }
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

            // ДОБАВЛЕНО: Все равно пытаемся сохранить данные о товаре, если они есть
            if (Success && orderData && orderData.productId) {
              console.log(`📦 Сохраняю данные о товаре из старого заказа: productId=${orderData.productId}`);

              await db.collection('telegramUsers')
                .doc(orderInfo.userId)
                .set({
                  'purchase.productId': orderData.productId,
                  'purchase.productType': orderData.productType || 'forecast',
                  'purchase.productTitle': orderData.productTitle || 'Разовый прогноз',
                  'purchase.updatedAt': admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
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
