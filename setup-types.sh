#!/usr/bin/env bash

# Sets up TypeScript type symlinks and generates GObject introspection types
# for editor support. Run once after cloning, or after updating ags.
set -e

AGS_JS="$(dirname $(dirname $(which ags)))/share/ags/js"

mkdir -p node_modules
rm -rf node_modules/ags node_modules/gnim
ln -s "$AGS_JS" node_modules/ags
ln -s "$AGS_JS/node_modules/gnim" node_modules/gnim

ags types -d ./

echo "Done. Restart the TS server in your editor."