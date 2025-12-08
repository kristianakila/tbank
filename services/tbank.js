const TbankPayments = require('tbank-payments');

const tbank = new TbankPayments({
  merchantId: process.env.TBANK_MERCHANT_ID,
  secret: process.env.TBANK_SECRET,
  apiUrl: process.env.TBANK_API_URL
});

module.exports = tbank;
