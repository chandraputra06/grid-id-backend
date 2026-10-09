const ApiError = require('../utils/apiError');

function notFound(req, res, next) {
  next(new ApiError(404, 'not_found', `Rute tidak ditemukan: ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'internal_error';
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    ok: false,
    error: { code, message: err.message || 'Terjadi kesalahan' },
  });
}

module.exports = { notFound, errorHandler };
