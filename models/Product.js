// models/Product.js
const productsData = require('../data/prognosesData.json');

class Product {
  static async getAllProducts() {
    return productsData;
  }

  static async getProductById(id) {
    return productsData.find(product => product.id === id);
  }

  static async validateProduct(productId) {
    const product = await this.getProductById(productId);
    if (!product) {
      throw new Error(`Товар с ID ${productId} не найден`);
    }
    return product;
  }
}

module.exports = Product;
