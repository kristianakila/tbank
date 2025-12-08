// models/Order.js
const { getDatabase } = require('../config/firebase');
const db = getDatabase();

class Order {
  static async createOrder(orderData) {
    const {
      userId,
      productId,
      orderId,
      paymentId,
      amount,
      status = 'pending',
      type = 'product_purchase'
    } = orderData;

    const orderRef = db.collection('orders').doc(orderId);
    
    const order = {
      userId,
      productId,
      orderId,
      paymentId,
      amount,
      status,
      type,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await orderRef.set(order);
    return order;
  }

  static async updateOrder(orderId, updateData) {
    const orderRef = db.collection('orders').doc(orderId);
    await orderRef.update({
      ...updateData,
      updatedAt: new Date().toISOString()
    });
  }

  static async getOrderById(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    const doc = await orderRef.get();
    return doc.exists ? doc.data() : null;
  }

  static async getOrdersByUserId(userId) {
    const ordersRef = db.collection('orders').where('userId', '==', userId);
    const snapshot = await ordersRef.get();
    return snapshot.docs.map(doc => doc.data());
  }

  static async getUserOrders(userId) {
    const userOrdersRef = db.collection('telegramUsers')
      .doc(userId)
      .collection('orders');
    const snapshot = await userOrdersRef.get();
    return snapshot.docs.map(doc => doc.data());
  }
}

module.exports = Order;
