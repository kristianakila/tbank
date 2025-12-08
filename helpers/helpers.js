/**
 * Форматирование суммы
 */
function formatAmount(amountInKopecks) {
  return amountInKopecks / 100;
}

/**
 * Проверка email
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Создание уникального ID
 */
function generateUniqueId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Проверка, является ли дата будущей
 */
function isFutureDate(date) {
  return new Date(date) > new Date();
}

/**
 * Добавление месяцев к дате
 */
function addMonths(date, months) {
  const newDate = new Date(date);
  newDate.setMonth(newDate.getMonth() + months);
  return newDate;
}

module.exports = {
  formatAmount,
  isValidEmail,
  generateUniqueId,
  isFutureDate,
  addMonths
};
