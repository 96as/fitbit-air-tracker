Pod::Spec.new do |s|
  s.name           = 'FoodFileUtils'
  s.version        = '1.0.0'
  s.summary        = 'SHA-256 of large files + iCloud-backup exclusion for downloaded on-device models'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'SmartWake'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
