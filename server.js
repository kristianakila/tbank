const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Импортируем роуты
const initRecurrentRoute = require('./routes/initRecurrent');
const runPaymentRoute = require('./routes/runPayment');

// Маршруты
app.use('/api/init-recurrent', initRecurrentRoute);
app.use('/api/run-payment', runPaymentRoute);

// Проверка работоспособности сервера
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

app.get('/', (req, res) => {
  res.json({
    message: 'T-Bank Payment Server',
    endpoints: [
      'POST /api/init-recurrent',
      'POST /api/run-payment',
      'GET /health'
    ]
  });
});

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
