// services/purchaseService.js
const { getDatabase } = require('../config/firebase');
const Product = require('../models/Product');
const Order = require('../models/Order');
const firebaseService = require('./firebaseService');
const tbankService = require('./tbankService');

const db = getDatabase();
const tbank = tbankService.getTbankInstance();

class PurchaseService {
  /**
   * Инициализация покупки товара
   */
  static async initProductPurchase({
    userId,
    productId,
    email,
    phone = '+79001234567',
    description = '',
    orderId = null
  }) {
    try {
      // Валидируем товар
      const product = await Product.validateProduct(productId);
      
      // Генерируем orderId если не передан
      const tbankOrderId = orderId || `product_${productId}_${Date.now()}_${userId}`;
      const firebaseOrderId = `order_${Date.now()}_${userId}`;
      
      const amount = product.price;
      
      // Создаем чек
      const receipt = {
        Email: email,
        Phone: phone,
        Taxation: 'osn',
        Items: [
          {
            Name: product.name || 'Покупка товара',
            Price: amount * 100,
            Quantity: 1,
            Amount: amount * 100,
            Tax: 'vat20',
            PaymentMethod: 'full_payment',
            PaymentObject: 'service'
          }
        ]
      };

      // Инициализируем платеж в T-Bank
      const payment = await tbank.initPayment({
        Amount: amount * 100,
        OrderId: tbankOrderId,
        Description: description || product.name || `Покупка товара #${productId}`,
        NotificationURL: process.env.NOTIFICATION_URL || 'https://tbank-xp1i.onrender.com/api/webhook',
        Receipt: receipt
      });

      console.log('🛍️ Покупка товара создана:', {
        userId,
        productId,
        amount,
        paymentId: payment.PaymentId
      });

      // Создаем заказ в общей таблице Orders
      const orderData = {
        userId: userId.toString(),
        productId,
        orderId: firebaseOrderId,
        tbankOrderId: tbankOrderId,
        paymentId: payment.PaymentId,
        amount,
        productName: product.name,
        status: 'INITIATED',
        type: 'product_purchase'
      };

      await Order.createOrder(orderData);

      // Сохраняем в профиль пользователя
      await this.saveUserPurchase(userId, firebaseOrderId, orderData);

      // Сохраняем маппинг для вебхуков
      await firebaseService.saveOrderMapping(tbankOrderId, userId, firebaseOrderId);

      return {
        success: true,
        paymentId: payment.PaymentId,
        paymentUrl: payment.PaymentURL,
        orderId: firebaseOrderId,
        tbankOrderId: tbankOrderId,
        product: {
          id: productId,
          name: product.name,
          price: amount
        },
        message: 'Перейдите по ссылке для оплаты. После оплаты товар будет добавлен в ваш профиль.'
      };

    } catch (error) {
      console.error('❌ Ошибка при инициализации покупки:', error);
      throw error;
    }
  }

  /**
   * Сохраняем покупку в профиль пользователя
   */
  static async saveUserPurchase(userId, orderId, orderData) {
    try {
      const userOrderRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('purchases')
        .doc(orderId);

      await userOrderRef.set({
        ...orderData,
        purchasedAt: null, // Будет заполнено после успешной оплаты
        delivered: false,
        downloaded: false,
        downloadCount: 0,
        downloadLimit: product.downloadLimit || 3, // По умолчанию 3 скачивания
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      console.log(`✅ Покупка сохранена в профиль пользователя: ${userId}/${orderId}`);
    } catch (error) {
      console.error('❌ Ошибка сохранения покупки в профиль:', error);
      throw error;
    }
  }

  /**
   * Обновляем статус покупки после вебхука
   */
  static async updatePurchaseStatus(orderInfo, webhookData) {
    try {
      const { userId, orderId } = orderInfo;
      const { Status, Success, RebillId } = webhookData;

      // Обновляем в общей таблице Orders
      await Order.updateOrder(orderId, {
        status: Status,
        success: Success,
        updatedAt: new Date().toISOString(),
        ...(RebillId && { rebillId: RebillId })
      });

      // Обновляем в профиле пользователя
      const userPurchaseRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('purchases')
        .doc(orderId);

      const updateData = {
        status: Status,
        success: Success,
        updatedAt: new Date().toISOString()
      };

      // Если платеж успешный, отмечаем время покупки
      if (Success === true && (Status === 'CONFIRMED' || Status === 'AUTHORIZED')) {
        updateData.purchasedAt = new Date().toISOString();
        updateData.delivered = true;
        
        // Также добавляем товар в список купленных товаров пользователя
        await this.addProductToUserCollection(userId, orderId);
      }

      await userPurchaseRef.update(updateData);

      console.log(`✅ Статус покупки обновлен: ${userId}/${orderId}, Status: ${Status}`);
    } catch (error) {
      console.error('❌ Ошибка обновления статуса покупки:', error);
      throw error;
    }
  }

  /**
   * Добавляем товар в коллекцию купленных товаров пользователя
   */
  static async addProductToUserCollection(userId, orderId) {
    try {
      // Получаем информацию о покупке
      const purchaseRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('purchases')
        .doc(orderId);
      
      const purchaseDoc = await purchaseRef.get();
      
      if (!purchaseDoc.exists) {
        throw new Error(`Покупка ${orderId} не найдена`);
      }

      const purchaseData = purchaseDoc.data();
      const { productId, productName, amount } = purchaseData;

      // Добавляем в коллекцию купленных товаров
      const purchasedProductRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('purchasedProducts')
        .doc(productId);

      await purchasedProductRef.set({
        productId,
        productName,
        amount,
        purchaseDate: new Date().toISOString(),
        lastDownloaded: null,
        downloadCount: 0,
        downloadLimit: purchaseData.downloadLimit || 3,
        orderId,
        status: 'active'
      }, { merge: true });

      // Обновляем статистику пользователя
      await this.updateUserStats(userId, amount);

      console.log(`✅ Товар ${productId} добавлен в коллекцию пользователя ${userId}`);
    } catch (error) {
      console.error('❌ Ошибка добавления товара в коллекцию:', error);
      throw error;
    }
  }

  /**
   * Обновляем статистику пользователя
   */
  static async updateUserStats(userId, amount) {
    try {
      const userRef = db.collection('telegramUsers').doc(userId.toString());
      
      await userRef.update({
        totalSpent: firebase.firestore.FieldValue.increment(amount),
        totalPurchases: firebase.firestore.FieldValue.increment(1),
        lastPurchaseDate: new Date().toISOString(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error('❌ Ошибка обновления статистики:', error);
    }
  }

  /**
   * Получаем все покупки пользователя
   */
  static async getUserPurchases(userId) {
    try {
      const purchasesRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('purchases');
      
      const snapshot = await purchasesRef.get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('❌ Ошибка получения покупок:', error);
      throw error;
    }
  }

  /**
   * Получаем купленные товары пользователя
   */
  static async getUserPurchasedProducts(userId) {
    try {
      const purchasedProductsRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('purchasedProducts');
      
      const snapshot = await purchasedProductsRef.get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('❌ Ошибка получения купленных товаров:', error);
      throw error;
    }
  }

  /**
   * Проверяем, купил ли пользователь товар
   */
  static async hasUserPurchasedProduct(userId, productId) {
    try {
      const purchasedProductRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('purchasedProducts')
        .doc(productId);
      
      const doc = await purchasedProductRef.get();
      return doc.exists;
    } catch (error) {
      console.error('❌ Ошибка проверки покупки:', error);
      return false;
    }
  }

  /**
   * Увеличиваем счетчик скачиваний
   */
  static async incrementDownloadCount(userId, productId) {
    try {
      const purchasedProductRef = db.collection('telegramUsers')
        .doc(userId.toString())
        .collection('purchasedProducts')
        .doc(productId);
      
      const doc = await purchasedProductRef.get();
      
      if (!doc.exists) {
        throw new Error('Товар не найден в покупках пользователя');
      }

      const productData = doc.data();
      const newCount = (productData.downloadCount || 0) + 1;

      // Проверяем лимит скачиваний
      if (newCount > (productData.downloadLimit || 3)) {
        throw new Error('Лимит скачиваний исчерпан');
      }

      await purchasedProductRef.update({
        downloadCount: newCount,
        lastDownloaded: new Date().toISOString(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      return newCount;
    } catch (error) {
      console.error('❌ Ошибка увеличения счетчика скачиваний:', error);
      throw error;
    }
  }
}

module.exports = PurchaseService;
