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

          # ─── kiwi's Hyprland plugin ───────────────────────────────────────
          # Window moves and resizes on the event socket, which Hyprland
          # doesn't announce and the dock's auto-hide follows, and the
          # switchers' tiles drawn from the windows themselves rather than
          # captured. See src/hyprland-plugin/kiwi.hpp.
          kiwi-plugin = pkgs.hyprlandPlugins.mkHyprlandPlugin {
            hyprland = hyprlandPackage;
            pluginName = "kiwi";
            version = "0.2.0";

            src = ./src/hyprland-plugin;

            nativeBuildInputs = with pkgs; [
              meson
              ninja
            ];

            meta = {
              description = "Hyprland plugin: what kiwi-shell needs from inside the compositor";
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
            # the position asked of a player only while shown (poll-position:
            # the island's card), not every second as long as it's there
            (mpris.overrideAttrs (old: {
              patches = (old.patches or [ ]) ++ [ ./patches/astal-mpris-poll-position.patch ];
            }))
            powerprofiles
            bluetooth
            tray
            apps
            notifd
            # the island's Now Playing bars follow the music (sources/media.tsx)
            cava
          ];

          extraPackages = astalPackages ++ [
            pkgs.libadwaita
            pkgs.libsoup_3
            # TLS for libsoup (the island's weather fetches over https)
            pkgs.glib-networking
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

              # the plugin, linked into the package: the bundle below is
              # compressed, so a path in it isn't seen as a dependency, and
              # the plugin would be garbage-collected from under the shell
              mkdir -p $out/lib/kiwi-shell
              ln -s ${kiwi-plugin}/lib/kiwi-shell/libkiwi.so $out/lib/kiwi-shell/libkiwi.so
              # and the shell's font, for where it isn't installed (loaded by
              # the shell alone, services/font.ts): not in share/fonts, where
              # a profile would install it for everything
              ln -s "${pkgs.quicksand}/share/fonts/truetype/Quicksand[wght].ttf" $out/lib/kiwi-shell/Quicksand.ttf

              # Compilation
              ags bundle ${entry} $out/bin/.${pname}-core -d "SRC='$out/share/kiwi-shell'" \
                -d "PLUGIN='$out/lib/kiwi-shell/libkiwi.so'" \
                -d "QUICKSAND='$out/lib/kiwi-shell/Quicksand.ttf'"

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
                    pkgs.inotify-tools
                  ]
                }" \
                --prefix GI_TYPELIB_PATH : "${app-capture}/lib/girepository-1.0" \
                --prefix GI_TYPELIB_PATH : "${hyprland-shortcuts}/lib/girepository-1.0" \
                --prefix GI_TYPELIB_PATH : "${kiwi-surface}/lib/girepository-1.0" \
                --prefix LD_LIBRARY_PATH : "${app-capture}/lib" \
                --prefix LD_LIBRARY_PATH : "${hyprland-shortcuts}/lib" \
                --prefix LD_LIBRARY_PATH : "${kiwi-surface}/lib" \
                --set GIO_USE_VFS local
                # (no gvfs: its web downloader can hang for good, and with it
                # every media player AstalMpris would list; services/covers.ts)

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
            kiwi-plugin
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

          # an option per setting, and for a group of them ("shortcuts") an
          # option per setting in it. Unset, a setting is left to Kiwi
          # Settings: only what is set here is written, and it is laid over
          # the user's own settings rather than replacing them all. A
          # shortcut is one key combo or a list of them.
          optionsFor =
            group:
            builtins.mapAttrs (
              name: val:
              if builtins.isAttrs val then
                lib.mkOption {
                  type = lib.types.submodule { options = optionsFor name val; };
                  default = { };
                }
              else
                lib.mkOption {
                  type = lib.types.nullOr (
                    if group == "shortcuts" then lib.types.either lib.types.str (lib.types.listOf lib.types.str) else inferType val
                  );
                  default = null;
                  description = "Unset: as chosen in Kiwi Settings (by default ${builtins.toJSON val}).";
                }
            );

          # the settings set, groups included, without the unset ones
          setOnly =
            attrs:
            lib.filterAttrs (_: v: v != null && v != { }) (
              builtins.mapAttrs (_: v: if builtins.isAttrs v then setOnly v else v) attrs
            );

          settingsOptions = optionsFor null defaultConfig;
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
              text = builtins.toJSON (setOnly cfg.settings);
            };
            home.packages = [ cfg.package ];
          };
        };
    };
}
