// Bungkus handler async agar error-nya mengalir ke errorHandler.
module.exports = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
