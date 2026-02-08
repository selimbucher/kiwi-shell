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
    version = "0.1"; # Changed to string for safety
    src = pkgs.lib.cleanSource ./.;

    # 1. Tools needed during the BUILD process
    nativeBuildInputs = with pkgs; [
      wrapGAppsHook4
      gobject-introspection
      ags.packages.${system}.default
      makeWrapper
    ];

    # 2. Libraries needed by the App itself
    buildInputs = extraPackages ++ [ pkgs.gjs ];

    installPhase = ''
      runHook preInstall

      mkdir -p $out/bin
      mkdir -p $out/share
      cp -r * $out/share

      # --- Step A: Compile the Main App ---
      ags bundle ${entry} $out/bin/${pname} -d "SRC='$out/share'"

      # --- Step B: Define Runtime Dependencies ---
      # This list adds these tools to the app's internal "PATH"
      # The user does NOT need to install these globally!
      runtimeDeps = pkgs.lib.makeBinPath [
        pkgs.swww           # Wallpaper daemon
        pkgs.hyprsunset     # Blue light filter
        pkgs.brightnessctl  # For brightness control (optional but good)
      ];

      # --- Step C: Wrap the App ---
      # We wrap the binary so it can see the tools in 'runtimeDeps'
      wrapProgram $out/bin/${pname} \
        --prefix PATH : "$runtimeDeps"

      # --- Step D: Create the Controller Script ---
      # This helper script allows 'desktop-ctl request ...'
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
