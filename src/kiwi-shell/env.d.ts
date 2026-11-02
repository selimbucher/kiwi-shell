declare const SRC: string
// where the build put kiwi's Hyprland plugin (src/hyprland-plugin);
// left undefined by a build that doesn't ship it
declare const PLUGIN: string | undefined
// the Quicksand font file the build ships, for where it isn't installed;
// left undefined by a build that doesn't
declare const QUICKSAND: string | undefined

declare module "inline:*" {
  const content: string
  export default content
}

declare module "*.scss" {
  const content: string
  export default content
}

declare module "*.blp" {
  const content: string
  export default content
}

declare module "*.css" {
  const content: string
  export default content
}

// Evolution Data Server, loaded when a calendar widget is there
// (widgets/services/calendar.ts); no types are generated for it
declare module "gi://EDataServer?version=1.2" { const lib: any; export default lib }
declare module "gi://ECal?version=2.0" { const lib: any; export default lib }
declare module "gi://ICalGLib?version=3.0" { const lib: any; export default lib }
