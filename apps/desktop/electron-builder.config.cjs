// electron-builder entry point. The config itself lives in build/builder-config.cjs (env-driven, unit-tested).
module.exports = require('./build/builder-config.cjs').buildConfig(process.env);
