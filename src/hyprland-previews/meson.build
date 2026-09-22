project('kiwi-previews', 'cpp',
  version: '0.1.0',
  default_options: ['cpp_std=c++23', 'buildtype=release']
)

# The plugin is only loadable into the Hyprland whose headers it was built
# against, so build it against the installed one and again after every
# Hyprland update.
hyprland = dependency('hyprland')

shared_module('kiwi-previews', 'main.cpp',
  dependencies: [hyprland],
  name_prefix: 'lib',
  install: true,
  install_dir: get_option('libdir') / 'kiwi-shell',
)
