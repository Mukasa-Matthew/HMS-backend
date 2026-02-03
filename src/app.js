require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const { initDb } = require('./config/db');
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const roomRoutes = require('./routes/room.routes');
const hostelRoutes = require('./routes/hostel.routes');
const auditRoutes = require('./routes/audit.routes');
const studentRoutes = require('./routes/student.routes');
const paymentRoutes = require('./routes/payment.routes');
const semesterRoutes = require('./routes/semester.routes');
const checkInRoutes = require('./routes/checkin.routes');
const featureSettingsRoutes = require('./routes/feature-settings.routes');
const expenseRoutes = require('./routes/expense.routes');
const passwordResetRoutes = require('./routes/password-reset.routes');

const app = express();

// Core security middlewares (similar intent to Java EE security filters)
app.use(helmet());

// CORS configuration - always include Netlify URL
const getCorsOrigins = () => {
  const netlifyUrl = 'https://marthms.netlify.app';
  const defaultOrigins = [
    'http://localhost:3000',
    'http://localhost:4000',
    netlifyUrl,
  ];

  if (process.env.ALLOWED_ORIGINS) {
    const envOrigins = process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    // Merge and deduplicate, ensuring Netlify URL is always included
    const allOrigins = [...new Set([...envOrigins, ...defaultOrigins])];
    return allOrigins;
  }

  return defaultOrigins;
};

app.use(
  cors({
    origin: getCorsOrigins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
    ],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }),
);
app.use(morgan('dev'));
app.use(express.json());
app.use(cookieParser());

// Initialize database connection pool on startup
initDb()
  .then(() => {
    console.log('Database pool initialized');
  })
  .catch((err) => {
    console.error('Failed to initialize database pool', err);
    process.exit(1);
  });

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/hostels', hostelRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/semesters', semesterRoutes);
app.use('/api/check-ins', checkInRoutes);
app.use('/api/feature-settings', featureSettingsRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/password-reset', passwordResetRoutes);
app.use('/api/owner', studentRoutes); // Owner-specific endpoints

// Global error handler (similar to Java exception mappers)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  const message =
    status === 500 ? 'Internal server error' : err.message || 'Error';
  res.status(status).json({ error: message });
});

module.exports = app;

