Pod::Spec.new do |s|
  s.name           = 'T3AgentNotifications'
  s.version        = '1.0.0'
  s.summary        = 'Native agent notification handling for T3 Code mobile.'
  s.description    = 'Removes delivered agent alerts when the relay reports their thread was read.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
