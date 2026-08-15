const path = require('path');
const fs = require('fs');
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize, errors } = format;

const isProd = process.env.NODE_ENV === 'production';

// Dossier de logs : LOG_DIR depuis .env, sinon <racine_projet>/logs
const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.resolve(__dirname, '..', '..', 'logs');

if (isProd && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack }) =>
    stack
      ? `${timestamp} ${level}: ${message}\n${stack}`
      : `${timestamp} ${level}: ${message}`
  )
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  format.json()
);

const loggerTransports = [new transports.Console()];

if (isProd) {
  // Rotation journalière non requise ici : PM2 gère sa propre rotation via pm2-logrotate
  // On écrit quand même les fichiers pour grep/tail rapide hors PM2
  loggerTransports.push(
    new transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'app.log'),
      maxsize: 20 * 1024 * 1024, // 20 MB
      maxFiles: 10,
      tailable: true,
    })
  );
}

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  format: isProd ? prodFormat : devFormat,
  transports: loggerTransports,
});

module.exports = logger;
