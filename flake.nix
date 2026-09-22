{
  description = "Kiwi Shell for Hyprland";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";

    ags = {
      url = "github:aylur/ags";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # quarrel (the astal CLI parser) is newer than the astal stack pinned
    # through ags — pulled from its own input so the rest stays put
    astal-latest = {
      url = "github:aylur/astal";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    kiwi-settings = {
      url = "github:selimbucher/kiwi-settings";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      ags,
      astal-latest,
      kiwi-settings,
    }:
    let
      system = "x86_64-linux";
      pname = "kiwi";
      entry = "src/kiwi-shell/app.tsx";

      # Everything kiwi builds, from a nixpkgs and the Hyprland the session
      # runs. The plugin is compiled against Hyprland's internal headers and
      # refuses to load into any other build (main.cpp), so it has to come
      # from that exact package; the rest only speaks Wayland and IPC.
      # hyprlandPackage, not hyprland: the astal libraries below are taken
      # with `with`, and one of them is called hyprland
      kiwiFor =
        pkgs: hyprlandPackage:
        let
          # ─── hyprland-shortcuts C library ────────────────────────────────────────
          hyprland-shortcuts = pkgs.stdenv.mkDerivation {
            pname = "hyprland-shortcuts";
            version = "1.0";

            src = ./src/hyprland-shortcuts;

            nativeBuildInputs = with pkgs; [
              meson
              ninja
              pkg-config
              wayland-scanner
              gobject-introspection
              wrapGAppsHook4
            ];

            buildInputs = with pkgs; [
              wayland
              glib
              glib.dev
            ];
          };

          # ─── kiwi-surface C library ──────────────────────────────────────────────
          # Tells Hyprland which part of a layer surface is visible
          # (hyprland-surface-v1), so it blurs only that part.
          kiwi-surface = pkgs.stdenv.mkDerivation {
            pname = "kiwi-surface";
            version = "1.0";

            src = ./src/hyprland-surface;

            nativeBuildInputs = with pkgs; [
              meson
              ninja
              pkg-config
              wayland-scanner
              gobject-introspection
              wrapGAppsHook4
            ];

            buildInputs = with pkgs; [
              wayland
              gtk4
              glib
            ];
          };

          # ─── app-capture C library ───────────────────────────────────────────────
          app-capture = pkgs.stdenv.mkDerivation {
            pname = "app-capture";
            version = "1.0";

            src = ./src/app-capture;

            nativeBuildInputs = with pkgs; [
              meson
              ninja
              pkg-config
              wayland-scanner
              gobject-introspection
              wrapGAppsHook4
            ];

            buildInputs = with pkgs; [
              wayland
              wayland-protocols
              gtk4
              gtk4.dev
              glib
              glib.dev
              libgbm
              libdrm
            ];
          };

          # ─── geometry-events Hyprland plugin ─────────────────────────────────────
          # Posts windowgeometry>> on Hyprland's event socket when a window is
          # moved or resized, which Hyprland itself never announces; the dock's
          # auto-hide listens for it, and the shell loads it at start (hypr.ts).
          # See the header of main.cpp.
          hyprland-geometry-events = pkgs.hyprlandPlugins.mkHyprlandPlugin {
            hyprland = hyprlandPackage;
            pluginName = "geometry-events";
            version = "0.1.0";

            src = ./src/hyprland-geometry-events;

            nativeBuildInputs = with pkgs; [
              meson
              ninja
            ];

            meta = {
              description = "Hyprland plugin: announces window moves and resizes on the event socket";
              platforms = pkgs.lib.platforms.linux;
            };
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
            notifd
          ];

          extraPackages = astalPackages ++ [
            pkgs.libadwaita
            pkgs.libsoup_3
            astal-latest.packages.${system}.quarrel
            app-capture
            hyprland-shortcuts
            kiwi-surface
          ];

          # ─── Kiwi Shell package ───────────────────────────────────────────────
          kiwi-package = pkgs.stdenv.mkDerivation {
            name = pname;
            version = "0.4.0";
            src = pkgs.lib.cleanSource ./.;

            nativeBuildInputs = with pkgs; [
              wrapGAppsHook4
              gobject-introspection
              ags.packages.${system}.default
              makeWrapper
            ];

            buildInputs = extraPackages ++ [ pkgs.gjs ];

            installPhase = ''
              runHook preInstall

              mkdir -p $out/bin
              mkdir -p $out/share
              cp -r src/kiwi-shell $out/share/

              # Compilation
              ags bundle ${entry} $out/bin/.${pname}-core -d "SRC='$out/share/kiwi-shell'" \
                -d "GEOMETRY_PLUGIN='${hyprland-geometry-events}/lib/kiwi-shell/libgeometry-events.so'"

              # Runtime Dependencies Wrapper
              wrapProgram $out/bin/.${pname}-core \
                --prefix PATH : "${
                  pkgs.lib.makeBinPath [
                    pkgs.awww
                    pkgs.hyprsunset
                    pkgs.brightnessctl
                    pkgs.zenity
                    pkgs.imagemagick
                    pkgs.libpulseaudio
                    pkgs.psmisc
                    pkgs.glib.bin
                  ]
                }" \
                --prefix GI_TYPELIB_PATH : "${app-capture}/lib/girepository-1.0" \
                --prefix GI_TYPELIB_PATH : "${hyprland-shortcuts}/lib/girepository-1.0" \
                --prefix GI_TYPELIB_PATH : "${kiwi-surface}/lib/girepository-1.0" \
                --prefix LD_LIBRARY_PATH : "${app-capture}/lib" \
                --prefix LD_LIBRARY_PATH : "${hyprland-shortcuts}/lib" \
                --prefix LD_LIBRARY_PATH : "${kiwi-surface}/lib"

              # Start Wrapper: argv/instance guards, log rotation, capped tee to the log
              cat << 'EOF' > $out/bin/${pname}
              #!/usr/bin/env bash
              if [ "$#" -gt 0 ]; then
                echo "kiwi takes no arguments — use kiwictl to control the shell (kiwictl --help)" >&2
                exit 2
              fi
              if GDBUS_PLACEHOLDER call --session --dest org.freedesktop.DBus \
                  --object-path /org/freedesktop/DBus \
                  --method org.freedesktop.DBus.NameHasOwner io.Astal.ags 2>/dev/null | grep -q true; then
                echo "kiwi-shell is already running — use kiwictl to control it" >&2
                exit 1
              fi
              LOG_FILE="$HOME/.cache/kiwi-shell.log"
              mkdir -p "$(dirname "$LOG_FILE")"
              [ -f "$LOG_FILE" ] && mv -f "$LOG_FILE" "$LOG_FILE.old"
              # like tee, but once the log reaches 5 MiB it moves to .old and
              # starts over, so a long session can't grow it without bound
              export KIWI_LOG_FILE="$LOG_FILE"
              BIN_PATH_PLACEHOLDER 2>&1 | LC_ALL=C AWK_PLACEHOLDER -v max=$((5 * 1024 * 1024)) '
                {
                  print; fflush()
                  print > ENVIRON["KIWI_LOG_FILE"]; fflush(ENVIRON["KIWI_LOG_FILE"])
                  size += length($0) + 1
                  if (size >= max) {
                    close(ENVIRON["KIWI_LOG_FILE"])
                    system("mv -f -- \"$KIWI_LOG_FILE\" \"$KIWI_LOG_FILE.old\"")
                    size = 0
                  }
                }'
              EOF

              sed -i "s|BIN_PATH_PLACEHOLDER|$out/bin/.${pname}-core|; s|GDBUS_PLACEHOLDER|${pkgs.glib.bin}/bin/gdbus|; s|AWK_PLACEHOLDER|${pkgs.gawk}/bin/awk|" $out/bin/${pname}
              chmod +x $out/bin/${pname}

              # Controller Script
              echo "#!${pkgs.bash}/bin/bash" > $out/bin/${pname}ctl
              # "--" stops the ags CLI from eating flags like --help meant for
              # the shell's own quarrel-based command parser
              echo "exec ${ags.packages.${system}.default}/bin/ags request -- \"\$@\"" >> $out/bin/${pname}ctl
              chmod +x $out/bin/${pname}ctl

              runHook postInstall
            '';
          };
        in
        {
          shell = kiwi-package;
          inherit
            app-capture
            hyprland-shortcuts
            kiwi-surface
            hyprland-geometry-events
            extraPackages
            ;
          settings = kiwi-settings.packages.${system}.default;

          default = pkgs.symlinkJoin {
            name = "kiwi";
            paths = [
              kiwi-package
              kiwi-settings.packages.${system}.default
            ];
          };
        };

      pkgs = nixpkgs.legacyPackages.${system};
      # for a session running nixpkgs' own Hyprland
      standalone = kiwiFor pkgs pkgs.hyprland;
    in
    {
      packages.${system} = builtins.removeAttrs standalone [ "extraPackages" ];

      # kiwi-shell built against the Hyprland of the nixpkgs it is applied to,
      # including one an overlay replaced
      overlays.default = final: prev: {
        kiwi-shell = (kiwiFor final final.hyprland).default;
      };

      # ─── Dev shell ───────────────────────────────────────────────────────────
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [
          (ags.packages.${system}.default.override {
            inherit (standalone) extraPackages;
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
          pkgs.brightnessctl
          pkgs.awww
        ];
      };

      homeManagerModules.default =
        {
          config,
          lib,
          pkgs,
          osConfig ? null,
          ...
        }:
        let
          cfg = config.services.kiwi-shell;

          # the Hyprland this session runs: the system's, else home-manager's
          sessionHyprland =
            if osConfig != null && (osConfig.programs.hyprland.enable or false) then
              osConfig.programs.hyprland.package
            else if (config.wayland.windowManager.hyprland.package or null) != null then
              config.wayland.windowManager.hyprland.package
            else
              pkgs.hyprland;

          defaultConfig = builtins.fromJSON (builtins.readFile ./src/kiwi-shell/defaultConfig.json);

          inferType =
            v:
            if builtins.isBool v then
              lib.types.bool
            else if builtins.isInt v then
              lib.types.int
            else if builtins.isFloat v then
              lib.types.float
            else if builtins.isList v then
              lib.types.listOf lib.types.str
            else
              lib.types.str;

          settingsOptions = builtins.mapAttrs (
            _: val:
            lib.mkOption {
              type = lib.types.nullOr (inferType val);
              default = val;
            }
          ) defaultConfig;
        in
        {
          options.services.kiwi-shell = {
            enable = lib.mkEnableOption "Kiwi Shell for Hyprland";

            package = lib.mkOption {
              type = lib.types.package;
              default = (kiwiFor pkgs sessionHyprland).default;
              defaultText = lib.literalMD "kiwi-shell built against the session's Hyprland";
              description = "Kiwi Shell, with its Hyprland plugin built against the Hyprland it runs under.";
            };

            settings = lib.mkOption {
              description = "Deterministic settings for Kiwi Shell. Defaults are read from defaultConfig.json at build time.";
              default = null;
              type = lib.types.nullOr (
                lib.types.submodule {
                  options = settingsOptions // {
                    dock_apps = lib.mkOption {
                      type = lib.types.nullOr (lib.types.listOf lib.types.str);
                      default = null;
                      description = "List of .desktop app IDs to pin to the dock";
                    };
                  };
                }
              );
            };
          };

          config = lib.mkIf cfg.enable {
            xdg.configFile."kiwi-shell/nix-config.json" = lib.mkIf (cfg.settings != null) {
              text = builtins.toJSON (lib.filterAttrs (_: v: v != null) cfg.settings);
            };
            home.packages = [ cfg.package ];
          };
        };
    };
}
