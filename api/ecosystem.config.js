module.exports = {
  apps: [
    {
      name: 'workshop-api',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
