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
    // Парсинг данных вебхука
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      const bodyString = req.body.toString();
      console.log('📨 ВЕБХУК: Raw body:', bodyString);
      
      try {
        webhookData = JSON.parse(bodyString);
      } catch (parseError) {
        const parsed = new URLSearchParams(bodyString);
        webhookData = {};
        for (const [key, value] of parsed.entries()) {
          webhookData[key] = value;
        }
      }
    } else {
      webhookData = req.body;
    }
    
    // Приводим ID к строковому формату
    if (webhookData.PaymentId) webhookData.PaymentId = webhookData.PaymentId.toString();
    if (webhookData.RebillId) webhookData.RebillId = webhookData.RebillId.toString();
    if (webhookData.CardId) webhookData.CardId = webhookData.CardId.toString();
    if (webhookData.OrderId) webhookData.OrderId = webhookData.OrderId.toString();
    
    console.log('📨 ВЕБХУК: Parsed data:', JSON.stringify(webhookData, null, 2));
    
    const {
      OrderId,
      Success,
      Status,
      PaymentId,
      Amount,
      RebillId,
      CardId,
      Pan
    } = webhookData;
    
    console.log('📨 ВЕБХУК:');
    console.log(`   OrderId: ${OrderId}`);
    console.log(`   PaymentId: ${PaymentId}`);
    console.log(`   Status: ${Status}`);
    console.log(`   Success: ${Success}`);
    console.log(`   RebillId: ${RebillId || 'не указан'}`);
    console.log(`   Amount: ${Amount ? Amount / 100 : 0} руб.`);
    
    // ВАЖНО: Всегда возвращаем успех сразу банку
    res.status(200).json({ Success: true, Error: '0' });
    
    // Начинаем асинхронную обработку
    setTimeout(async () => {
      try {
        console.log('🔄 ВЕБХУК: Начинаем асинхронную обработку...');
        
        // ПРОВЕРКА: Не обрабатывать дублирующиеся вебхуки
        const webhookKey = `wh_${PaymentId}_${Status}_${RebillId || 'norebill'}`;
        const webhookLogRef = db.collection('webhookLogs').doc(webhookKey);
        const webhookLog = await webhookLogRef.get();
        
        if (webhookLog.exists) {
          console.log(`⚠️ Вебхук уже был обработан ранее: ${webhookKey}`);
          return;
        }
        
        // Логируем обработку вебхука
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
        
        // 1. Пытаемся найти заказ по OrderId в маппингах
        if (OrderId) {
          orderInfo = await findOrderByTbankOrderId(OrderId);
          if (orderInfo) {
            console.log(`✅ ВЕБХУК: Найден заказ в маппингах: userId=${orderInfo.userId}, orderId=${orderInfo.orderId}`);
          }
        }
        
        // 2. Если не нашли в маппингах, пытаемся найти по PaymentId
        if (!orderInfo && PaymentId) {
          console.log(`🔍 Ищу заказ по PaymentId: ${PaymentId}`);
          
          // Ищем во всех пользователях заказ с таким paymentId
          const usersSnapshot = await db.collection('telegramUsers').limit(10).get();
          
          for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const ordersRef = db.collection('telegramUsers')
              .doc(userId)
              .collection('orders');
            
            const querySnapshot = await ordersRef
              .where('paymentId', '==', PaymentId)
              .limit(1)
              .get();
            
            if (!querySnapshot.empty) {
              const orderDoc = querySnapshot.docs[0];
              orderInfo = {
                userId: userId,
                orderId: orderDoc.id,
                docRef: orderDoc.ref
              };
              console.log(`✅ Найден заказ по PaymentId: userId=${userId}, orderId=${orderDoc.id}`);
              
              // Сохраняем маппинг для будущих вебхуков
              if (OrderId) {
                await saveOrderMapping(OrderId, userId, orderDoc.id);
              }
              break;
            }
          }
        }
        
        // 3. Обработка найденного заказа
        if (orderInfo) {
          // Обновляем платеж данными из вебхука
          const updatedRebillId = await updatePaymentFromWebhook(
            orderInfo.userId, 
            orderInfo.orderId, 
            webhookData
          );
          
          // Используем rebillId из вебхука или из результата обновления
          rebillIdToProcess = rebillIdToProcess || updatedRebillId;
          
          if (rebillIdToProcess) {
            console.log(`🎉 ВЕБХУК: RebillId для обработки: ${rebillIdToProcess}`);
            
            // Сохраняем подписку пользователя с планированием
            await saveUserSubscription(orderInfo.userId, webhookData, rebillIdToProcess);
          } else {
            console.log('ℹ️ ВЕБХУК: RebillId не получен, возможно это разовый платеж');
            
            // Если платеж успешный, но без rebillId - обновляем статус заказа
            if (Success === true && Status === 'CONFIRMED') {
              console.log(`✅ Разовый платеж успешен: userId=${orderInfo.userId}, orderId=${orderInfo.orderId}`);
            }
          }
        } else {
          // 4. Заказ не найден - сохраняем для ручной обработки
          console.log('⚠️ ВЕБХУК: Заказ не найден ни в маппингах, ни по PaymentId');
          
          const docId = `pending_${Date.now()}_${PaymentId || 'no_payment_id'}`;
          
          await db.collection('pendingWebhooks')
            .doc(docId)
            .set({
              webhookData: webhookData,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              processed: false,
              orderId: OrderId,
              paymentId: PaymentId,
              rebillId: RebillId,
              status: Status,
              success: Success,
              amount: Amount
            });
          
          console.log(`✅ ВЕБХУК: Вебхук сохранен для ручной обработки (ID: ${docId})`);
          
          // Если есть rebillId, но не нашли заказ - пытаемся создать подписку по данным вебхука
          if (RebillId && (Status === 'CONFIRMED' || Status === 'AUTHORIZED')) {
            console.log('🔍 Пытаюсь обработать подписку по данным вебхука...');
            
            // Ищем пользователя по email из вебхука
            if (webhookData.Email) {
              const usersSnapshot = await db.collection('telegramUsers')
                .where('email', '==', webhookData.Email)
                .limit(1)
                .get();
              
              if (!usersSnapshot.empty) {
                const userDoc = usersSnapshot.docs[0];
                const userId = userDoc.id;
                console.log(`✅ Найден пользователь по email: ${userId}`);
                
                await saveUserSubscription(userId, webhookData, RebillId);
                
                // Помечаем вебхук как обработанный
                await db.collection('pendingWebhooks')
                  .doc(docId)
                  .update({
                    processed: true,
                    processedAt: admin.firestore.FieldValue.serverTimestamp(),
                    processedUserId: userId
                  });
              }
            }
          }
        }
        
        console.log('✅ ВЕБХУК: Обработка завершена');
      } catch (asyncError) {
        console.error('❌ ВЕБХУК: Ошибка асинхронной обработки:', asyncError.message);
        console.error('❌ Stack trace:', asyncError.stack);
        
        // Сохраняем ошибку для отладки
        try {
          await db.collection('webhookErrors')
            .doc(`${Date.now()}_${webhookData.PaymentId || 'no_id'}`)
            .set({
              error: asyncError.message,
              stack: asyncError.stack,
              webhookData: webhookData,
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (logError) {
          console.error('❌ Не удалось сохранить ошибку:', logError.message);
        }
      }
    }, 100); // Задержка 100мс перед асинхронной обработкой
    
  } catch (error) {
    console.error('❌ ВЕБХУК: Критическая ошибка при парсинге:', error.message);
    
    // Всегда возвращаем 200 банку, даже при ошибках
    res.status(200).json({ Success: false, Error: error.message });
  }
}

module.exports = {
  handleWebhook
};
