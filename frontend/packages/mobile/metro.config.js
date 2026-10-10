// The app imports the shared SDK and generated backend types from sibling packages
// (aliases in tsconfig.json). Metro must watch those folders to bundle them.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../sdk/src'), path.resolve(__dirname, '../types/src'), path.resolve(__dirname, '../brand/src')];

module.exports = config;
