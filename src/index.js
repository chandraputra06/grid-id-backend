const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

// Routes
app.use('/api/health', require('./routes/health'));
app.use('/api/cuaca', require('./routes/cuaca'));
app.use('/api/assets', require('./routes/assets'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/prioritas', require('./routes/prioritas'));
app.use('/api/scan', require('./routes/scan'));

// 404 + error handler (harus paling bawah)
app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`GRID.ID backend jalan di http://localhost:${env.PORT}`);
  console.log(`Coba: http://localhost:${env.PORT}/api/health`);
});
