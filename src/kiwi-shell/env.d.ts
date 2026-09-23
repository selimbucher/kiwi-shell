declare const SRC: string
// where the build put kiwi's Hyprland plugin (src/hyprland-plugin);
// left undefined by a build that doesn't ship it
declare const PLUGIN: string | undefined

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
