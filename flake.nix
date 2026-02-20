{
  description = "Desktop Shell for Hyprland";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";

    ags = {
      url = "github:aylur/ags";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    ags,
  }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
    pname = "desktop";
    entry = "app.ts";

    astalPackages = with ags.packages.${system}; [
      io
      astal4
      battery
      network
      hyprland
      wireplumber
      mpris
      powerprofiles
      bluetooth
      tray
    ];

    extraPackages =
      astalPackages
      ++ [
        # --- Libraries ---
        pkgs.libadwaita
        pkgs.libsoup_3
       
        # --- Fonts ---
        pkgs.quicksand

      ];
  in {
    packages.${system} = {
      default = pkgs.stdenv.mkDerivation {
        name = "desktop";
        version = "0.2";
        src = pkgs.lib.cleanSource ./.;

        nativeBuildInputs = with pkgs; [
          wrapGAppsHook4
          gobject-introspection
          ags.packages.${system}.default
          makeWrapper # Required for wrapProgram
        ];

        buildInputs = extraPackages ++ [ pkgs.gjs ];

        installPhase = ''
          runHook preInstall

          mkdir -p $out/bin
          mkdir -p $out/share
          cp -r * $out/share

          rm -rf $out/share/node_modules
          rm -rf $out/share/.git

          # --- Step 1: Compile the Main App ---
          # We bundle it into a hidden file first (e.g., .desktop-core) [cite: 11]
          ags bundle ${entry} $out/bin/.${pname}-core -d "SRC='$out/share'"

          # --- Step 2: Wrap the App ---
          # Wrap the hidden binary with the necessary dependencies [cite: 11, 12]
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

          # --- Step 3: Create the Logging Wrapper ---
          # This becomes the main executable your system runs.
          # It safely redirects all stdout and stderr to a log file.
          cat << 'EOF' > $out/bin/${pname}
          #!/usr/bin/env bash
          LOG_FILE="$HOME/.cache/hyprland-desktop.log"
          
          # Ensure the directory exists
          mkdir -p "$(dirname "$LOG_FILE")"
          
          echo "--- Starting Desktop Shell at $(date) ---" >> "$LOG_FILE"
          
          # Execute the actual AGS app and push all output to the log
          exec BIN_PATH_PLACEHOLDER "$@" >> "$LOG_FILE" 2>&1
          EOF
          
          # Replace the placeholder with the exact Nix store path
          sed -i "s|BIN_PATH_PLACEHOLDER|$out/bin/.${pname}-core|" $out/bin/${pname}
          chmod +x $out/bin/${pname}

          # --- Step 4: Create the Controller Script ---
          # Preserved exactly as you had it [cite: 12, 13]
          echo "#!${pkgs.bash}/bin/bash" > $out/bin/${pname}-ctl
          echo "exec ${ags.packages.${system}.default}/bin/ags request \"\$@\"" >> $out/bin/${pname}-ctl
          chmod +x $out/bin/${pname}-ctl

          runHook postInstall
        '';
      };
    };

    devShells.${system} = {
      default = pkgs.mkShell {
        buildInputs = [
          (ags.packages.${system}.default.override {
            inherit extraPackages;
          })
          pkgs.nodejs
        ];
      };
    };
  };
}
