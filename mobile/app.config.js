/**
 * Extends app.json at build time. Google iOS OAuth clients require the app to
 * own the URL scheme "com.googleusercontent.apps.<client-id-prefix>", which is
 * only known after you create the client — so it is read from mobile/.env
 * (EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID) and added here. Re-run `npx expo prebuild`
 * after changing it.
 */
function reversedClientId(clientId) {
  return `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, '')}`;
}

module.exports = ({ config }) => {
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const scheme = [config.scheme].flat().filter(Boolean);
  if (iosClientId && !scheme.includes(reversedClientId(iosClientId))) scheme.push(reversedClientId(iosClientId));
  return { ...config, scheme };
};
