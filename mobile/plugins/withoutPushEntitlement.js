// expo-notifications adds the `aps-environment` (remote push) entitlement.
// A free Apple ID (personal team) cannot sign it, and this app only uses
// LOCAL notifications (backup chain) — so strip it. Remove this plugin once
// the app is signed with a paid Apple Developer account and push is wanted.
// ORDER MATTERS: mods run in reverse plugin order, so this must be listed
// BEFORE expo-notifications in app.json (it is first) to run after it.
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment'];
    return cfg;
  });
};
