// PM2 process config — keeps the server alive 24/7 and restarts on crash/reboot.
// Start with:  pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "tradescope",
      script: "server.js",
      autorestart: true,
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        // VPS has no Claude Max login → skip Claude, use keyword sentiment.
        // (Set to "1" only on a machine where `claude` CLI is logged in.)
        ENABLE_CLAUDE: "0",
        // Optional: move the Finnhub key out of code into env.
        // FINNHUB_KEY: "your_finnhub_key_here",
      },
    },
  ],
};
