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
    
    // Приведение типов и обработка undefined
    const sanitizedWebhookData = {};
    for (const [key, value] of Object.entries(webhookData)) {
      if (value !== undefined && value !== null) {
        sanitizedWebhookData[key] = value.toString();
      }
    }
    webhookData = sanitizedWebhookData;
    
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

        // Подготавливаем данные для лога без undefined значений
        const webhookLogData = {
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: Status,
          orderId: OrderId,
          paymentId: PaymentId,
          success: Success === 'true' || Success === true,
          data: webhookData
        };

        // Добавляем rebillId только если он существует
        if (RebillId) {
          webhookLogData.rebillId = RebillId;
        }

        await webhookLogRef.set(webhookLogData, { ignoreUndefinedProperties: true });

        let orderInfo = null;
        let rebillIdToProcess = RebillId;

        // === 1. Поиск заказа по OrderId ===
        if (OrderId) {
          orderInfo = await findOrderByTbankOrderId(OrderId);
          if (orderInfo) {
            console.log(`🔎 Найден в маппингах: userId=${orderInfo.userId}, orderId=${orderInfo.orderId}`);
            
            // ВАЖНО: Определяем, в какой коллекции находится заказ
            // Проверяем сначала orders2, потом orders
            const orders2Ref = db.collection('telegramUsers')
              .doc(orderInfo.userId)
              .collection('orders2')
              .doc(orderInfo.orderId);
            const orders2Doc = await orders2Ref.get();
            
            if (orders2Doc.exists) {
              orderInfo.collection = 'orders2';
              orderInfo.docRef = orders2Ref;
              console.log(`📂 Заказ найден в коллекции orders2`);
            } else {
              // Проверяем orders для подписок
              const ordersRef = db.collection('telegramUsers')
                .doc(orderInfo.userId)
                .collection('orders')
                .doc(orderInfo.orderId);
              const ordersDoc = await ordersRef.get();
              
              if (ordersDoc.exists) {
                orderInfo.collection = 'orders';
                orderInfo.docRef = ordersRef;
                console.log(`📂 Заказ найден в коллекции orders`);
              } else {
                console.log(`⚠️ Заказ не найден ни в orders2, ни в orders`);
              }
            }
          }
        }

        // === 2. Поиск по PaymentId ===
        if (!orderInfo && PaymentId) {
          console.log(`🔎 Ищу заказ по PaymentId=${PaymentId}`);

          const usersSnapshot = await db.collection('telegramUsers').limit(10).get();

          for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            
            // Проверяем в orders2 (для разовых платежей) - ПРИОРИТЕТ
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

            // Проверяем в orders (для подписок)
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
          console.log(`🔍 Обрабатываю заказ из коллекции: ${orderInfo.collection}`);

          // Получаем данные заказа
          let orderData = null;
          if (orderInfo.collection === 'orders2') {
            const orderDoc = await orderInfo.docRef.get();
            orderData = orderDoc.exists ? orderDoc.data() : null;
          } else if (orderInfo.collection === 'orders') {
            const orderDoc = await orderInfo.docRef.get();
            orderData = orderDoc.exists ? orderDoc.data() : null;
          }

          console.log('📦 Данные заказа:', JSON.stringify({
            productId: orderData?.productId,
            productType: orderData?.productType,
            productTitle: orderData?.productTitle,
            type: orderData?.type
          }, null, 2));

          // === A) Разовый платеж (orders2) ===========================
          if (orderInfo.collection === 'orders2') {
            console.log(`💰 Обработка разового платежа: ${orderInfo.orderId}`);

            const isSuccess = Success === 'true' || Success === true;
            
            // Подготавливаем данные для обновления заказа
            const productUpdateData = {
              status: isSuccess ? 'PAID' : 'FAILED',
              webhookStatus: Status,
              webhookData: webhookData,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };

            // Добавляем paidAt только при успешной оплате
            if (isSuccess) {
              productUpdateData.paidAt = admin.firestore.FieldValue.serverTimestamp();
              productUpdateData.status = 'PAID';
              productUpdateData.paymentStatus = 'confirmed';
            }

            // Сохраняем оригинальные данные о товаре
            if (orderData?.productId) productUpdateData.productId = orderData.productId;
            if (orderData?.productType) productUpdateData.productType = orderData.productType;
            if (orderData?.productTitle) productUpdateData.productTitle = orderData.productTitle;
            if (orderData?.description) productUpdateData.description = orderData.description;

            // Обновляем заказ в orders2
            await orderInfo.docRef.set(productUpdateData, { merge: true, ignoreUndefinedProperties: true });

            // Обновляем основной документ пользователя
            const userUpdateData = {
              'purchase.status': isSuccess ? 'paid' : 'failed',
              'purchase.updatedAt': admin.firestore.FieldValue.serverTimestamp(),
            };

            // При успешной оплате сохраняем дополнительную информацию
            if (isSuccess) {
              userUpdateData['purchase.paidAt'] = admin.firestore.FieldValue.serverTimestamp();
              userUpdateData['purchase.paymentId'] = PaymentId;
              userUpdateData['purchase.webhookStatus'] = Status;
              
              // Сохраняем информацию о товаре
              if (orderData?.productId) {
                userUpdateData['purchase.productId'] = orderData.productId;
                userUpdateData['purchase.productType'] = orderData.productType || 'forecast';
                userUpdateData['purchase.productTitle'] = orderData.productTitle || 'Разовый прогноз';
                userUpdateData['purchase.description'] = orderData.description || `Покупка: ${orderData.productTitle || 'товар'}`;
                userUpdateData['purchase.amount'] = Amount ? parseInt(Amount) / 100 : orderData?.amount || 0;
              }
            }

            await db.collection('telegramUsers')
              .doc(orderInfo.userId)
              .set(userUpdateData, { merge: true, ignoreUndefinedProperties: true });

            console.log(`✅ Разовый платеж обновлен: productId=${orderData?.productId || 'N/A'}, status=${isSuccess ? 'PAID' : 'FAILED'}`);

            // Также обновляем через стандартный сервис если это orders
            try {
              if (typeof updatePaymentFromWebhook === 'function') {
                // Для совместимости также обновляем в orders если нужно
                if (orderInfo.collection === 'orders2') {
                  const ordersRef = db.collection('telegramUsers')
                    .doc(orderInfo.userId)
                    .collection('orders')
                    .doc(orderInfo.orderId);
                  
                  // Создаем/обновляем и в orders для совместимости
                  await ordersRef.set({
                    status: isSuccess ? 'PAID' : 'FAILED',
                    webhookData: webhookData,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    ...(isSuccess && { paidAt: admin.firestore.FieldValue.serverTimestamp() })
                  }, { merge: true, ignoreUndefinedProperties: true });
                }
                
                await updatePaymentFromWebhook(orderInfo.userId, orderInfo.orderId, webhookData);
              }
            } catch (e) {
              console.log('ℹ️ updatePaymentFromWebhook ошибка:', e.message);
            }
          }

          // === B) Подписка (orders) =================================
          else if (orderInfo.collection === 'orders') {
            console.log(`🔁 Обработка подписки: ${orderInfo.orderId}`);
            
            if (typeof updatePaymentFromWebhook === 'function') {
              const updatedRebillId = await updatePaymentFromWebhook(
                orderInfo.userId,
                orderInfo.orderId,
                webhookData
              );

              rebillIdToProcess = rebillIdToProcess || updatedRebillId;
            }

            if (rebillIdToProcess) {
              await saveUserSubscription(orderInfo.userId, webhookData, rebillIdToProcess);
              console.log('🔁 Подписка обновлена!');
            }
          }

          // === C) Неизвестная коллекция =============================
          else {
            console.log('⚠️ Неизвестная коллекция заказа, пытаюсь определить автоматически...');
            
            // Пробуем обновить в orders2 (приоритет для разовых)
            try {
              const orders2Ref = db.collection('telegramUsers')
                .doc(orderInfo.userId)
                .collection('orders2')
                .doc(orderInfo.orderId);
              
              const orders2Doc = await orders2Ref.get();
              
              if (orders2Doc.exists) {
                console.log('🔎 Заказ найден в orders2, обновляю там');
                
                const isSuccess = Success === 'true' || Success === true;
                await orders2Ref.set({
                  status: isSuccess ? 'PAID' : 'FAILED',
                  webhookData: webhookData,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  ...(isSuccess && { paidAt: admin.firestore.FieldValue.serverTimestamp() })
                }, { merge: true, ignoreUndefinedProperties: true });
              } else {
                // Пробуем обновить в orders
                const ordersRef = db.collection('telegramUsers')
                  .doc(orderInfo.userId)
                  .collection('orders')
                  .doc(orderInfo.orderId);
                
                await ordersRef.set({
                  webhookData: webhookData,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true, ignoreUndefinedProperties: true });
              }
            } catch (e) {
              console.error('❌ Ошибка обновления заказа:', e.message);
            }
          }
        }

        // ============================================================

        else {
          // === 4. Заказ не найден ===================================
          console.log('⚠️ Заказ не найден! Сохраняю в pendingWebhooks...');

          const docId = `pending_${Date.now()}_${PaymentId || 'no_pid'}`;
          
          const pendingData = {
            webhookData,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            processed: false,
            orderId: OrderId,
            paymentId: PaymentId,
            status: Status,
            success: Success === 'true' || Success === true,
            amount: Amount
          };

          // Добавляем rebillId только если он существует
          if (RebillId) {
            pendingData.rebillId = RebillId;
          }

          await db.collection('pendingWebhooks').doc(docId).set(pendingData, { ignoreUndefinedProperties: true });

          // === Попытка найти пользователя по email для подписки ===
          if (RebillId && (Status === 'CONFIRMED' || Status === 'AUTHORIZED') && webhookData.Email) {
            console.log(`🔍 Ищу пользователя по email=${webhookData.Email}`);

            const usersByEmail = await db.collection('telegramUsers')
              .where('email', '==', webhookData.Email)
              .limit(1)
              .get();

            if (!usersByEmail.empty) {
              const userId = usersByEmail.docs[0].id;

              if (typeof saveUserSubscription === 'function') {
                await saveUserSubscription(userId, webhookData, RebillId);
              }

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

        const errorData = {
          error: e.message,
          stack: e.stack,
          webhookData,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('webhookErrors')
          .doc(`${Date.now()}_${webhookData?.PaymentId || 'noid'}`)
          .set(errorData, { ignoreUndefinedProperties: true });
      }
    }, 100);

  } catch (e) {
    console.error('❌ Критическая ошибка парсинга вебхука:', e);
    res.status(200).json({ Success: false, Error: e.message });
  }
}

module.exports = { handleWebhook };
