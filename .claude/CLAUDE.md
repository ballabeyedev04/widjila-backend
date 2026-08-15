# Backend - Node.js Express API

## Project Overview
Backend API for the "Suivi Chantier" (Construction Site Tracking) application. Built with Node.js, Express, and Sequelize ORM.

## Technology Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL (via Sequelize ORM)
- **Authentication**: JWT (jsonwebtoken)
- **Validation**: express-validator
- **Logging**: Winston
- **Process Manager**: PM2 (ecosystem.config.js)
- **Containerization**: Docker / Docker Compose

## Project Structure
```
backend/
├── src/
│   ├── app.js                 # Express app configuration
│   ├── server.js              # Entry point
│   ├── config/                # Configuration files (DB, env, etc.)
│   ├── middlewares/           # Express middlewares (auth, error handling, etc.)
│   ├── models/                # Sequelize models
│   ├── modules/               # Feature modules (controllers, routes, services)
│   ├── utils/                 # Utility functions
│   ├── validations/           # Validation schemas
│   ├── errors/                # Custom error classes
│   ├── jobs/                  # Background jobs (cron, queue workers)
│   ├── migrations/            # Database migrations
│   ├── seeders/               # Database seeders
│   └── templates/             # Email/notification templates
├── public/                    # Static files
├── uploads/                   # File uploads
├── logs/                      # Application logs
├── deploy/                    # Deployment scripts
├── scripts/                   # Utility scripts
├── .env                       # Environment variables
├── .env.example               # Example environment variables
├── package.json               # Dependencies
├── docker-compose.yml         # Development Docker Compose
├── docker-compose.prod.yml    # Production Docker Compose
├── Dockerfile                 # Docker image definition
└── ecosystem.config.js        # PM2 configuration
```

## Development Commands

### Install Dependencies
```bash
cd /c/Users/vPro/Desktop/suivie_chantier/backend
npm install
```

### Start Development Server
```bash
npm run dev
# or
npx nodemon src/server.js
```

### Start Production Server
```bash
npm start
# or with PM2
npx pm2 start ecosystem.config.js
```

### Database Operations
```bash
# Run migrations
npx sequelize-cli db:migrate

# Run seeders
npx sequelize-cli db:seed:all

# Create migration
npx sequelize-cli migration:generate --name migration-name

# Create seeder
npx sequelize-cli seed:generate --name seeder-name
```

### Linting & Formatting
```bash
npm run lint
npm run format
```

### Testing
```bash
npm test
npm run test:watch
npm run test:coverage
```

### Docker Commands
```bash
# Development
docker-compose up -d

# Production
docker-compose -f docker-compose.prod.yml up -d

# Build images
docker-compose build
```

## Environment Variables
Key variables in `.env`:
- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 3000)
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` - PostgreSQL connection
- `JWT_SECRET` - JWT signing secret
- `JWT_EXPIRES_IN` - Token expiration
- `CORS_ORIGIN` - Allowed CORS origins
- `LOG_LEVEL` - Winston log level

## API Architecture

### Module Structure
Each feature module in `src/modules/` follows:
```
module-name/
├── controller.js      # Request handlers
├── routes.js          # Route definitions
├── service.js         # Business logic
├── validation.js      # Input validation
└── index.js           # Module exports
```

### Authentication Flow
1. User logs in via `/api/auth/login`
2. Server validates credentials, returns JWT access + refresh tokens
3. Access token sent in `Authorization: Bearer <token>` header
4. `authenticate` middleware validates token on protected routes
5. Refresh token used via `/api/auth/refresh` to get new access token

### Error Handling
- Custom error classes in `src/errors/`
- Global error handler middleware in `src/middlewares/errorHandler.js`
- Standardized error response format:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": {}
  }
}
```

## Available Skills (in `.claude/skills/`)
- **vercel-optimize** - Performance optimization for Node.js/Express
- **web-design-guidelines** - API design best practices
- **writing-guidelines** - Documentation and comment standards
- **vercel-composition-patterns** - Code composition patterns

## Key Files to Know
- `src/app.js` - Main Express setup, middleware registration
- `src/server.js` - Entry point, server startup
- `src/config/database.js` - Sequelize configuration
- `src/middlewares/auth.js` - JWT authentication middleware
- `src/middlewares/errorHandler.js` - Global error handling
- `ecosystem.config.js` - PM2 process configuration

## Common Tasks

### Adding a New Module
1. Create folder in `src/modules/feature-name/`
2. Create `controller.js`, `service.js`, `routes.js`, `validation.js`
3. Register routes in `src/app.js` or main router
4. Add any new models to `src/models/`
5. Run migrations if schema changes

### Adding a Migration
```bash
npx sequelize-cli migration:generate --name add-field-to-table
# Edit the generated file in src/migrations/
npx sequelize-cli db:migrate
```

### Debugging
- Check logs in `logs/` directory
- Use `npm run dev` with nodemon for auto-reload
- Set `DEBUG=*` for verbose logging

## Deployment Checklist
- [ ] Environment variables set in production
- [ ] Database migrations run
- [ ] PM2 ecosystem configured
- [ ] Docker image builds successfully
- [ ] Health check endpoint responds (`/health`)
- [ ] SSL/TLS configured
- [ ] Backup strategy for database