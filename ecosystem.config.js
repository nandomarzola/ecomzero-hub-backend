module.exports = {
  apps: [
    {
      name:               'profittrack-api',
      script:             'src/app.js',
      cwd:                '/var/www/html/nm_services/profittrack-backend',
      instances:          1,
      autorestart:        true,
      watch:              false,
      max_memory_restart: '300M',
      error_file:         '/var/www/html/nm_services/profittrack-backend/logs/pm2-error.log',
      out_file:           '/var/www/html/nm_services/profittrack-backend/logs/pm2-out.log',
      log_date_format:    'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV:   'development',
        PORT:       3333,
      },
      env_production: {
        NODE_ENV:   'production',
        PORT:       3333,
      },
    },
  ],
};
