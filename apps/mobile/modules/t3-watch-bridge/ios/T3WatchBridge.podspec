Pod::Spec.new do |s|
  s.name = 'T3WatchBridge'
  s.version = '1.0.0'
  s.summary = 'Durable Watch capture inbox for T3 Code.'
  s.description = 'Launch-time WatchConnectivity receiver and Expo bridge.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platforms = { :ios => '18.0' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WatchConnectivity', 'CryptoKit'
  s.source_files = '*.swift', 'Shared/*.swift'
end
