require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoK8sMtls'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = ''
  s.homepage       = 'https://example.local'
  s.platforms      = { :ios => '16.4', :tvos => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # libz is needed for SPDY/3 NV header block compression (used inside the
  # tunnelled WS port-forward protocol). Apple ships zlib at /usr/lib/libz
  # on iOS; we use @_silgen_name bindings in Zlib.swift to call into it.
  s.library = 'z'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
