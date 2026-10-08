import CryptoKit
import ExpoModulesCore
import Foundation

/// Two file helpers the food model manager needs and expo-file-system lacks:
///  - streaming SHA-256 of multi-GB model files (off the JS thread, constant memory)
///  - marking files/folders "do not back up" so a 3 GB model never goes to iCloud.
public class FoodFileUtilsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FoodFileUtils")

    AsyncFunction("sha256File") { (uri: String) throws -> String in
      let url = try Self.fileURL(uri)
      let handle = try FileHandle(forReadingFrom: url)
      defer { try? handle.close() }
      var hasher = SHA256()
      while true {
        let chunk: Data? = try autoreleasepool { try handle.read(upToCount: 8 * 1024 * 1024) }
        guard let data = chunk, !data.isEmpty else { break }
        hasher.update(data: data)
      }
      return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    AsyncFunction("setExcludedFromBackup") { (uri: String, excluded: Bool) throws -> Bool in
      var url = try Self.fileURL(uri)
      var values = URLResourceValues()
      values.isExcludedFromBackup = excluded
      try url.setResourceValues(values)
      let check = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
      return check.isExcludedFromBackup ?? false
    }
  }

  private static func fileURL(_ uri: String) throws -> URL {
    if let url = URL(string: uri), url.isFileURL { return url }
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    throw NSError(domain: "FoodFileUtils", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not a file URI: \(uri)"])
  }
}
