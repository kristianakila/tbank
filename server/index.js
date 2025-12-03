const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');

// Инициализация приложения
const app = express();
const port = config.server.port;

// Middleware
app.use(helmet()); // Безопасность HTTP заголовков
app.use(cors({
  origin: config.security.corsOrigin,
  credentials: true,
}));
app.use(morgan('combined')); // Логирование
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ограничение запросов
const limiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.rateLimitMax,
  message: 'Слишком много запросов с вашего IP, попробуйте позже',
});
app.use('/api/', limiter);

// Маршруты
app.use('/api/payments', require('./routes/payments'));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'tbank-payment-server',
  });
});

// Обработка 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Маршрут не найден',
    path: req.path,
  });
});

// Глобальная обработка ошибок
app.use((err, req, res, next) => {
  console.error('Ошибка сервера:', err);
  
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Внутренняя ошибка сервера',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Запуск сервера
if (require.main === module) {
  // Валидация конфигурации
  config.validate();
  
  app.listen(port, () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    console.log(`📊 Health check: http://localhost:${port}/health`);
    console.log(`💳 Платежи API: http://localhost:${port}/api/payments`);
  });
}

module.exports = app;
