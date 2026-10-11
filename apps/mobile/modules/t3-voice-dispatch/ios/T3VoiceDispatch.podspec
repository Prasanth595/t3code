Pod::Spec.new do |s|
  s.name           = 'T3VoiceDispatch'
  s.version        = '1.0.0'
  s.summary        = 'Hands-free thread dispatch for T3 Code mobile.'
  s.description    = 'CarPlay voice screen, speech capture, and the bridge Siri intents use to start threads.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CarPlay', 'Speech'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
