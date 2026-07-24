/**
 * PM2 ecosystem config for Lantern Garage
 * Provides process supervision, auto-restart, log rotation, and graceful reload.
 *
 * Usage:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup   (follow output to enable auto-start on boot)
 *
 * Update & restart (from update-checker or /api/actions/update):
 *   pm2 restart lantern-garage
 */
module.exports = {
  apps: [{
    name: "lantern-garage",
    script: "./server.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    max_memory_restart: "512M",
    restart_delay: 3000,
    max_restarts: 10,
    min_uptime: "10s",
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 8000,
    env: {
      NODE_ENV: "development",
      PORT: 4177
    },
    env_production: {
      NODE_ENV: "production",
      PORT: 4177
    },
    log_file: "./logs/combined.log",
    out_file: "./logs/out.log",
    error_file: "./logs/err.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    merge_logs: true,
    // Graceful shutdown: send SIGINT, wait 5s, then SIGKILL
    shutdown_with_message: true
  }]
};
