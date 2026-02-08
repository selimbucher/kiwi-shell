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
        pkgs.zenity
        pkgs.sox

        # --- Fonts ---
        pkgs.quicksand

        # --- Themes & Icons ---
        (pkgs.whitesur-gtk-theme.override {
          altVariants = [ "normal" ];
        })

        (pkgs.whitesur-icon-theme.override {
          alternativeIcons = true;
          boldPanelIcons = true;
        })
      ];
  in {
    packages.${system} = {
      default = pkgs.stdenv.mkDerivation {
        name = pname;
        version = 0.1;
        src = pkgs.lib.cleanSource ./.;

        nativeBuildInputs = with pkgs; [
          wrapGAppsHook4
          gobject-introspection
          ags.packages.${system}.default
        ];

        buildInputs = extraPackages ++ [pkgs.gjs];

        installPhase = ''
          runHook preInstall

          mkdir -p $out/bin
          mkdir -p $out/share
          cp -r * $out/share

          # --- Step 1: Create the Main App ('desktop') ---
          # This compiles your app.ts into a fast, standalone binary
          ags bundle ${entry} $out/bin/${pname} -d "SRC='$out/share'"

          # --- Step 2: Create the Controller ('desktop-ctl') ---
          # This creates a script that runs 'ags request' using the exact AGS version from the flake
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
