const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const { db, admin } = require('./config/firebase');
const { restoreScheduledJobs } = require('./services/scheduler');
const webhookRouter = require('./routes/webhook');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ВАЖНО: raw body для T-Bank
app.use('/api/webhook', bodyParser.raw({ type: '*/*' }));

// Маршрут вебхуков
app.use('/api/webhook', webhookRouter);

// Восстанавливаем расписание
restoreScheduledJobs();

// Старт сервера
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
