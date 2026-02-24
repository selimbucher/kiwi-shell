mkdir -p $out/bin
mkdir -p $out/share
cp -r * $out/share

rm -rf $out/share/node_modules
rm -rf $out/share/.git

# Compilation
ags bundle ${entry} $out/bin/.${pname}-core -d "SRC='$out/share'"

# Runtime Dependencies Wrapper
wrapProgram $out/bin/.${pname}-core \
    --prefix PATH : "${pkgs.lib.makeBinPath [
    pkgs.swww
    pkgs.hyprsunset
    pkgs.brightnessctl
    pkgs.zenity
    pkgs.imagemagick
    pkgs.sox
    pkgs.psmisc
]}"

# Logging Wrapper
cat << 'EOF' > $out/bin/${pname}
#!/usr/bin/env bash
LOG_FILE="$HOME/.cache/hyprland-desktop.log"
mkdir -p "$(dirname "$LOG_FILE")"
echo "--- Starting Desktop Shell at $(date) ---" | tee -a "$LOG_FILE"
BIN_PATH_PLACEHOLDER "$@" 2>&1 | tee -a "$LOG_FILE"
EOF

sed -i "s|BIN_PATH_PLACEHOLDER|$out/bin/.${pname}-core|" $out/bin/${pname}
chmod +x $out/bin/${pname}

# Controller Script
echo "#!${pkgs.bash}/bin/bash" > $out/bin/${pname}-ctl
echo "exec ${ags.packages.${system}.default}/bin/ags request \"\$@\"" >> $out/bin/${pname}-ctl
chmod +x $out/bin/${pname}-ctl