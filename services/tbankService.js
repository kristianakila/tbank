const TbankPayments = require('tbank-payments');
require('dotenv').config();

let tbankInstance = null;

/**
 * Инициализация T-Bank клиента
 */
function initializeTbank() {
  if (tbankInstance) {
    return tbankInstance;
  }
  
  tbankInstance = new TbankPayments({
    merchantId: process.env.TBANK_MERCHANT_ID,
    secret: process.env.TBANK_SECRET,
    apiUrl: process.env.TBANK_API_URL
  });
  
  console.log('✅ T-Bank клиент инициализирован');
  return tbankInstance;
}

/**
 * Получить экземпляр T-Bank клиента
 */
function getTbankInstance() {
  if (!tbankInstance) {
    return initializeTbank();
  }
  return tbankInstance;
}

module.exports = {
  initializeTbank,
  getTbankInstance
};
