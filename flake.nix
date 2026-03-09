{
  description = "Kiwi Shell for Hyprland";

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
    pname = "kiwi";
    entry = "src/kiwi-shell/app.ts";

    # ─── app-capture C library ───────────────────────────────────────────────
    # Compiles app-capture.c into libappcapture.so and generates the
    # AppCapture-1.0.typelib that GJS imports via  gi://AppCapture
    app-capture = pkgs.stdenv.mkDerivation {
      pname = "app-capture";
      version = "1.0";

      src = ./src/app-capture;

      nativeBuildInputs = with pkgs; [
        meson
        ninja
        pkg-config                  # needed so meson can find all deps
        wayland-scanner             # generates C bindings from XML protocols
        gobject-introspection       # provides g-ir-scanner + g-ir-compiler
        wrapGAppsHook4
      ];

      buildInputs = with pkgs; [
        wayland                     # wayland-client (pkg name in nixpkgs)
        wayland-protocols           # the XML protocol definitions
        gtk4                        # gtk4 runtime
        gtk4.dev                    # gdk-wayland-4.0 pkg-config file lives here
        glib                        # gobject-2.0
        glib.dev                    # pkg-config files for gobject-2.0
      ];
    };

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
        app-capture
      ];

    # ─── Kiwi Shell package ───────────────────────────────────────────────
    kiwi-package = pkgs.stdenv.mkDerivation {
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
          pkgs.glib.bin
          pkgs.quicksand
          pkgs.whitesur-icon-theme
          pkgs.whitesur-gtk-theme
        ]}" \
          --prefix GI_TYPELIB_PATH : "${app-capture}/lib/girepository-1.0" \
          --prefix LD_LIBRARY_PATH : "${app-capture}/lib"

        # Logging Wrapper
        cat << 'EOF' > $out/bin/${pname}
        #!/usr/bin/env bash
        LOG_FILE="$HOME/.cache/kiwi-shell.log"
        mkdir -p "$(dirname "$LOG_FILE")"
        echo "--- Starting Kiwi Shell at $(date) ---" | tee -a "$LOG_FILE"
        BIN_PATH_PLACEHOLDER "$@" 2>&1 | tee -a "$LOG_FILE"
        EOF

        sed -i "s|BIN_PATH_PLACEHOLDER|$out/bin/.${pname}-core|" $out/bin/${pname}
        chmod +x $out/bin/${pname}

        # Controller Script
        echo "#!${pkgs.bash}/bin/bash" > $out/bin/${pname}ctl
        echo "exec ${ags.packages.${system}.default}/bin/ags request \"\$@\"" >> $out/bin/${pname}ctl
        chmod +x $out/bin/${pname}ctl

        runHook postInstall
      '';
    };
  in {
    packages.${system} = {
      default = kiwi-package;
      app-capture = app-capture;
    };

    # ─── Dev shell ───────────────────────────────────────────────────────────
    # Enter with: nix develop
    devShells.${system}.default = pkgs.mkShell {
      buildInputs = [
        (ags.packages.${system}.default.override {
          inherit extraPackages;
        })
        pkgs.nodejs
        pkgs.pkg-config
        pkgs.wayland-scanner
        pkgs.wayland-protocols
        pkgs.wayland
        pkgs.gtk4
        pkgs.glib
        pkgs.gobject-introspection
        pkgs.meson
        pkgs.ninja
        pkgs.gjs
      ];
    };

    homeManagerModules.default = {
      config,
      lib,
      pkgs,
      ...
    }: let
      cfg = config.services.kiwi-shell;
    in {
      options.services.kiwi-shell = {
        enable = lib.mkEnableOption "Kiwi Shell for Hyprland";

        settings = lib.mkOption {
          description = "Configuration written to ~/.config/kiwi-shell/initial-config.json";
          default = {};
          type = lib.types.submodule {
            options = {
              primary_color = lib.mkOption {
                type = lib.types.str;
                default = "rgb(190,157,241)";
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
        xdg.configFile."kiwi-shell/initial-config.json".text = builtins.toJSON cfg.settings;
        home.packages = [self.packages.${system}.default];
      };
    };
  };
}