require('dotenv').config();

const config = {
  // Настройки сервера
  server: {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  
  // Настройки T-Bank API
  tbank: {
    apiUrl: process.env.TBANK_API_URL || 'https://api.tbank.ru',
    apiKey: process.env.TBANK_API_KEY,
    terminalKey: process.env.TBANK_TERMINAL_KEY,
    secretKey: process.env.TBANK_SECRET_KEY,
    // Для тестового окружения
    testApiUrl: process.env.TBANK_TEST_API_URL || 'https://rest-api-test.tbank.ru',
    testApiKey: process.env.TBANK_TEST_API_KEY,
    testTerminalKey: process.env.TBANK_TEST_TERMINAL_KEY,
    testSecretKey: process.env.TBANK_TEST_SECRET_KEY,
  },
  
  // Безопасность
  security: {
    corsOrigin: process.env.CORS_ORIGIN || '*',
    rateLimitWindowMs: 15 * 60 * 1000, // 15 минут
    rateLimitMax: 100, // лимит запросов за период
  },
  
  // Проверка конфигурации
  validate: function() {
    const required = ['TBANK_API_KEY', 'TBANK_TERMINAL_KEY', 'TBANK_SECRET_KEY'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      console.error('Отсутствуют обязательные переменные окружения:', missing);
      process.exit(1);
    }
    
    console.log('Конфигурация загружена успешно');
    console.log(`Режим: ${this.server.nodeEnv}`);
    console.log(`API URL: ${this.tbank.apiUrl}`);
  }
};

module.exports = config;
