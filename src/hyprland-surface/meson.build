project('kiwi-surface', 'c',
  version: '1.0.0',
  default_options: ['c_std=c11'],
)

gnome = import('gnome')

gtk4_dep    = dependency('gtk4', version: '>= 4.12')
wayland_dep = dependency('wayland-client')
cc          = meson.get_compiler('c')
m_dep       = cc.find_library('m', required: false)

wayland_scanner = find_program('wayland-scanner')

# hyprland-surface (hyprwm/hyprland-protocols), version 2 for the visible region
proto_xml = files('protocols/hyprland-surface-v1.xml')

proto_header = custom_target('proto-header',
  input:   proto_xml,
  output:  'hyprland-surface-v1-protocol.h',
  command: [wayland_scanner, 'client-header', '@INPUT@', '@OUTPUT@'],
)

proto_code = custom_target('proto-code',
  input:   proto_xml,
  output:  'hyprland-surface-v1-protocol.c',
  command: [wayland_scanner, 'private-code', '@INPUT@', '@OUTPUT@'],
)

lib = shared_library('kiwi-surface',
  'kiwi-surface.c',
  proto_code,
  proto_header,
  include_directories: include_directories('.'),
  dependencies: [gtk4_dep, wayland_dep, m_dep],
  install: true,
)

install_headers('kiwi-surface.h')

# GObject introspection, so GJS can import the library
gnome.generate_gir(lib,
  sources:      ['kiwi-surface.c', 'kiwi-surface.h'],
  namespace:    'KiwiSurface',
  nsversion:    '1.0',
  symbol_prefix: 'kiwi_surface',
  identifier_prefix: 'KiwiSurface',
  includes:     ['Gdk-4.0', 'cairo-1.0'],
  dependencies: [gtk4_dep, wayland_dep],
  install:      true,
)
