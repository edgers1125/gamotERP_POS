// Metro config for the GamotERP POS app. The app shares pure TypeScript with the backend
// (C:\Users\ejnav\Desktop\GamotERP\backend\src — pricing, discounts, business day, invoice numbers, the POS API contract),
// imported as `@shared/<file>` (backend/src/lib/<file>.ts) and `@pos-api/<file>` (backend/src/pos-api/<file>.ts).
// Those files use Node-style `./x.js` specifiers for sibling .ts files, so .js is mapped back to .ts for them.
const path = require('path');
const fs = require('fs');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const BACKEND_SRC = path.resolve(__dirname, '../GamotERP/backend/src');

config.watchFolders = [...(config.watchFolders ?? []), BACKEND_SRC];

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const alias = moduleName.startsWith('@shared/')
    ? path.join(BACKEND_SRC, 'lib', moduleName.slice('@shared/'.length))
    : moduleName.startsWith('@pos-api/')
      ? path.join(BACKEND_SRC, 'pos-api', moduleName.slice('@pos-api/'.length))
      : null;
  if (alias) return { type: 'sourceFile', filePath: alias.endsWith('.ts') ? alias : `${alias}.ts` };
  if (context.originModulePath.startsWith(BACKEND_SRC) && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const candidate = path.resolve(path.dirname(context.originModulePath), moduleName.replace(/\.js$/, '.ts'));
    if (fs.existsSync(candidate)) return { type: 'sourceFile', filePath: candidate };
  }
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
