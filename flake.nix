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
          ags bundle ${entry} $out/bin/${pname} -d "SRC='$out/share'"

          # --- Step 2: Wrap the App ---
          wrapProgram $out/bin/${pname} \
            --prefix PATH : "${pkgs.lib.makeBinPath [
              pkgs.swww
              pkgs.hyprsunset
              pkgs.brightnessctl
              pkgs.zenity
              pkgs.imagemagick
              pkgs.sox
              pkgs.psmisc
            ]}"

          # --- Step 3: Create the Controller Script ---
          echo "#!${pkgs.bash}/bin/bash" > $out/bin/${pname}-ctl
          echo "exec ${ags.packages.${system}.default}/bin/ags request \"\$@\" >> ~/.cache/hyprland-desktop.log 2>&1" >> $out/bin/${pname}-ctl
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
