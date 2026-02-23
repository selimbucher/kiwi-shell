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
      apps
    ];

    extraPackages =
      astalPackages
      ++ [
        pkgs.libadwaita
        pkgs.libsoup_3
        pkgs.quicksand
        pkgs.grimblast
      ];

    # packet definition
    desktop-package = pkgs.stdenv.mkDerivation {
      name = pname;
      version = "0.2";
      src = pkgs.lib.cleanSource ./.;

      nativeBuildInputs = with pkgs; [
        wrapGAppsHook4
        gobject-introspection
        ags.packages.${system}.default
        makeWrapper
      ];

      buildInputs = extraPackages ++ [pkgs.gjs];

      installPhase = ''
        runHook preInstall

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

        runHook postInstall
      '';
    };
  in {
    # the actual package
    packages.${system}.default = desktop-package;

    # the development shell
    devShells.${system}.default = pkgs.mkShell {
      buildInputs = [
        (ags.packages.${system}.default.override {
          inherit extraPackages;
        })
        pkgs.nodejs
      ];
    };

    # module for the deterministic config
    homeManagerModules.default = {
      config,
      lib,
      pkgs,
      ...
    }: let
      cfg = config.services.desktop-shell;
    in {
      options.services.desktop-shell = {
        enable = lib.mkEnableOption "Desktop Shell for Hyprland";

        settings = lib.mkOption {
          description = "Configuration written to ~/.config/desktop/config.json";
          default = {};
          type = lib.types.submodule {
            options = {
              primary_color = lib.mkOption {
                type = lib.types.str;
                default = "rgb(169,206,195)";
              };
              bottom_margin = lib.mkOption {
                type = lib.types.int;
                default = 4;
              };
              theme = lib.mkOption {
                type = lib.types.str;
                default = "default";
              };
            };
          };
        };
      };

      config = lib.mkIf cfg.enable {
        # create the config
        xdg.configFile."desktop/config.json".text = builtins.toJSON cfg.settings;

        home.packages = [self.packages.${system}.default];
      };
    };
  };
}