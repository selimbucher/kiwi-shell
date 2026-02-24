#!/usr/bin/env bash

set -e

PNAME="desktop"
ENTRY="app.ts"
INSTALL_DIR="$HOME/.local/share/$PNAME"
BIN_DIR="$HOME/.local/bin"

# 1. Dependency checks
if ! command -v jq &> /dev/null; then
    echo "jq is required to read dependencies.json. Please install jq first."
    exit 1
fi

echo "Reading dependencies from dependencies.json..."
PACMAN_DEPS=$(jq -r '.arch.pacman | join(" ")' dependencies.json)
AUR_DEPS=$(jq -r '.arch.aur | join(" ")' dependencies.json)

# 2. Install Dependencies (Arch specific implementation)
if command -v pacman &> /dev/null; then
    echo "Installing pacman dependencies..."
    sudo pacman -S --needed --noconfirm $PACMAN_DEPS

    if command -v yay &> /dev/null; then
        echo "Installing AUR dependencies via yay..."
        yay -S --needed --noconfirm $AUR_DEPS
    elif command -v paru &> /dev/null; then
        echo "Installing AUR dependencies via paru..."
        paru -S --needed --noconfirm $AUR_DEPS
    else
        echo "Warning: No AUR helper found (yay/paru). Please install the following manually: $AUR_DEPS"
    fi
else
    echo "Warning: Not on Arch Linux. Please ensure the following dependencies are installed:"
    echo "System: $PACMAN_DEPS"
    echo "AUR/AGS specific: $AUR_DEPS"
fi

# 3. Build & Install
echo "Setting up $PNAME..."

mkdir -p "$BIN_DIR"
mkdir -p "$INSTALL_DIR"

# Copy source assets
cp -r * "$INSTALL_DIR/"
rm -rf "$INSTALL_DIR/node_modules" "$INSTALL_DIR/.git"

# Compilation
echo "Bundling AGS..."
ags bundle "$ENTRY" "$BIN_DIR/.$PNAME-core" -d "SRC='$INSTALL_DIR'"

# Create Logging Wrapper
cat << EOF > "$BIN_DIR/$PNAME"
#!/usr/bin/env bash
LOG_FILE="\$HOME/.cache/hyprland-desktop.log"
mkdir -p "\$(dirname "\$LOG_FILE")"
echo "--- Starting Desktop Shell at \$(date) ---" | tee -a "\$LOG_FILE"
"$BIN_DIR/.$PNAME-core" "\$@" 2>&1 | tee -a "\$LOG_FILE"
EOF

chmod +x "$BIN_DIR/$PNAME"

# Create Controller Script
cat << EOF > "$BIN_DIR/$PNAME-ctl"
#!/usr/bin/env bash
exec ags request "\$@"
EOF

chmod +x "$BIN_DIR/$PNAME-ctl"

echo "Installation complete. Executables are in $BIN_DIR"