import { requireOptionalNativeModule } from 'expo';

/**
 * Local Expo module (iOS): streaming SHA-256 + iCloud backup exclusion for
 * downloaded model files. `null` when the native side isn't linked (Expo Go,
 * web, a build made before `expo prebuild` picked the module up).
 */
interface FoodFileUtilsNative {
  sha256File(uri: string): Promise<string>;
  setExcludedFromBackup(uri: string, excluded: boolean): Promise<boolean>;
}

export const FoodFileUtils = requireOptionalNativeModule<FoodFileUtilsNative>('FoodFileUtils');
